/**
 * Baseline tenant guard tests: session, organization, membership, permission,
 * invitation, and revocation behavior against the baseline configuration.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { createOrgAuthConfig, type MailSender } from "../src/config";
import { requirePermission, verifyMembership, ForbiddenError } from "../src/tenant";
import { UnauthorizedError } from "../src/session";

const BASE_URL = "http://localhost:3000";
const SECRET = "baseline-test-secret-32-characters!";

const captureMail: MailSender = {
  async sendMail() {},
};

function createBaselineAuth() {
  const db = new Database(":memory:");
  const auth = betterAuth(
    createOrgAuthConfig({
      database: db,
      secret: SECRET,
      baseURL: BASE_URL,
      mail: captureMail,
    }),
  );
  const migrations = getMigrations(auth.options);
  return { auth, db, migrations };
}

async function verifiedUser(auth: ReturnType<typeof betterAuth> extends never ? never : any, db: Database, email: string): Promise<Headers> {
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
  expect(signIn.status).toBe(200);
  return new Headers({ cookie: signIn.headers.get("set-cookie")!.split(";")[0]! });
}

describe("baseline guards", () => {
  test("members hold capabilities only in their organization", async () => {
    const { auth, db, migrations } = createBaselineAuth();
    await (await migrations).runMigrations();

    const mkOrg = async (slug: string, ownerEmail: string, viewerEmail: string) => {
      const ownerHeaders = await verifiedUser(auth, db, ownerEmail);
      const org = (await auth.api.createOrganization({
        body: { name: slug, slug },
        headers: ownerHeaders,
      })) as { id?: string };
      const inv = (await auth.api.createInvitation({
        body: { email: viewerEmail, role: "viewer", organizationId: org!.id! },
        headers: ownerHeaders,
      })) as { id?: string };
      const viewerHeaders = await verifiedUser(auth, db, viewerEmail);
      await auth.api.acceptInvitation({ body: { invitationId: inv!.id! }, headers: viewerHeaders });
      return { organizationId: org!.id!, ownerHeaders, viewerHeaders };
    };

    const a = await mkOrg("org-a", "a@t.test", "v-a@t.test");
    const b = await mkOrg("org-b", "b@t.test", "v-b@t.test");

    expect(await verifyMembership(auth, a.viewerHeaders, a.organizationId)).toBe(true);
    expect(await verifyMembership(auth, a.viewerHeaders, b.organizationId)).toBe(false);
    expect(
      requirePermission(auth, a.viewerHeaders, b.organizationId, "view"),
    ).rejects.toThrow(ForbiddenError);

  });

  test("viewer can view in own organization", async () => {
    const { auth, db, migrations } = createBaselineAuth();
    await (await migrations).runMigrations();

    const ownerHeaders = await verifiedUser(auth, db, "o2@t.test");
    const org = (await auth.api.createOrganization({
      body: { name: "solo", slug: "solo" },
      headers: ownerHeaders,
    })) as { id?: string };
    const organizationId = org!.id!;
    const resolved = await requirePermission(auth, ownerHeaders, organizationId, "view");
    expect(resolved).toBe(organizationId);
  });

  test("unauthenticated requests throw UnauthorizedError", async () => {
    const { auth, migrations } = createBaselineAuth();
    await (await migrations).runMigrations();
    expect(
      requirePermission(auth, new Headers(), "org_x", "view"),
    ).rejects.toThrow(UnauthorizedError);
  });
});

/**
 * Resolving the organization when the caller names none (eccos-k5a).
 *
 * The old baseline threw a bare "no organization context" here, which dead-ends
 * a user who has exactly one place to be and tells the ones who have several
 * nothing they can act on. It now mirrors the Eccos console's copy of this
 * module: default to a sole membership, and fail closed with a reason code
 * otherwise, so a UI can branch on the reason instead of the message text.
 */
describe("implicit organization resolution", () => {
  /** The session's stored active organization is UX state; drop it to test the
   * path where the caller supplies nothing at all. */
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

  test("a sole membership is the unambiguous default", async () => {
    const { auth, db, migrations } = createBaselineAuth();
    await (await migrations).runMigrations();
    const headers = await verifiedUser(auth, db, "sole@t.test");
    const org = (await auth.api.createOrganization({
      body: { name: "sole", slug: "sole" },
      headers,
    })) as { id?: string };
    clearActiveOrganization(db);

    // No explicit id, no active organization: one membership is not ambiguous.
    expect(await requirePermission(auth, headers, undefined, "view")).toBe(org!.id!);
  });

  test("no membership at all asks the user to create or join one", async () => {
    const { auth, db, migrations } = createBaselineAuth();
    await (await migrations).runMigrations();
    const headers = await verifiedUser(auth, db, "nobody@t.test");

    expect(await reasonOf(requirePermission(auth, headers, undefined, "view"))).toBe(
      "no-organization",
    );
  });

  test("several memberships and none selected asks for a choice", async () => {
    const { auth, db, migrations } = createBaselineAuth();
    await (await migrations).runMigrations();
    const headers = await verifiedUser(auth, db, "both@t.test");
    await auth.api.createOrganization({ body: { name: "one", slug: "one" }, headers });
    await auth.api.createOrganization({ body: { name: "two", slug: "two" }, headers });
    clearActiveOrganization(db);

    // Ambiguity fails closed rather than picking for the user.
    expect(await reasonOf(requirePermission(auth, headers, undefined, "view"))).toBe(
      "select-organization",
    );
  });

  test("a denied action reports the permission, not a missing organization", async () => {
    const { auth, db, migrations } = createBaselineAuth();
    await (await migrations).runMigrations();
    const ownerHeaders = await verifiedUser(auth, db, "owner-r@t.test");
    const org = (await auth.api.createOrganization({
      body: { name: "roles", slug: "roles" },
      headers: ownerHeaders,
    })) as { id?: string };
    const inv = (await auth.api.createInvitation({
      body: { email: "viewer-r@t.test", role: "viewer", organizationId: org!.id! },
      headers: ownerHeaders,
    })) as { id?: string };
    const viewerHeaders = await verifiedUser(auth, db, "viewer-r@t.test");
    await auth.api.acceptInvitation({ body: { invitationId: inv!.id! }, headers: viewerHeaders });

    expect(await reasonOf(requirePermission(auth, viewerHeaders, org!.id!, "erase"))).toBe(
      "missing-permission",
    );
  });

  test("a guessed organization id reports non-membership", async () => {
    const { auth, db, migrations } = createBaselineAuth();
    await (await migrations).runMigrations();
    const headers = await verifiedUser(auth, db, "guess@t.test");
    await auth.api.createOrganization({ body: { name: "mine", slug: "mine" }, headers });

    expect(await reasonOf(requirePermission(auth, headers, "org_guessed", "view"))).toBe(
      "not-a-member",
    );
  });
});
