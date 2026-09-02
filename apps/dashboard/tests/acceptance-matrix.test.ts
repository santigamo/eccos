/**
 * Fresh-state acceptance matrix (eccos-0x0.9, contract §11).
 *
 * Two organizations, three users (one belonging to BOTH organizations),
 * concurrent negative isolation checks, session revocation, and direct
 * endpoint governance — exercised against the real Better Auth instance on an
 * in-memory D1-equivalent (bun:sqlite), the same configuration the Worker
 * runs with the D1 binding.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/auth/auth";
import { CaptureMailSender } from "../src/auth/mail";
import { requirePermission, verifyMembership } from "../src/auth/tenant";
import { ForbiddenError } from "../src/auth/tenant";

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

async function verifiedUser(auth: ReturnType<typeof createAuth>, db: Database, email: string): Promise<Headers> {
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

/** hasPermission that returns success:false on thrown 401 (non-member). */
async function perm(
  auth: ReturnType<typeof createAuth>,
  headers: Headers,
  organizationId: string,
  actions: string[],
): Promise<boolean> {
  try {
    const r = (await auth.api.hasPermission({
      body: {
            permissions: Object.fromEntries(actions.map((a) => ["gateway", [a]])),
            organizationId,
          },
      headers,
    })) as { success?: boolean };
    return r.success === true;
  } catch {
    return false;
  }
}

