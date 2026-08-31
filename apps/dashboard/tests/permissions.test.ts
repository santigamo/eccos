/**
 * Role/capability matrix tests (eccos-0x0.3, contract §4).
 *
 * Seeds an organization with one member per role through the real invitation
 * flow, then asserts the gateway permission matrix and the fail-closed paths of
 * the tenant helpers (`requirePermission` / `verifyMembership`).
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/auth/auth";
import { CaptureMailSender } from "../src/auth/mail";
import { requirePermission, verifyMembership } from "../src/auth/tenant";
import { ForbiddenError } from "../src/auth/tenant";
import { UnauthorizedError } from "../src/auth/session";

const BASE_URL = "http://localhost:3000";

async function createTestAuth() {
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
  return { auth, db };
}

async function signInHeaders(
  auth: ReturnType<typeof createAuth>,
  db: Database,
  email: string,
): Promise<Headers> {
  const res = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: email }),
    }),
  );
  expect(res.status).toBe(200);
  db.query('UPDATE user SET "emailVerified" = 1 WHERE email = ?').run(email);
  const signIn = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    }),
  );
  expect(signIn.status).toBe(200);
  return new Headers({ cookie: signIn.headers.get("set-cookie")!.split(";")[0]! });
}

async function inviteAndAccept(
  auth: ReturnType<typeof createAuth>,
  ownerHeaders: Headers,
  organizationId: string,
  email: string,
  role: string,
): Promise<Headers> {
  const invitation = (await auth.api.createInvitation({
    body: { email, role, organizationId },
    headers: ownerHeaders,
  })) as { id?: string };
  const db = (auth.options.database as unknown as Database);
  const headers = await signInHeaders(auth, db, email);
  const accepted = await auth.api.acceptInvitation({
    body: { invitationId: invitation!.id! },
    headers,
  });
  expect(accepted).toBeTruthy();
  await auth.api.setActiveOrganization({ body: { organizationId }, headers });
  return headers;
}

/** Seed: one org, one member per role. Returns headers per role + orgId. */
async function seedOrganization(auth: ReturnType<typeof createAuth>, db: Database) {
  const ownerHeaders = await signInHeaders(auth, db, "owner@corp.test");
  const org = (await auth.api.createOrganization({
    body: { name: "Acme", slug: "acme" },
    headers: ownerHeaders,
  })) as { id?: string; slug?: string };
  const organizationId = org!.id!;
  await auth.api.setActiveOrganization({ body: { organizationId }, headers: ownerHeaders });

  const adminHeaders = await inviteAndAccept(auth, ownerHeaders, organizationId, "admin@corp.test", "admin");
  const operatorHeaders = await inviteAndAccept(auth, ownerHeaders, organizationId, "operator@corp.test", "operator");
  const viewerHeaders = await inviteAndAccept(auth, ownerHeaders, organizationId, "viewer@corp.test", "viewer");
  const outsiderHeaders = await signInHeaders(auth, db, "outsider@corp.test");

  return { organizationId, ownerHeaders, adminHeaders, operatorHeaders, viewerHeaders, outsiderHeaders };
}

describe("gateway permission matrix", () => {
  test("owner holds every gateway action", async () => {
    const { auth, db } = await createTestAuth();
    const { organizationId, ownerHeaders } = await seedOrganization(auth, db);
    const result = (await auth.api.hasPermission({
      body: { permissions: { gateway: ["view", "operate", "configure", "administer", "erase"] }, organizationId },
      headers: ownerHeaders,
    })) as { success?: boolean };
    expect(result.success).toBe(true);
  });

  test("admin holds view/operate/configure/administer but not erase", async () => {
    const { auth, db } = await createTestAuth();
    const { organizationId, adminHeaders } = await seedOrganization(auth, db);
    const has = (await auth.api.hasPermission({
      body: { permissions: { gateway: ["view", "operate", "configure", "administer"] }, organizationId },
      headers: adminHeaders,
    })) as { success?: boolean };
    expect(has.success).toBe(true);
    const erase = (await auth.api.hasPermission({
      body: { permissions: { gateway: ["erase"] }, organizationId },
      headers: adminHeaders,
    })) as { success?: boolean };
    expect(erase.success).toBe(false);
  });

  test("operator holds view/operate but not configure/administer/erase", async () => {
    const { auth, db } = await createTestAuth();
    const { organizationId, operatorHeaders } = await seedOrganization(auth, db);
    const has = (await auth.api.hasPermission({
      body: { permissions: { gateway: ["view", "operate"] }, organizationId },
      headers: operatorHeaders,
    })) as { success?: boolean };
    expect(has.success).toBe(true);
    const denied = (await auth.api.hasPermission({
      body: { permissions: { gateway: ["configure", "administer", "erase"] }, organizationId },
      headers: operatorHeaders,
    })) as { success?: boolean };
    expect(denied.success).toBe(false);
  });

  test("viewer holds view only", async () => {
    const { auth, db } = await createTestAuth();
    const { organizationId, viewerHeaders } = await seedOrganization(auth, db);
    const view = (await auth.api.hasPermission({
      body: { permissions: { gateway: ["view"] }, organizationId },
      headers: viewerHeaders,
    })) as { success?: boolean };
    expect(view.success).toBe(true);
    const denied = (await auth.api.hasPermission({
      body: { permissions: { gateway: ["operate"] }, organizationId },
      headers: viewerHeaders,
    })) as { success?: boolean };
    expect(denied.success).toBe(false);
  });
});

