/**
 * Step-up policy (contract §4/§8, eccos-eyel): sensitive actions need TOTP
 * enrolled and a sign-in inside the 15-minute window, on the Eccos server
 * functions (`requireStepUp`) and on Better Auth's own organization endpoints.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/auth/auth";
import { CaptureMailSender } from "../src/auth/mail";
import { requireStepUp, STEP_UP_WINDOW_SECONDS, stepUpRefusal } from "../src/auth/step-up";
import { STEP_UP_AUTH_PATHS } from "../src/auth/step-up-guard";
import { ForbiddenError } from "../src/auth/tenant";
import { enrollTotp } from "./helpers/step-up";

const BASE_URL = "http://localhost:3000";
const PASSWORD = "correct-horse-battery";
const EMAIL = "owner@corp.test";

async function signedIn() {
  const db = new Database(":memory:");
  const auth = createAuth({
    database: db,
    secret: "test-secret-32-chars-minimum-length!!",
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    mail: new CaptureMailSender(),
  });
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  const post = (path: string, body: unknown, cookie?: string) =>
    auth.handler(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
  await post("/sign-up/email", { email: EMAIL, password: PASSWORD, name: "Owner" });
  db.query('UPDATE user SET "emailVerified" = 1').run();
  const signIn = await post("/sign-in/email", { email: EMAIL, password: PASSWORD });
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
  return { auth, db, post, cookie, headers: () => new Headers({ cookie }) };
}

/** Ages every session past the window, in the column's own storage format. */
function ageSessions(db: Database): void {
  const { createdAt } = db.query('SELECT "createdAt" FROM session').get() as { createdAt: string | number };
  const stale = Date.now() - (STEP_UP_WINDOW_SECONDS + 60) * 1000;
  db.query('UPDATE session SET "createdAt" = ?').run(
    typeof createdAt === "number" ? stale : new Date(stale).toISOString(),
  );
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

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return err instanceof ForbiddenError ? err.reason : `not refused: ${String(err)}`;
}

describe("stepUpRefusal", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  const at = (secondsAgo: number) => ({ createdAt: new Date(now - secondsAgo * 1000) });

  test("no TOTP is refused before freshness is even looked at", () => {
    expect(stepUpRefusal({ user: {}, session: at(0) }, now)).toBe("totp-required");
    expect(stepUpRefusal({ user: { twoFactorEnabled: false }, session: at(0) }, now)).toBe("totp-required");
  });

  test("the window is 15 minutes, exclusive at the edge", () => {
    const user = { twoFactorEnabled: true };
    expect(stepUpRefusal({ user, session: at(STEP_UP_WINDOW_SECONDS - 1) }, now)).toBeNull();
    expect(stepUpRefusal({ user, session: at(STEP_UP_WINDOW_SECONDS) }, now)).toBe("reauth-required");
  });

  test("a session with no readable creation time fails closed", () => {
    const user = { twoFactorEnabled: true };
    expect(stepUpRefusal({ user }, now)).toBe("reauth-required");
    expect(stepUpRefusal({ user, session: { createdAt: "not a date" } }, now)).toBe("reauth-required");
  });
});

describe("requireStepUp", () => {
  test("a session without TOTP is told to enroll", async () => {
    const { auth, headers } = await signedIn();
    expect(await reasonOf(requireStepUp(auth, headers()))).toBe("totp-required");
  });

  test("an enrolled, fresh session passes; the same session past the window does not", async () => {
    const { auth, db, headers } = await signedIn();
    enrollTotp(db, EMAIL);
    await requireStepUp(auth, headers());
    ageSessions(db);
    expect(await reasonOf(requireStepUp(auth, headers()))).toBe("reauth-required");
  });

  test("no session is unauthenticated, not a step-up prompt", async () => {
    const { auth } = await signedIn();
    await expect(requireStepUp(auth, new Headers())).rejects.toThrow("authentication required");
  });
});

describe("enrollment and re-authentication renew step-up", () => {
  test("verifying the first code enrolls and leaves a fresh session", async () => {
    const { auth, db, post, cookie } = await signedIn();
    ageSessions(db);
    const enable = await post("/two-factor/enable", { password: PASSWORD }, cookie);
    const { totpURI } = (await enable.json()) as { totpURI: string };
    const { code } = await auth.api.generateTOTP({ body: { secret: rawSecret(totpURI) } });
    const verify = await post("/two-factor/verify-totp", { code }, cookie);
    expect(verify.status).toBe(200);
    const renewed = verify.headers.get("set-cookie")!.split(";")[0]!;
    await requireStepUp(auth, new Headers({ cookie: renewed }));
  });

  test("an enrolled user's password alone opens no session; the code does, and it is fresh", async () => {
    const { auth, db, post, cookie } = await signedIn();
    const enable = await post("/two-factor/enable", { password: PASSWORD }, cookie);
    const secret = rawSecret(((await enable.json()) as { totpURI: string }).totpURI);
    const first = await auth.api.generateTOTP({ body: { secret } });
    await post("/two-factor/verify-totp", { code: first.code }, cookie);
    ageSessions(db);

    const signIn = await post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    expect(((await signIn.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    const challenge = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .filter((c) => !c.endsWith("="))
      .join("; ");
    expect(challenge).not.toContain("session_token");

    const next = await auth.api.generateTOTP({ body: { secret } });
    const verify = await post("/two-factor/verify-totp", { code: next.code }, challenge);
    expect(verify.status).toBe(200);
    const session = verify.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((c) => c.includes("session_token="))!;
    await requireStepUp(auth, new Headers({ cookie: session }));
  });
});

describe("Better Auth organization endpoints (invitations, role changes)", () => {
  async function withOrganization() {
    const ctx = await signedIn();
    const org = (await ctx.auth.api.createOrganization({
      body: { name: "Acme", slug: crypto.randomUUID() },
      headers: ctx.headers(),
    })) as { id: string };
    const invite = () =>
      ctx.post(
        "/organization/invite-member",
        { email: "invitee@corp.test", role: "viewer", organizationId: org.id },
        ctx.cookie,
      );
    return { ...ctx, invite };
  }

  test("the guarded paths are real endpoints", async () => {
    const { auth } = await signedIn();
    const endpoints = new Set(Object.values(auth.api).map((e) => (e as { path?: string }).path));
    for (const path of STEP_UP_AUTH_PATHS) expect(endpoints.has(path)).toBe(true);
  });

  test("an invitation is refused without TOTP, then with a stale session, then sent", async () => {
    const { db, invite } = await withOrganization();

    const noTotp = await invite();
    expect(noTotp.status).toBe(403);
    expect(((await noTotp.json()) as { code?: string }).code).toBe("TOTP_REQUIRED");

    enrollTotp(db, EMAIL);
    ageSessions(db);
    const stale = await invite();
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { code?: string }).code).toBe("SESSION_NOT_FRESH");
    expect(db.query("SELECT COUNT(*) AS n FROM invitation").get()).toEqual({ n: 0 });
  });

  test("a stepped-up owner invites", async () => {
    const { db, invite } = await withOrganization();
    enrollTotp(db, EMAIL);
    expect((await invite()).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS n FROM invitation").get()).toEqual({ n: 1 });
  });

  test("an anonymous call still gets the endpoint's own 401", async () => {
    const { post } = await withOrganization();
    const res = await post("/organization/invite-member", { email: "x@corp.test", role: "viewer" });
    expect(res.status).toBe(401);
  });
});
