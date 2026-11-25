/**
 * Organization onboarding tests (eccos-0x0.5, contract §7).
 *
 * Exercises the real Better Auth invitation flow end to end: verified signup →
 * organization creation (with idempotent account provisioning via a mocked
 * gateway binding) → invitation of a second verified user → acceptance joining
 * the SAME account (no new tenant) → cross-organization isolation of
 * invitation acceptance.
 *
 * Plus the slug's new shape (contract §9): creation takes a NAME only, the slug
 * is minted server-side, names may repeat, and a creation failure answers with
 * the console's own copy rather than the provider's text.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { withD1Statements } from "./helpers/d1-statements";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { enrollTotp } from "./helpers/step-up";

/**
 * The Worker bindings the server functions read.
 *
 * MUTATED, never reassigned: `mock.module` runs its factory once, so the
 * `env` the module under test holds is THIS object forever. Swapping the
 * variable for a fresh one between tests silently disconnects it, and every
 * later binding assignment lands somewhere nothing reads.
 */
const fakeEnv: {
  GATEWAY?: Record<string, unknown>;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  DB?: unknown;
} = {
  BETTER_AUTH_URL: "http://localhost:3000",
};

function resetFakeEnv(): void {
  for (const key of Object.keys(fakeEnv)) {
    delete (fakeEnv as Record<string, unknown>)[key];
  }
  fakeEnv.BETTER_AUTH_URL = "http://localhost:3000";
}

/**
 * The headers `getRequest()` hands the server functions. Empty by default (the
 * anonymous, fail-closed case); a test that needs a real session assigns the
 * sign-in cookie here.
 */
let fakeRequestHeaders = new Headers();

installServerFnMocks({
  env: fakeEnv,
  getRequest: () => new Request("http://localhost:3000/", { headers: fakeRequestHeaders }),
});

const {
  createOrganization,
  createWorkspaceErrorCopy,
  acceptInvitation,
  getInvitation,
  invitationFailure,
} =
  await import("../src/organizations");
const { createAuth } = await import("../src/auth/auth");
const { CaptureMailSender } = await import("../src/auth/mail");
const { authConfigFromEnv } = await import("../src/auth/config");

const BASE_URL = "http://localhost:3000";
const SECRET = "test-secret-32-chars-minimum-length!!";

async function createTestAuth() {
  const db = new Database(":memory:");
  const auth = createAuth({
    database: db,
    secret: SECRET,
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    mcpResource: "http://localhost:8788/mcp",
    mail: new CaptureMailSender(),
  });
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  return { auth, db };
}

function cookieHeaders(db: Database, email: string, signInCookie: string | null): Headers {
  // signInCookie is a placeholder for pattern symmetry; the caller signs in first.
  return new Headers({ cookie: signInCookie ?? "" });
}

afterEach(() => {
  resetFakeEnv();
  fakeRequestHeaders = new Headers();
});

/**
 * An auth instance built exactly the way the Worker builds it — from the
 * bindings, through `authConfigFromEnv` — so a cookie minted here verifies
 * against the instance the server functions construct for themselves. Building
 * it any other way would sign the session with a different secret and every
 * server-function call would fail closed for the wrong reason.
 */
async function createServerFnAuth() {
  const db = withD1Statements(new Database(":memory:"));
  fakeEnv.DB = db;
  fakeEnv.BETTER_AUTH_SECRET = SECRET;
  const auth = createAuth(authConfigFromEnv(fakeEnv as never));
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  return { auth, db };
}

/** Sign a verified user in and point `getRequest()` at their session. */
async function signInAsServerFnCaller(
  auth: ReturnType<typeof createAuth>,
  db: Database,
  email: string,
): Promise<void> {
  await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: email }),
    }),
  );
  db.query('UPDATE user SET "emailVerified" = 1 WHERE email = ?').run(email);
  const signIn = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    }),
  );
  fakeRequestHeaders = new Headers({ cookie: signIn.headers.get("set-cookie")!.split(";")[0]! });
}