describe("tenant helpers", () => {
  test("verifyMembership accepts a real membership and rejects a guessed org id", async () => {
    const { auth, db } = await createTestAuth();
    const { organizationId, viewerHeaders, outsiderHeaders } = await seedOrganization(auth, db);
    expect(await verifyMembership(auth, viewerHeaders, organizationId)).toBe(true);
    expect(await verifyMembership(auth, outsiderHeaders, organizationId)).toBe(false);
    expect(await verifyMembership(auth, viewerHeaders, "org_forged")).toBe(false);
    expect(await verifyMembership(auth, viewerHeaders, "")).toBe(false);
  });

  test("requirePermission returns the validated organizationId for allowed actions", async () => {
    const { auth, db } = await createTestAuth();
    const { organizationId, operatorHeaders } = await seedOrganization(auth, db);
    const resolved = await requirePermission(auth, operatorHeaders, organizationId, "operate");
    expect(resolved).toBe(organizationId);
  });

  test("requirePermission throws ForbiddenError for denied actions", async () => {
    const { auth, db } = await createTestAuth();
    const { organizationId, viewerHeaders } = await seedOrganization(auth, db);
    expect(
      requirePermission(auth, viewerHeaders, organizationId, "erase"),
    ).rejects.toThrow(ForbiddenError);
  });

  test("requirePermission fails closed for a non-member even with a valid org id", async () => {
    const { auth, db } = await createTestAuth();
    const { organizationId, outsiderHeaders } = await seedOrganization(auth, db);
    expect(
      requirePermission(auth, outsiderHeaders, organizationId, "view"),
    ).rejects.toThrow(ForbiddenError);
  });

  test("requirePermission without a session throws UnauthorizedError", async () => {
    const { auth } = await createTestAuth();
    expect(
      requirePermission(auth, new Headers(), "org_x", "view"),
    ).rejects.toThrow(UnauthorizedError);
  });

  test("requirePermission falls back to the session's active organization (UX state, re-validated)", async () => {
    const { auth, db } = await createTestAuth();
    const { organizationId, ownerHeaders } = await seedOrganization(auth, db);
    // No explicit orgId: resolves from activeOrganizationId, then re-validates.
    const resolved = await requirePermission(auth, ownerHeaders, undefined, "view");
    expect(resolved).toBe(organizationId);
  });
});

/**
 * The reason codes a refusal carries (eccos-k5a). The console branches on these
 * — never on the message — so that a user who belongs to no workspace, one who
 * belongs to several, and one whose role is too narrow each get a screen that
 * says what actually happened. Mirrors `@eccos/auth-baseline`'s own suite.
 */
describe("ForbiddenError reasons", () => {
  function clearActiveOrganization(db: Database) {
    db.query('UPDATE session SET "activeOrganizationId" = NULL').run();
  }

  async function reasonOf(promise: Promise<unknown>): Promise<string> {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenError);
    return (err as ForbiddenError).reason;
  }

  test("no membership at all is 'no-organization'", async () => {
    const { auth, db } = await createTestAuth();
    const headers = await signInHeaders(auth, db, "nobody@corp.test");
    expect(await reasonOf(requirePermission(auth, headers, undefined, "view"))).toBe(
      "no-organization",
    );
  });

  test("a sole membership is defaulted to, not refused", async () => {
    const { auth, db } = await createTestAuth();
    const headers = await signInHeaders(auth, db, "sole@corp.test");
    const org = (await auth.api.createOrganization({
      body: { name: "Sole", slug: "sole" },
      headers,
    })) as { id?: string };
    clearActiveOrganization(db);
    expect(await requirePermission(auth, headers, undefined, "view")).toBe(org!.id!);
  });

  test("several memberships and none selected is 'select-organization'", async () => {
    const { auth, db } = await createTestAuth();
    const headers = await signInHeaders(auth, db, "both@corp.test");
    await auth.api.createOrganization({ body: { name: "One", slug: "one" }, headers });
    await auth.api.createOrganization({ body: { name: "Two", slug: "two" }, headers });
    clearActiveOrganization(db);
    expect(await reasonOf(requirePermission(auth, headers, undefined, "view"))).toBe(
      "select-organization",
    );
  });

  test("a narrow role is 'missing-permission', not a missing organization", async () => {
    const { auth, db } = await createTestAuth();
    const { organizationId, viewerHeaders } = await seedOrganization(auth, db);
    expect(await reasonOf(requirePermission(auth, viewerHeaders, organizationId, "erase"))).toBe(
      "missing-permission",
    );
  });

  test("a guessed organization id is 'not-a-member'", async () => {
    const { auth, db } = await createTestAuth();
    const { outsiderHeaders, organizationId } = await seedOrganization(auth, db);
    expect(await reasonOf(requirePermission(auth, outsiderHeaders, organizationId, "view"))).toBe(
      "not-a-member",
    );
  });
});
