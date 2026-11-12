/**
 * Step-up policy (contract §4/§8, eccos-eyel): sensitive actions need TOTP
 * enrolled and a second factor proved inside the 15-minute window, on the
 * Eccos server functions (`requireStepUp`) and inside Better Auth
 * (`stepUpGuard`). Freshness is `session.stepUpAt`, never the session's age.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/auth/auth";
import { CaptureMailSender } from "../src/auth/mail";
import { requireStepUp, STEP_UP_WINDOW_SECONDS, stepUpRefusal } from "../src/auth/step-up";
import { confirmStepUp } from "../src/auth/step-up-confirm";
import { STEP_UP_ACCOUNT_PATHS } from "../src/auth/step-up-guard";
import { ForbiddenError } from "../src/auth/tenant";
import { enrollTotp } from "./helpers/step-up";

const BASE_URL = "http://localhost:3000";
const PASSWORD = "correct-horse-battery";
const EMAIL = "owner@corp.test";

type Post = (path: string, body: unknown, cookie?: string) => Promise<Response>;

async function testAuth() {
  const db = new Database(":memory:");
  const mail = new CaptureMailSender();
  const auth = createAuth({
    database: db,
    secret: "test-secret-32-chars-minimum-length!!",
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    mail,
  });
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  const post: Post = (path, body, cookie) =>
    auth.handler(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
  return { auth, db, mail, post };
}

/** The cookies a response sets, minus the ones it clears. */
function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

async function signedIn(email = EMAIL) {
  const ctx = await testAuth();
  await ctx.post("/sign-up/email", { email, password: PASSWORD, name: "Owner" });
  ctx.db.query('UPDATE user SET "emailVerified" = 1').run();
  const cookie = cookiesOf(await ctx.post("/sign-in/email", { email, password: PASSWORD }));
  return { ...ctx, cookie, headers: () => new Headers({ cookie }) };
}

/** The raw secret behind an `otpauth://` URI, which carries it base32-encoded. */
function rawSecret(totpURI: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of new URL(totpURI).searchParams.get("secret")!.replace(/=+$/, "")) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const bytes = bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** A user enrolled through the real endpoints, holding the session enrollment minted. */
async function enrolled() {
  const ctx = await signedIn();
  const enable = await ctx.post("/two-factor/enable", { password: PASSWORD }, ctx.cookie);
  const secret = rawSecret(((await enable.json()) as { totpURI: string }).totpURI);
  const code = async () => (await ctx.auth.api.generateTOTP({ body: { secret } })).code;
  const verify = await ctx.post("/two-factor/verify-totp", { code: await code() }, ctx.cookie);
  expect(verify.status).toBe(200);
  const cookie = cookiesOf(verify);
  return { ...ctx, cookie, code, headers: () => new Headers({ cookie }) };
}

/**
 * What a thief holds some time after the theft: the same session, long past
 * its step-up window. The session itself is made brand new, so nothing here
 * can pass by reading its age.
 */
function goStale(db: Database): void {
  const stale = new Date(Date.now() - (STEP_UP_WINDOW_SECONDS + 60) * 1000).toISOString();
  db.query('UPDATE session SET "stepUpAt" = ?, "createdAt" = ?').run(stale, new Date().toISOString());
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return err instanceof ForbiddenError ? err.reason : `not refused: ${String(err)}`;
}

async function refusal(response: Response): Promise<[number, string | undefined]> {
  return [response.status, ((await response.json()) as { code?: string }).code];
}

const STALE = [403, "SESSION_NOT_FRESH"] as const;

