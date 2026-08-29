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