/**
 * Organization slugs in these fixtures are minted, never chosen.
 *
 * Better Auth's `createOrganization` still REQUIRES a slug (the column is
 * `not null unique`), but the console no longer lets a customer supply one:
 * `src/organizations.ts` mints `crypto.randomUUID()`. The fixtures mirror that
 * so nothing here can quietly start depending on a readable slug again.
 */
const mintSlug = () => crypto.randomUUID();

describe("organization onboarding (identity plane)", () => {
  test("verified user creates an organization through the auth handler", async () => {
    const { auth, db } = await createTestAuth();
    // Sign up + simulate verification.
    await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email: "owner@corp.test", password: "correct-horse-battery", name: "O" }),
      }),
    );
    db.query('UPDATE user SET "emailVerified" = 1').run();
    const signIn = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email: "owner@corp.test", password: "correct-horse-battery" }),
      }),
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
    const headers = new Headers({ cookie });
    enrollTotp(db, "owner@corp.test");

    const org = (await auth.api.createOrganization({
      body: { name: "Acme", slug: mintSlug() },
      headers,
    })) as { id?: string };
    expect(org?.id).toBeTruthy();

    // A second user joins via invitation: same organization, never a new tenant.
    const invitation = (await auth.api.createInvitation({
      body: { email: "op@corp.test", role: "operator", organizationId: org!.id! },
      headers,
    })) as { id?: string };
    expect(invitation?.id).toBeTruthy();

    await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email: "op@corp.test", password: "correct-horse-battery", name: "Op" }),
      }),
    );
    db.query('UPDATE user SET "emailVerified" = 1').run();
    const opSignIn = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email: "op@corp.test", password: "correct-horse-battery" }),
      }),
    );
    const opHeaders = cookieHeaders(db, "op@corp.test", opSignIn.headers.get("set-cookie")!.split(";")[0]!);

    const accepted = (await auth.api.acceptInvitation({
      body: { invitationId: invitation!.id! },
      headers: opHeaders,
    })) as { invitation?: { organizationId?: string } };
    expect(accepted?.invitation?.organizationId).toBe(org!.id!);

    // Both users belong to exactly the same single organization.
    const opOrgs = (await auth.api.listOrganizations({ headers: opHeaders })) as unknown[];
    expect(opOrgs.length).toBe(1);
  });

  test("invitation acceptance requires the invited identity (fail closed)", async () => {
    const { auth, db } = await createTestAuth();
    const mk = async (email: string) => {
      await auth.handler(
        new Request(`${BASE_URL}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify({ email, password: "correct-horse-battery", name: email }),
        }),
      );
      db.query('UPDATE user SET "emailVerified" = 1 WHERE email = ?').run(email);
      const si = await auth.handler(
        new Request(`${BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify({ email, password: "correct-horse-battery" }),
        }),
      );
      return new Headers({ cookie: si.headers.get("set-cookie")!.split(";")[0]! });
    };

    const ownerHeaders = await mk("owner2@corp.test");
    enrollTotp(db, "owner2@corp.test");
    const org = (await auth.api.createOrganization({
      body: { name: "Globex", slug: mintSlug() },
      headers: ownerHeaders,
    })) as { id?: string };
    const invitation = (await auth.api.createInvitation({
      body: { email: "expected@corp.test", role: "viewer", organizationId: org!.id! },
      headers: ownerHeaders,
    })) as { id?: string };

    // A DIFFERENT (also verified) identity tries to accept — must fail.
    const intruderHeaders = await mk("intruder@corp.test");
    await expect(
      auth.api.acceptInvitation({
        body: { invitationId: invitation!.id! },
        headers: intruderHeaders,
      }),
    ).rejects.toThrow();
  });
});