describe("stepUpRefusal", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  const at = (secondsAgo: number) => ({ stepUpAt: new Date(now - secondsAgo * 1000) });
  const user = { twoFactorEnabled: true };

  test("no TOTP is refused before freshness is even looked at", () => {
    expect(stepUpRefusal({ user: {}, session: at(0) }, now)).toBe("totp-required");
    expect(stepUpRefusal({ user: { twoFactorEnabled: false }, session: at(0) }, now)).toBe("totp-required");
  });

  test("the window is 15 minutes, exclusive at the edge", () => {
    expect(stepUpRefusal({ user, session: at(STEP_UP_WINDOW_SECONDS - 1) }, now)).toBeNull();
    expect(stepUpRefusal({ user, session: at(STEP_UP_WINDOW_SECONDS) }, now)).toBe("reauth-required");
  });

  test("the stamp is read as stored, as a string too", () => {
    expect(stepUpRefusal({ user, session: { stepUpAt: new Date(now - 1000).toISOString() } }, now)).toBeNull();
  });

  test("a session's age is not freshness: a brand-new one that never proved a factor fails closed", () => {
    expect(stepUpRefusal({ user, session: { createdAt: new Date(now) } }, now)).toBe("reauth-required");
    expect(stepUpRefusal({ user, session: { createdAt: new Date(now), stepUpAt: null } }, now)).toBe("reauth-required");
    expect(stepUpRefusal({ user, session: { stepUpAt: "not a date" } }, now)).toBe("reauth-required");
    expect(stepUpRefusal({ user }, now)).toBe("reauth-required");
  });
});

