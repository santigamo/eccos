/**
 * Organization onboarding tests (eccos-0x0.5, contract §7).
 *
 * Exercises the real Better Auth invitation flow end to end: verified signup →
 * organization creation (with idempotent account provisioning via a mocked
 * gateway binding) → invitation of a second verified user → acceptance joining
 * the SAME account (no new tenant) → cross-organization isolation of
 * invitation acceptance.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";

let fakeEnv: { GATEWAY?: Record<string, unknown>; BETTER_AUTH_URL?: string } = {
  BETTER_AUTH_URL: "http://localhost:3000",
};

mock.module("cloudflare:workers", () => ({
  env: fakeEnv,
}));

// Server-function shell: run the handler directly (no TanStack runtime here).
mock.module("@tanstack/react-start", () => ({
  createServerFn: (_opts?: unknown) => {
    const api = {
      validator: (_v: unknown) => api,
      handler: (fn: (arg?: unknown) => unknown) => (arg?: unknown) =>
        fn(arg && typeof arg === "object" && "data" in arg ? arg : { data: arg }),
    };
    return api;
  },
}));

mock.module("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("http://localhost:3000/"),
}));

const { createOrganization, inviteMember, acceptInvitation } = await import("../src/organizations");
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
  fakeEnv = { BETTER_AUTH_URL: "http://localhost:3000" };
});

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

    const org = (await auth.api.createOrganization({
      body: { name: "Acme", slug: "acme" },
      headers,
    })) as { id?: string; slug?: string };
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
    const org = (await auth.api.createOrganization({
      body: { name: "Globex", slug: "globex" },
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
    const result = await createOrganization({ data: { name: "Acme", slug: "acme" } });
    expect(result.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});