interface Org {
  organizationId: string;
  ownerHeaders: Headers;
  /** A member of this org (viewer) for isolation checks. */
  viewerHeaders: Headers;
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

async function createOrgWithViewer(
  auth: ReturnType<typeof createAuth>,
  db: Database,
  name: string,
  ownerEmail: string,
  viewerEmail?: string,
): Promise<Org> {
  const ownerHeaders = await verifiedUser(auth, db, ownerEmail);
  const org = (await auth.api.createOrganization({
    body: { name, slug: mintSlug() },
    headers: ownerHeaders,
  })) as { id?: string };
  const organizationId = org!.id!;
  let viewerHeaders = ownerHeaders;
  if (viewerEmail) {
    const invitation = (await auth.api.createInvitation({
      body: { email: viewerEmail, role: "viewer", organizationId },
      headers: ownerHeaders,
    })) as { id?: string };
    viewerHeaders = await verifiedUser(auth, db, viewerEmail);
    await auth.api.acceptInvitation({ body: { invitationId: invitation!.id! }, headers: viewerHeaders });
  }
  return { organizationId, ownerHeaders, viewerHeaders };
}

describe("fresh-state acceptance matrix", () => {
  test("two organizations: one member cannot read or act on the other", async () => {
    const { auth, db } = await createTestAuth();
    const a = await createOrgWithViewer(auth, db, "tenant-a", "a-owner@corp.test", "a-viewer@corp.test");
    const b = await createOrgWithViewer(auth, db, "tenant-b", "b-owner@corp.test", "b-viewer@corp.test");

    // Org A's viewer holds view ONLY in org A; in org B: nothing (401 thrown).
    expect(await verifyMembership(auth, a.viewerHeaders, a.organizationId)).toBe(true);
    expect(await verifyMembership(auth, a.viewerHeaders, b.organizationId)).toBe(false);
    expect(await perm(auth, a.viewerHeaders, b.organizationId, ["view"])).toBe(false);
    // Even org A's OWNER has zero in org B — every gateway action denied.
    for (const action of ["view", "operate", "configure", "administer", "erase"]) {
      expect(await perm(auth, a.ownerHeaders, b.organizationId, [action])).toBe(false);
    }
  });

  test("a user belonging to both organizations is scoped per request", async () => {
    const { auth, db } = await createTestAuth();
    const a = await createOrgWithViewer(auth, db, "dual-a", "a2-owner@corp.test", "dual@corp.test");
    // The dual user joins org B as OWNER (invited directly by b2-owner).
    const bOwnerHeaders = await verifiedUser(auth, db, "b2-owner@corp.test");
    const bOrg = (await auth.api.createOrganization({
      body: { name: "dual-b", slug: mintSlug() },
      headers: bOwnerHeaders,
    })) as { id?: string };
    const bOwnerInvitation = (await auth.api.createInvitation({
      body: { email: "dual@corp.test", role: "owner", organizationId: bOrg!.id! },
      headers: bOwnerHeaders,
    })) as { id?: string };
    const dualInB = await verifiedUser(auth, db, "dual@corp.test");
    await auth.api.acceptInvitation({
      body: { invitationId: bOwnerInvitation!.id! },
      headers: dualInB,
    });
    const b = { organizationId: bOrg!.id!, ownerHeaders: bOwnerHeaders, viewerHeaders: dualInB };

    // The dual user belongs to both.
    expect(await verifyMembership(auth, a.viewerHeaders, a.organizationId)).toBe(true);
    expect(await verifyMembership(auth, a.viewerHeaders, b.organizationId)).toBe(true);

    // But capabilities differ per organization: viewer in A (no configure),
    // owner in B (configure). Changing the requested organization id changes
    // nothing beyond what membership grants there.
    expect(await perm(auth, a.viewerHeaders, a.organizationId, ["configure"])).toBe(false);
    expect(await perm(auth, a.viewerHeaders, b.organizationId, ["configure"])).toBe(true);
  });

  test("concurrent isolation: interleaved cross-tenant permission checks fail closed", async () => {
    const { auth, db } = await createTestAuth();
    const a = await createOrgWithViewer(auth, db, "conc-a", "c-a@corp.test", "c-a-v@corp.test");
    const b = await createOrgWithViewer(auth, db, "conc-b", "c-b@corp.test", "c-b-v@corp.test");
    const results = await Promise.all([
      perm(auth, a.viewerHeaders, a.organizationId, ["view"]),
      perm(auth, a.viewerHeaders, b.organizationId, ["view"]),
      perm(auth, b.viewerHeaders, b.organizationId, ["view"]),
      perm(auth, b.viewerHeaders, a.organizationId, ["view"]),
      perm(auth, a.ownerHeaders, b.organizationId, ["erase"]),
    ]);
    expect(results).toEqual([true, false, true, false, false]);
  });

  test("revoked membership takes effect on the next protected request", async () => {
    const { auth, db } = await createTestAuth();
    const { organizationId, ownerHeaders, viewerHeaders } = await createOrgWithViewer(
      auth,
      db,
      "revoke-org",
      "r-owner@corp.test",
      "r-viewer@corp.test",
    );
    // Member before removal: view allowed.
    const before = (await auth.api.hasPermission({
      body: { permissions: { gateway: ["view"] }, organizationId },
      headers: viewerHeaders,
    })) as { success?: boolean };
    expect(before.success).toBe(true);

    // Owner removes the member.
    const members = (await auth.api.listMembers({
      query: { organizationId },
      headers: ownerHeaders,
    })) as { members: Array<{ id?: string; userId?: unknown; email?: unknown }> };
    await auth.api.removeMember({
      body: { organizationId, memberIdOrEmail: "r-viewer@corp.test" },
      headers: ownerHeaders,
    });

    // Next protected request: fail closed.
    const after = (await auth.api.hasPermission({
      body: { permissions: { gateway: ["view"] }, organizationId },
      headers: viewerHeaders,
    }).catch(() => ({ success: false }))) as { success?: boolean };
    expect(after.success).not.toBe(true);
  });

  test("direct organization delete endpoint is disabled", async () => {
    const { auth, db } = await createTestAuth();
    const { organizationId, ownerHeaders } = await createOrgWithViewer(auth, db, "doomed", "d-owner@corp.test");
    await expect(
      auth.api.deleteOrganization({ body: { organizationId }, headers: ownerHeaders }),
    ).rejects.toThrow();
    // The organization still resolves.
    const stillThere = (await auth.api.getOrganization({
      query: { organizationId },
      headers: ownerHeaders,
    })) as { id?: string };
    expect(stillThere?.id).toBe(organizationId);
  });

  test("session revocation fails closed", async () => {
    const { auth, db } = await createTestAuth();
    const headers = await verifiedUser(auth, db, "revoke@corp.test");
    const session = (await auth.api.getSession({ headers })) as {
      session?: { id?: string; token?: string };
    };
    expect(session?.session?.id).toBeTruthy();
    await auth.api.revokeSession({ body: { token: session!.session!.token! }, headers });
    const after = (await auth.api.getSession({ headers }).catch(() => null)) as {
      session?: unknown;
    } | null;
    expect(after?.session).toBeFalsy();
  });
});