describe("requireStepUp", () => {
  test("a session without TOTP is told to enroll", async () => {
    const { auth, headers } = await signedIn();
    expect(await reasonOf(requireStepUp(auth, headers()))).toBe("totp-required");
  });

  test("no session is unauthenticated, not a step-up prompt", async () => {
    const { auth } = await signedIn();
    await expect(requireStepUp(auth, new Headers())).rejects.toThrow("authentication required");
  });

  test("verifying the first code enrolls and leaves a stepped-up session", async () => {
    const { auth, headers } = await enrolled();
    await requireStepUp(auth, headers());
  });

  test("an enrolled user's password alone opens no session; the code does, and it is stepped up", async () => {
    const { auth, db, post, code } = await enrolled();
    goStale(db);

    const signIn = await post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    expect(((await signIn.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    const challenge = cookiesOf(signIn);
    expect(challenge).not.toContain("session_token");

    const verify = await post("/two-factor/verify-totp", { code: await code() }, challenge);
    expect(verify.status).toBe(200);
    await requireStepUp(auth, new Headers({ cookie: cookiesOf(verify) }));
  });

  test("a backup code at sign-in steps up as well", async () => {
    const ctx = await signedIn();
    const enable = await ctx.post("/two-factor/enable", { password: PASSWORD }, ctx.cookie);
    const { totpURI, backupCodes } = (await enable.json()) as { totpURI: string; backupCodes: string[] };
    const { code } = await ctx.auth.api.generateTOTP({ body: { secret: rawSecret(totpURI) } });
    await ctx.post("/two-factor/verify-totp", { code }, ctx.cookie);

    const signIn = await ctx.post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    const verify = await ctx.post("/two-factor/verify-backup-code", { code: backupCodes[0] }, cookiesOf(signIn));
    expect(verify.status).toBe(200);
    await requireStepUp(ctx.auth, new Headers({ cookie: cookiesOf(verify) }));
  });
});

/**
 * The attacker of the review: a stolen session cookie, long stale, plus the
 * victim's password. They do not have the authenticator.
 */
describe("attack: a stale stolen cookie plus the password", () => {
  test("cannot mint a fresh session by changing the password", async () => {
    const { auth, db, post, cookie } = await enrolled();
    goStale(db);

    const change = await post(
      "/change-password",
      { currentPassword: PASSWORD, newPassword: "attacker-chosen-password", revokeOtherSessions: true },
      cookie,
    );
    expect(await refusal(change)).toEqual([...STALE]);
    // No new session came back, the stolen one is still stale, the password still works.
    expect(cookiesOf(change)).not.toContain("session_token");
    expect(await reasonOf(requireStepUp(auth, new Headers({ cookie })))).toBe("reauth-required");
    const signIn = await post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    expect(signIn.status).toBe(200);
  });

  test("cannot disable TOTP, read its secret, mint backup codes or enroll their own authenticator", async () => {
    const { auth, db, post, cookie } = await enrolled();
    goStale(db);
    const factor = () => db.query('SELECT secret, "backupCodes", verified FROM "twoFactor"').all();
    const before = factor();

    for (const path of [
      "/two-factor/disable",
      "/two-factor/get-totp-uri",
      "/two-factor/generate-backup-codes",
      "/two-factor/enable",
    ]) {
      expect([path, ...(await refusal(await post(path, { password: PASSWORD }, cookie)))]).toEqual([path, ...STALE]);
    }

    expect(factor()).toEqual(before);
    expect(db.query('SELECT "twoFactorEnabled" AS enabled FROM user').get()).toEqual({ enabled: 1 });
    expect(await reasonOf(requireStepUp(auth, new Headers({ cookie })))).toBe("reauth-required");
  });

  test("cannot use Better Auth's own verify endpoints as an unlimited oracle for codes", async () => {
    const { auth, db, post, cookie, code } = await enrolled();
    goStale(db);
    // Refused even with the RIGHT code: on an existing session those endpoints
    // count no wrong guesses, so the only way to step up is the limited one.
    for (const [path, body] of [
      ["/two-factor/verify-totp", { code: await code() }],
      ["/two-factor/verify-backup-code", { code: "aaaaa-bbbbb" }],
    ] as const) {
      expect([path, ...(await refusal(await post(path, body, cookie)))]).toEqual([path, 403, "USE_STEP_UP"]);
    }
    expect(await reasonOf(requireStepUp(auth, new Headers({ cookie })))).toBe("reauth-required");
  });

  test("cannot guess the code: wrong attempts spend the account lockout, and parallel guesses all count", async () => {
    const { auth, db, post, cookie, code } = await enrolled();
    goStale(db);
    const attempt = (value: string) => confirmStepUp(auth, new Headers({ cookie }), { code: value });
    const budget = () =>
      db.query('SELECT "failedVerificationCount" AS failed, "lockedUntil" AS locked FROM "twoFactor"').get() as {
        failed: number | null;
        locked: string | null;
      };

    // Ten at once: a read-check-write counter would count them as one.
    const guesses = await Promise.all(Array.from({ length: 10 }, () => attempt("000000")));
    expect(guesses).toEqual(Array.from({ length: 10 }, () => ({ ok: false, code: "invalid" })));
    expect(budget().failed).toBe(10);
    expect(budget().locked).not.toBeNull();

    // Locked for the account: the right code here, and the sign-in challenge too.
    expect(await attempt(await code())).toEqual({ ok: false, code: "locked" });
    expect(await reasonOf(requireStepUp(auth, new Headers({ cookie })))).toBe("reauth-required");
    const signIn = await post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    const challenge = await post("/two-factor/verify-totp", { code: await code() }, cookiesOf(signIn));
    expect(await refusal(challenge)).toEqual([429, "ACCOUNT_TEMPORARILY_LOCKED"]);

    // Once the lock has run out, the right code works and clears the count.
    db.query('UPDATE "twoFactor" SET "lockedUntil" = ?').run(new Date(Date.now() - 1000).toISOString());
    expect(await attempt(await code())).toEqual({ ok: true });
    expect(budget()).toEqual({ failed: 0, locked: null });
  });

  test("a failure that is not a verdict on the code is thrown, and spends no attempt", async () => {
    const { auth, db, cookie } = await enrolled();
    goStale(db);
    // An unreadable secret: Better Auth fails to decrypt it, which says nothing about the guess.
    db.query('UPDATE "twoFactor" SET secret = ?').run("not-a-ciphertext");
    await expect(confirmStepUp(auth, new Headers({ cookie }), { code: "000000" })).rejects.toThrow();
    expect(db.query('SELECT "failedVerificationCount" AS failed FROM "twoFactor"').get()).toEqual({ failed: 0 });
  });

  test("every guarded account path is a real endpoint", async () => {
    const { auth } = await testAuth();
    const endpoints = new Set(Object.values(auth.api).map((e) => (e as { path?: string }).path));
    for (const path of STEP_UP_ACCOUNT_PATHS) {
      expect([path, endpoints.has(path)]).toEqual([path, true]);
    }
  });
});

describe("the step-up challenge on the current session", () => {
  test("a right code stamps this session and changes nothing else about it", async () => {
    const { auth, db, cookie, code, headers } = await enrolled();
    const org = (await auth.api.createOrganization({
      body: { name: "Acme", slug: crypto.randomUUID() },
      headers: headers(),
    })) as { id: string };
    await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers: headers() });
    goStale(db);
    const row = () =>
      db.query('SELECT id, token, "activeOrganizationId" AS org, "expiresAt" FROM session').all();
    const before = row();
    expect(before).toHaveLength(1);
    expect(await reasonOf(requireStepUp(auth, new Headers({ cookie })))).toBe("reauth-required");

    expect(await confirmStepUp(auth, new Headers({ cookie }), { code: await code() })).toEqual({ ok: true });

    // Same row, same token, same active organization; the same cookie now passes.
    expect(row()).toEqual(before);
    expect((before[0] as { org: string }).org).toBe(org.id);
    await requireStepUp(auth, new Headers({ cookie }));
  });

  test("a backup code steps up too, and is spent", async () => {
    const ctx = await signedIn();
    const enable = await ctx.post("/two-factor/enable", { password: PASSWORD }, ctx.cookie);
    const { totpURI, backupCodes } = (await enable.json()) as { totpURI: string; backupCodes: string[] };
    const { code } = await ctx.auth.api.generateTOTP({ body: { secret: rawSecret(totpURI) } });
    const cookie = cookiesOf(await ctx.post("/two-factor/verify-totp", { code }, ctx.cookie));
    goStale(ctx.db);
    const spend = () =>
      confirmStepUp(ctx.auth, new Headers({ cookie }), { code: backupCodes[0]!, backup: true });

    expect(await spend()).toEqual({ ok: true });
    goStale(ctx.db);
    expect(await spend()).toEqual({ ok: false, code: "invalid" });
  });

  test("no session has nothing to confirm", async () => {
    const { auth } = await signedIn();
    expect(await confirmStepUp(auth, new Headers(), { code: "000000" })).toEqual({ ok: false, code: "signed-out" });
  });

  test("an account that is not fully enrolled is refused before any code is checked", async () => {
    const { auth, db, post, cookie } = await signedIn();
    const sessions = () => db.query("SELECT id, token FROM session").all();
    const confirm = (code: string) => confirmStepUp(auth, new Headers({ cookie }), { code });

    expect(await confirm("000000")).toEqual({ ok: false, code: "not-enrolled" });

    // A PENDING enrollment: the right code here must not run Better Auth's
    // enrollment branch, which would replace the session behind the caller.
    const enable = await post("/two-factor/enable", { password: PASSWORD }, cookie);
    const secret = rawSecret(((await enable.json()) as { totpURI: string }).totpURI);
    const before = sessions();
    const { code } = await auth.api.generateTOTP({ body: { secret } });
    expect(await confirm(code)).toEqual({ ok: false, code: "not-enrolled" });
    expect(sessions()).toEqual(before);
    expect(db.query('SELECT verified FROM "twoFactor"').get()).toEqual({ verified: 0 });
    expect(db.query('SELECT "twoFactorEnabled" AS enabled FROM user').get()).toEqual({ enabled: 0 });
  });
});

describe("sessions minted without a second factor", () => {
  test("the email-verification link signs in, and that session never passes step-up", async () => {
    const { auth, db, mail, post } = await testAuth();
    await post("/sign-up/email", { email: EMAIL, password: PASSWORD, name: "Owner", callbackURL: "/" });
    const link = new URL(mail.sent.at(-1)!.variables.url!);
    const verified = await auth.handler(new Request(link, { headers: { origin: BASE_URL } }));
    const cookie = cookiesOf(verified);
    expect(cookie).toContain("session_token");

    const headers = new Headers({ cookie });
    expect(await reasonOf(requireStepUp(auth, headers))).toBe("totp-required");
    // Enrolled or not, a session that never proved a factor is not stepped up.
    db.query('UPDATE user SET "twoFactorEnabled" = 1').run();
    expect(await reasonOf(requireStepUp(auth, new Headers({ cookie })))).toBe("reauth-required");
  });

  test("an account with no second factor can still change its password and enroll", async () => {
    const { post, cookie } = await signedIn();
    const change = await post(
      "/change-password",
      { currentPassword: PASSWORD, newPassword: "a-new-long-password" },
      cookie,
    );
    expect(change.status).toBe(200);
    expect((await post("/two-factor/enable", { password: "a-new-long-password" }, cookie)).status).toBe(200);
  });
});

describe("Better Auth organization endpoints (invitations, role changes)", () => {
  async function withOrganization() {
    const ctx = await signedIn();
    const org = (await ctx.auth.api.createOrganization({
      body: { name: "Acme", slug: crypto.randomUUID() },
      headers: ctx.headers(),
    })) as { id: string };
    const invite = (cookie = ctx.cookie, email = "invitee@corp.test") =>
      ctx.post("/organization/invite-member", { email, role: "viewer", organizationId: org.id }, cookie);
    return { ...ctx, org, invite };
  }
  const invitations = (db: Database) => db.query("SELECT COUNT(*) AS n FROM invitation").get();

  test("an invitation is refused without TOTP, then with a stale step-up, then sent", async () => {
    const { db, invite } = await withOrganization();
    expect(await refusal(await invite())).toEqual([403, "TOTP_REQUIRED"]);

    enrollTotp(db, EMAIL);
    goStale(db);
    expect(await refusal(await invite())).toEqual([...STALE]);
    expect(invitations(db)).toEqual({ n: 0 });

    enrollTotp(db, EMAIL);
    expect((await invite()).status).toBe(200);
    expect(invitations(db)).toEqual({ n: 1 });
  });

  test("a role that may not invite gets the permission error, not a prompt to enroll", async () => {
    const { auth, db, post, org, invite } = await withOrganization();
    enrollTotp(db, EMAIL);
    const invitation = (await (await invite(undefined, "viewer@corp.test")).json()) as { id: string };
    await post("/sign-up/email", { email: "viewer@corp.test", password: PASSWORD, name: "Viewer" });
    db.query('UPDATE user SET "emailVerified" = 1').run();
    const viewer = cookiesOf(await post("/sign-in/email", { email: "viewer@corp.test", password: PASSWORD }));
    await auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: new Headers({ cookie: viewer }) });

    // The viewer has no TOTP and no step-up; neither is what stops them.
    for (const [path, body] of [
      ["/organization/invite-member", { email: "x@corp.test", role: "viewer", organizationId: org.id }],
      ["/organization/cancel-invitation", { invitationId: invitation.id }],
      ["/organization/update-member-role", { memberId: "any", role: "admin", organizationId: org.id }],
      ["/organization/remove-member", { memberIdOrEmail: EMAIL, organizationId: org.id }],
    ] as const) {
      const [status, code] = await refusal(await post(path, body, viewer));
      expect([path, status >= 400, code === "TOTP_REQUIRED" || code === "SESSION_NOT_FRESH"]).toEqual([
        path,
        true,
        false,
      ]);
    }
  });

  test("an empty organizationId falls through to the active one, as Better Auth reads it", async () => {
    const { auth, db, post, org, cookie, headers } = await withOrganization();
    await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers: headers() });
    enrollTotp(db, EMAIL);
    goStale(db);
    const body = { email: "x@corp.test", role: "viewer", organizationId: "" };
    expect(await refusal(await post("/organization/invite-member", body, cookie))).toEqual([...STALE]);
    expect(invitations(db)).toEqual({ n: 0 });
  });

  test("an organization that cannot be resolved is refused, and nothing acts", async () => {
    const { db, post, cookie } = await withOrganization();
    enrollTotp(db, EMAIL);
    goStale(db);
    db.query('UPDATE session SET "activeOrganizationId" = NULL').run();
    const members = () => db.query("SELECT id, role FROM member").all();
    const before = members();
    for (const [path, body] of [
      ["/organization/invite-member", { email: "x@corp.test", role: "viewer" }],
      ["/organization/update-member-role", { memberId: "any", role: "admin" }],
      ["/organization/remove-member", { memberIdOrEmail: EMAIL }],
      ["/organization/cancel-invitation", { invitationId: "no-such-invitation" }],
    ] as const) {
      const [status] = await refusal(await post(path, body, cookie));
      expect([path, status >= 400]).toEqual([path, true]);
    }
    expect(invitations(db)).toEqual({ n: 0 });
    expect(members()).toEqual(before);
  });

  test("role changes and removals in the caller's own organization need step-up", async () => {
    const { auth, db, post, org, invite, cookie, headers } = await withOrganization();
    await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers: headers() });
    enrollTotp(db, EMAIL);
    const invitation = (await (await invite(undefined, "member@corp.test")).json()) as { id: string };
    await post("/sign-up/email", { email: "member@corp.test", password: PASSWORD, name: "Member" });
    db.query('UPDATE user SET "emailVerified" = 1').run();
    const member = cookiesOf(await post("/sign-in/email", { email: "member@corp.test", password: PASSWORD }));
    await auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: new Headers({ cookie: member }) });
    const row = () =>
      db.query("SELECT m.id, m.role FROM member m JOIN user u ON u.id = m.userId WHERE u.email = ?").get(
        "member@corp.test",
      ) as { id: string; role: string };
    const before = row();

    goStale(db);
    for (const [path, body] of [
      ["/organization/update-member-role", { memberId: before.id, role: "admin" }],
      ["/organization/remove-member", { memberIdOrEmail: "member@corp.test" }],
    ] as const) {
      expect([path, ...(await refusal(await post(path, body, cookie)))]).toEqual([path, ...STALE]);
    }
    expect(row()).toEqual(before);
  });

  test("cancelling is judged on the invitation's organization, not the active one", async () => {
    // The owner of Acme is only a viewer in Globex, and Globex is their active organization.
    const { auth, db, post, org, invite, cookie, headers } = await withOrganization();
    enrollTotp(db, EMAIL);
    const pending = (await (await invite()).json()) as { id: string };

    await post("/sign-up/email", { email: "other@corp.test", password: PASSWORD, name: "Other" });
    db.query('UPDATE user SET "emailVerified" = 1').run();
    const other = cookiesOf(await post("/sign-in/email", { email: "other@corp.test", password: PASSWORD }));
    enrollTotp(db, "other@corp.test");
    const globex = (await auth.api.createOrganization({
      body: { name: "Globex", slug: crypto.randomUUID() },
      headers: new Headers({ cookie: other }),
    })) as { id: string };
    const asViewer = (await auth.api.createInvitation({
      body: { email: EMAIL, role: "viewer", organizationId: globex.id },
      headers: new Headers({ cookie: other }),
    })) as { id: string };
    await auth.api.acceptInvitation({ body: { invitationId: asViewer.id }, headers: headers() });
    await auth.api.setActiveOrganization({ body: { organizationId: globex.id }, headers: headers() });

    goStale(db);
    for (const active of [globex.id, null]) {
      db.query('UPDATE session SET "activeOrganizationId" = ? WHERE token LIKE ?').run(
        active,
        `${decodeURIComponent(cookie.split("=")[1]!).split(".")[0]}%`,
      );
      const cancel = await post("/organization/cancel-invitation", { invitationId: pending.id }, cookie);
      expect([active, ...(await refusal(cancel))]).toEqual([active, ...STALE]);
    }
    expect(db.query("SELECT status FROM invitation WHERE id = ?").get(pending.id)).toEqual({ status: "pending" });
    void org;
  });

  test("an anonymous call still gets the endpoint's own 401", async () => {
    const { post } = await withOrganization();
    const res = await post("/organization/invite-member", { email: "x@corp.test", role: "viewer" });
    expect(res.status).toBe(401);
  });
});