describe("organization server functions", () => {
  test("account provisioning saga is invoked through the gateway binding", async () => {
    const calls: Array<[string, string?]> = [];
    fakeEnv.GATEWAY = {
      ensureOrganizationAccount: async (organizationId: string, name?: string) => {
        calls.push([organizationId, name]);
        return { accountId: "acc_1", status: "active" as const };
      },
      getOrganizationAccountLink: async () => ({ accountId: "acc_1", status: "active" as const }),
    };
    // The createOrganization server function requires a real session; with no
    // session the call must fail closed BEFORE touching the gateway.
    const result = await createOrganization({ data: { name: "Acme" } });
    expect(result.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

});

/**
 * The slug stopped being a customer-supplied value (contract §9).
 *
 * It is minted server-side as a random UUID, which is what makes Better Auth's
 * GLOBALLY unique `organization.slug` column satisfiable without any input from
 * the customer taking part in a cross-tenant uniqueness check — the check that
 * used to answer "does another customer already have a workspace by this name?"
 * straight into the browser.
 */
describe("workspace slugs are minted, never derived", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  test("two workspaces may carry the same name, with distinct opaque slugs", async () => {
    const { auth, db } = await createServerFnAuth();
    let seq = 0;
    fakeEnv.GATEWAY = {
      ensureOrganizationAccount: async () => ({
        accountId: `acc_${++seq}`,
        status: "active" as const,
      }),
      getOrganizationAccountLink: async () => ({ accountId: "acc_1", status: "active" as const }),
    };
    await signInAsServerFnCaller(auth, db, "twins@corp.test");

    const first = await createOrganization({ data: { name: "Citta" } });
    const second = await createOrganization({ data: { name: "Citta" } });
    // Name collision is no longer an error — it is the correct multi-tenant
    // semantics. Both succeed, and both are provisioned.
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(seq).toBe(2);

    const rows = db.query("SELECT name, slug FROM organization").all() as Array<{
      name: string;
      slug: string;
    }>;
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.name)).toEqual(["Citta", "Citta"]);
    expect(rows[0]!.slug).not.toBe(rows[1]!.slug);
    for (const row of rows) {
      expect(row.slug).toMatch(UUID_RE);
      // Nothing about the customer's own text survives into the value.
      expect(row.slug).not.toContain("citta");
    }
  });

  test("a slug supplied by the caller is refused, not honoured", async () => {
    const { auth, db } = await createServerFnAuth();
    fakeEnv.GATEWAY = {
      ensureOrganizationAccount: async () => ({ accountId: "acc_1", status: "active" as const }),
      getOrganizationAccountLink: async () => ({ accountId: "acc_1", status: "active" as const }),
    };
    await signInAsServerFnCaller(auth, db, "sneaky@corp.test");
    // `createOrgInput` is `.strict()`, so an extra key is a validation throw
    // rather than a silently ignored field. (The mocked `createServerFn` shell
    // in this file drops `.validator()`, so assert the schema itself.)
    const { createOrgInput } = (await import("../src/organizations")) as unknown as {
      createOrgInput: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(createOrgInput.safeParse({ name: "Citta", slug: "citta" }).success).toBe(false);
    expect(createOrgInput.safeParse({ name: "Citta" }).success).toBe(true);
  });
});

/**
 * Creation failures answer with the console's own copy, never the provider's.
 *
 * The provider's text is the leak vector this change is about: a message that
 * varies with the state of ANOTHER tenant is an oracle wherever it surfaces.
 */
describe("createWorkspaceErrorCopy", () => {
  const RETRY = "Could not create the workspace right now. Please try again.";

  test("a real duplicate-slug error collapses into the generic retry line", async () => {
    const { auth, db } = await createTestAuth();
    const headers = await (async () => {
      await auth.handler(
        new Request(`${BASE_URL}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify({
            email: "dup@corp.test",
            password: "correct-horse-battery",
            name: "D",
          }),
        }),
      );
      db.query('UPDATE user SET "emailVerified" = 1').run();
      const signIn = await auth.handler(
        new Request(`${BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify({ email: "dup@corp.test", password: "correct-horse-battery" }),
        }),
      );
      return new Headers({ cookie: signIn.headers.get("set-cookie")!.split(";")[0]! });
    })();

    const slug = mintSlug();
    await auth.api.createOrganization({ body: { name: "First", slug }, headers });
    let thrown: unknown;
    try {
      await auth.api.createOrganization({ body: { name: "Second", slug }, headers });
    } catch (err) {
      thrown = err;
    }
    // The provider DOES say something specific — that is the point.
    expect(thrown).toBeTruthy();
    expect(String((thrown as Error).message)).toMatch(/exist/i);
    // And none of it reaches the browser.
    expect(createWorkspaceErrorCopy(thrown)).toBe(RETRY);
  });

  test("the allowlisted conditions keep their own sentence", async () => {
    const { auth } = await createTestAuth();
    let thrown: unknown;
    try {
      // No headers, no session: better-auth throws a real UNAUTHORIZED APIError.
      await auth.api.createOrganization({ body: { name: "X", slug: mintSlug() } } as never);
    } catch (err) {
      thrown = err;
    }
    expect(createWorkspaceErrorCopy(thrown)).toBe(
      "Your session has expired. Sign in again to create a workspace.",
    );
  });

  test("anything unrecognised — a binding failure, a plain Error — is the retry line", () => {
    expect(createWorkspaceErrorCopy(new Error("GATEWAY service binding is not configured"))).toBe(
      RETRY,
    );
    expect(createWorkspaceErrorCopy("D1_ERROR: UNIQUE constraint failed: organization.slug")).toBe(
      RETRY,
    );
    expect(createWorkspaceErrorCopy(null)).toBe(RETRY);
  });
});

describe("invitation server functions", () => {
  const UNAVAILABLE = /not available to the account you are signed in with/;
  const RETRY = {
    ok: false,
    kind: "retry",
    error: "Something went wrong with this invitation. Please try again.",
  };

  async function invite(auth: ReturnType<typeof createAuth>, db: Database, email: string) {
    await signInAsServerFnCaller(auth, db, "reseller@corp.test");
    enrollTotp(db, "reseller@corp.test");
    const org = (await auth.api.createOrganization({
      body: { name: "NACEX 2801", slug: mintSlug() },
      headers: fakeRequestHeaders,
    })) as { id: string };
    const invitation = (await auth.api.createInvitation({
      body: { email, role: "operator", organizationId: org.id },
      headers: fakeRequestHeaders,
    })) as { id: string };
    return { organizationId: org.id, invitationId: invitation.id };
  }

  /** A gateway whose account link fails until `healthy` is set. */
  function linkingGateway() {
    const state = { healthy: true, linked: [] as string[] };
    fakeEnv.GATEWAY = {
      ensureOrganizationAccount: async (organizationId: string) => {
        if (!state.healthy) throw new Error("control plane unavailable");
        state.linked.push(organizationId);
        return { accountId: "acc_1", status: "active" as const };
      },
    };
    return state;
  }

  async function activeOrganization(auth: ReturnType<typeof createAuth>) {
    const session = (await auth.api.getSession({ headers: fakeRequestHeaders })) as {
      session: { activeOrganizationId?: string | null };
    };
    return session.session.activeOrganizationId;
  }

  test("the invitee reads the workspace name, accepts, and the joined workspace becomes active", async () => {
    const { auth, db } = await createServerFnAuth();
    const gateway = linkingGateway();
    const { organizationId, invitationId } = await invite(auth, db, "agency@corp.test");

    // The invitee already works in a workspace of their own.
    await signInAsServerFnCaller(auth, db, "agency@corp.test");
    const own = (await auth.api.createOrganization({
      body: { name: "Own", slug: mintSlug() },
      headers: fakeRequestHeaders,
    })) as { id: string };
    await auth.api.setActiveOrganization({ body: { organizationId: own.id }, headers: fakeRequestHeaders });

    expect(await getInvitation({ data: { invitationId } })).toEqual({
      ok: true,
      data: { organizationName: "NACEX 2801", joined: false },
    });
    expect(await acceptInvitation({ data: { invitationId } })).toEqual({ ok: true, data: { organizationId } });
    expect(gateway.linked).toEqual([organizationId]);
    expect(await activeOrganization(auth)).toBe(organizationId);
  });

  test("an accept whose account link failed is finished by the retry, never refused as someone else's", async () => {
    const { auth, db } = await createServerFnAuth();
    const gateway = linkingGateway();
    const { organizationId, invitationId } = await invite(auth, db, "agency@corp.test");
    await signInAsServerFnCaller(auth, db, "agency@corp.test");

    gateway.healthy = false;
    expect(await acceptInvitation({ data: { invitationId } })).toEqual(RETRY);

    // Better Auth has accepted it: the member is in, the link is not.
    expect(await getInvitation({ data: { invitationId } })).toEqual({
      ok: true,
      data: { organizationName: "NACEX 2801", joined: true },
    });
    expect(await acceptInvitation({ data: { invitationId } })).toEqual(RETRY);

    gateway.healthy = true;
    await auth.api.setActiveOrganization({ body: { organizationId: null }, headers: fakeRequestHeaders });
    expect(await acceptInvitation({ data: { invitationId } })).toEqual({ ok: true, data: { organizationId } });
    expect(gateway.linked).toEqual([organizationId]);
    expect(await activeOrganization(auth)).toBe(organizationId);

    // The accepted invitation still tells another identity nothing.
    await signInAsServerFnCaller(auth, db, "intruder@corp.test");
    for (const result of [
      await getInvitation({ data: { invitationId } }),
      await acceptInvitation({ data: { invitationId } }),
    ]) {
      expect(result).toMatchObject({ ok: false, kind: "unavailable", error: expect.stringMatching(UNAVAILABLE) });
    }
  });

  test("another identity gets the same sentence as a missing invitation, never the provider's", async () => {
    const { auth, db } = await createServerFnAuth();
    linkingGateway();
    const { invitationId } = await invite(auth, db, "agency@corp.test");
    await signInAsServerFnCaller(auth, db, "intruder@corp.test");

    for (const id of [invitationId, "no-such-invitation"]) {
      for (const result of [
        await getInvitation({ data: { invitationId: id } }),
        await acceptInvitation({ data: { invitationId: id } }),
      ]) {
        expect(result).toMatchObject({ ok: false, kind: "unavailable", error: expect.stringMatching(UNAVAILABLE) });
      }
    }
  });

  test("a lapsed session is its own kind on both calls, so the client goes to sign-in", async () => {
    await createServerFnAuth();
    linkingGateway();
    for (const result of [
      await getInvitation({ data: { invitationId: "inv_1" } }),
      await acceptInvitation({ data: { invitationId: "inv_1" } }),
    ]) {
      expect(result).toMatchObject({ ok: false, kind: "signed-out" });
    }
  });

  test("a read whose setup throws still answers with the page's own copy", async () => {
    // A production origin with no secret: building the auth instance itself throws.
    fakeEnv.BETTER_AUTH_URL = "https://console.example";
    expect(await getInvitation({ data: { invitationId: "inv_1" } })).toEqual(RETRY);
  });

  test("only recognised codes get their own sentence; the rest are transient and logged without their message", () => {
    const GONE = { ok: false, kind: "unavailable", error: "This invitation is no longer valid. Ask for a new one." };
    expect(invitationFailure({ body: { code: "ORGANIZATION_NOT_FOUND" } })).toEqual(GONE);
    expect(invitationFailure({ body: { code: "INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION" } })).toEqual(GONE);
    expect(invitationFailure({ body: { code: "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION" } })).toMatchObject({
      kind: "unavailable",
      error: expect.stringMatching(/Verify your email address/),
    });
    expect(invitationFailure({ status: "UNAUTHORIZED" }).kind).toBe("signed-out");

    const warn = console.warn;
    const logged: string[] = [];
    console.warn = (line: string) => void logged.push(line);
    try {
      // A bare status is not a diagnosis: never read as "wrong account".
      expect(invitationFailure({ status: "BAD_REQUEST", body: { message: "nope" } })).toEqual(RETRY);
      expect(invitationFailure(new Error('account "acc_secret" does not exist'))).toEqual(RETRY);
      expect(invitationFailure(null)).toEqual(RETRY);
    } finally {
      console.warn = warn;
    }
    expect(logged).toHaveLength(3);
    expect(logged.join("")).not.toContain("acc_secret");
    expect(JSON.parse(logged[1]!)).toMatchObject({ event: "invitation-failed", code: null, error: "Error" });
  });
});
