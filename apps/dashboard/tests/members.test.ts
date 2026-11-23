/**
 * Workspace members server functions (`src/members.ts`) against a real Better
 * Auth instance built the way the Worker builds it, so the role matrix, the
 * owner rules, the copy and the invitation rate limit are Better Auth's and
 * ours together, not a mock's.
 */

import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { withD1Statements } from "./helpers/d1-statements";
import { enrollTotp } from "./helpers/step-up";

// Each test builds a real auth instance and signs several users in.
setDefaultTimeout(30_000);

const BASE_URL = "http://localhost:3000";
const SECRET = "test-secret-32-chars-minimum-length!!";

const fakeEnv: { BETTER_AUTH_URL: string; BETTER_AUTH_SECRET?: string; DB?: unknown } = {
  BETTER_AUTH_URL: BASE_URL,
};
let fakeRequestHeaders = new Headers();

installServerFnMocks({
  env: fakeEnv,
  getRequest: () => new Request(`${BASE_URL}/`, { headers: fakeRequestHeaders }),
});

const members = await import("../src/members");
const copy = await import("../src/lib/members-copy");
const { createAuth } = await import("../src/auth/auth");
const { authConfigFromEnv } = await import("../src/auth/config");

const { listWorkspaceMembers, inviteMember, resendInvitation, cancelInvitation, updateMemberRole, removeMember } =
  members;

afterEach(() => {
  fakeRequestHeaders = new Headers();
});

type Role = "owner" | "admin" | "operator" | "viewer";

/** One workspace with one member per role, plus a second workspace for cross-tenant ids. */
async function workspace() {
  const db = withD1Statements(new Database(":memory:"));
  fakeEnv.DB = db;
  fakeEnv.BETTER_AUTH_SECRET = SECRET;
  const auth = createAuth(authConfigFromEnv(fakeEnv as never));
  await (await getMigrations(auth.options)).runMigrations();

  const cookies = new Map<string, string>();
  async function user(email: string): Promise<string> {
    await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email, password: "correct-horse-battery", name: email.split("@")[0] }),
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
    cookies.set(email, signIn.headers.get("set-cookie")!.split(";")[0]!);
    // Every write here is a step-up row; "step-up" below takes it away again.
    enrollTotp(db, email);
    return (db.query("SELECT id FROM user WHERE email = ?").get(email) as { id: string }).id;
  }
  const headersOf = (email: string) => new Headers({ cookie: cookies.get(email)! });

  await user("owner@example.test");
  const org = (await auth.api.createOrganization({
    body: { name: "Agency", slug: crypto.randomUUID() },
    headers: headersOf("owner@example.test"),
  })) as { id: string };
  const memberIds: Record<string, string> = {};
  for (const role of ["admin", "operator", "viewer"] as const) {
    const userId = await user(`${role}@example.test`);
    await auth.api.addMember({ body: { userId, role, organizationId: org.id } });
  }
  for (const row of db.query("SELECT member.id, user.email FROM member JOIN user ON user.id = member.userId").all() as Array<{
    id: string;
    email: string;
  }>) {
    memberIds[row.email] = row.id;
  }

  await user("stranger@example.test");
  const other = (await auth.api.createOrganization({
    body: { name: "Elsewhere", slug: crypto.randomUUID() },
    headers: headersOf("stranger@example.test"),
  })) as { id: string };
  const foreignInvitation = (await auth.api.createInvitation({
    body: { email: "someone@example.test", role: "viewer", organizationId: other.id },
    headers: headersOf("stranger@example.test"),
  })) as { id: string };
  const foreignMember = (db.query("SELECT id FROM member WHERE organizationId = ?").get(other.id) as { id: string }).id;

  return {
    auth,
    db,
    user,
    org,
    memberIds,
    foreignInvitation: foreignInvitation.id,
    foreignMember,
    invite: (email: string, role: "admin" | "operator" | "viewer" = "viewer") =>
      inviteMember({ data: { email, role, organizationId: org.id } }),
    as: (who: Role | string) => {
      fakeRequestHeaders = headersOf(who.includes("@") ? who : `${who}@example.test`);
    },
    memberOf: (role: Role) => memberIds[`${role}@example.test`]!,
    pending: () =>
      db.query("SELECT id, email, role FROM invitation WHERE organizationId = ? AND status = 'pending'").all(org.id) as Array<{
        id: string;
        email: string;
        role: string;
      }>,
  };
}

describe("the role matrix", () => {
  test("an operator or a viewer is refused by every function", async () => {
    const ws = await workspace();
    ws.as("owner");
    await inviteMember({ data: { email: "pending@example.test", role: "viewer", organizationId: ws.org.id } });
    const invitationId = ws.pending()[0]!.id;
    const refused = { ok: false, error: copy.ASK_TO_MANAGE_MEMBERS };

    for (const role of ["operator", "viewer"] as const) {
      ws.as(role);
      expect(await listWorkspaceMembers()).toMatchObject({ ok: false, kind: "forbidden", reason: "missing-permission" });
      expect(await inviteMember({ data: { email: "new@example.test", role: "viewer", organizationId: ws.org.id } })).toEqual(refused);
      expect(await resendInvitation({ data: { invitationId } })).toEqual(refused);
      expect(await cancelInvitation({ data: { invitationId } })).toEqual(refused);
      expect(await updateMemberRole({ data: { memberId: ws.memberOf("viewer"), role: "admin" } })).toEqual(refused);
      expect(await removeMember({ data: { memberId: ws.memberOf("viewer") } })).toEqual(refused);
    }
    // Nothing they tried landed.
    expect(ws.pending().map((row) => row.id)).toEqual([invitationId]);
    expect(ws.db.query("SELECT role FROM member WHERE id = ?").get(ws.memberOf("viewer"))).toEqual({ role: "viewer" });
  });

  for (const role of ["owner", "admin"] as const) {
    test(`an ${role} may run every function`, async () => {
      const ws = await workspace();
      ws.as(role);
      const listed = await listWorkspaceMembers();
      expect(listed.ok).toBe(true);

      expect(await inviteMember({ data: { email: "new@example.test", role: "operator", organizationId: ws.org.id } })).toEqual({ ok: true });
      const first = ws.pending()[0]!.id;
      expect(await resendInvitation({ data: { invitationId: first } })).toEqual({ ok: true });
      const second = ws.pending()[0]!.id;
      expect(await cancelInvitation({ data: { invitationId: second } })).toEqual({ ok: true });
      expect(ws.pending()).toEqual([]);

      expect(await updateMemberRole({ data: { memberId: ws.memberOf("operator"), role: "viewer" } })).toEqual({ ok: true });
      expect(await removeMember({ data: { memberId: ws.memberOf("viewer") } })).toEqual({ ok: true });
      expect(ws.db.query("SELECT role FROM member WHERE id = ?").get(ws.memberOf("operator"))).toEqual({ role: "viewer" });
      expect(ws.db.query("SELECT id FROM member WHERE id = ?").get(ws.memberOf("viewer"))).toBeNull();
    });
  }

  test("signed out reads as a session to renew", async () => {
    const ws = await workspace();
    expect(await listWorkspaceMembers()).toMatchObject({ ok: false, kind: "unauthenticated" });
    expect(await inviteMember({ data: { email: "new@example.test", role: "viewer", organizationId: ws.org.id } })).toEqual({
      ok: false,
      error: copy.MEMBERS_SIGNED_OUT,
    });
  });

  test("the owner role is never accepted as input", async () => {
    await workspace();
    expect(() => members.inviteMemberInput.parse({ email: "new@example.test", role: "owner", organizationId: "o" })).toThrow();
    expect(() => updateMemberRole({ data: { memberId: "m", role: "owner" } })).toThrow();
  });
});

describe("the list", () => {
  test("members carry the caller's own row, and invitations their inviter and expiry", async () => {
    const ws = await workspace();
    ws.as("admin");
    await inviteMember({ data: { email: "new@example.test", role: "viewer", organizationId: ws.org.id } });
    const result = await listWorkspaceMembers();
    if (!result.ok) throw new Error(result.error);
    expect(result.data.callerRole).toBe("admin");
    expect(result.data.members.map((m) => [m.email, m.role, m.isSelf])).toEqual(
      expect.arrayContaining([
        ["owner@example.test", "owner", false],
        ["admin@example.test", "admin", true],
        ["operator@example.test", "operator", false],
      ]),
    );
    expect(result.data.members.every((m) => m.joinedAt > 0)).toBe(true);
    const [invitation] = result.data.invitations;
    expect(invitation).toMatchObject({ email: "new@example.test", role: "viewer", inviterName: "admin", expired: false });
    // Invitations last 7 days, not Better Auth's default 48 hours.
    const week = 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(invitation!.expiresAt - (Date.now() + week))).toBeLessThan(60_000);
  });

  test("an expired invitation says so, and another workspace's never shows", async () => {
    const ws = await workspace();
    ws.as("owner");
    await inviteMember({ data: { email: "late@example.test", role: "viewer", organizationId: ws.org.id } });
    ws.db.query("UPDATE invitation SET expiresAt = ? WHERE email = ?").run(Date.now() - 1000, "late@example.test");
    const result = await listWorkspaceMembers();
    if (!result.ok) throw new Error(result.error);
    expect(result.data.invitations.map((i) => [i.email, i.expired])).toEqual([["late@example.test", true]]);
    expect(result.data.members.some((m) => m.email === "stranger@example.test")).toBe(false);
  });
});

describe("owners", () => {
  test("an admin cannot change or remove an owner", async () => {
    const ws = await workspace();
    ws.as("admin");
    const protectedCopy = copy.MEMBERS_COPY[copy.OWNER_PROTECTED];
    expect(await updateMemberRole({ data: { memberId: ws.memberOf("owner"), role: "viewer" } })).toEqual({
      ok: false,
      error: protectedCopy!,
    });
    expect(await removeMember({ data: { memberId: ws.memberOf("owner") } })).toEqual({ ok: false, error: protectedCopy! });
  });

  test("the last owner cannot be demoted or removed, by themselves either", async () => {
    const ws = await workspace();
    ws.as("owner");
    const last = { ok: false, error: copy.MEMBERS_COPY[copy.LAST_OWNER]! };
    expect(await updateMemberRole({ data: { memberId: ws.memberOf("owner"), role: "admin" } })).toEqual(last);
    expect(await removeMember({ data: { memberId: ws.memberOf("owner") } })).toEqual(last);
  });

  test("with a second owner, an owner may remove the other", async () => {
    const ws = await workspace();
    ws.db.query("UPDATE member SET role = 'owner' WHERE id = ?").run(ws.memberOf("admin"));
    ws.as("owner");
    expect(await removeMember({ data: { memberId: ws.memberOf("admin") } })).toEqual({ ok: true });
  });
});

describe("failure copy", () => {
  test("already a member and already invited each have their own sentence", async () => {
    const ws = await workspace();
    ws.as("owner");
    expect(await inviteMember({ data: { email: "operator@example.test", role: "viewer", organizationId: ws.org.id } })).toEqual({
      ok: false,
      error: copy.MEMBERS_COPY.USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION!,
    });
    await inviteMember({ data: { email: "twice@example.test", role: "viewer", organizationId: ws.org.id } });
    expect(await inviteMember({ data: { email: "twice@example.test", role: "viewer", organizationId: ws.org.id } })).toEqual({
      ok: false,
      error: copy.MEMBERS_COPY.USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION!,
    });
  });

  test("an id from another workspace reads exactly like one that does not exist", async () => {
    const ws = await workspace();
    ws.as("owner");
    const gone = { ok: false, error: copy.INVITATION_GONE, gone: true };
    expect(await cancelInvitation({ data: { invitationId: ws.foreignInvitation } })).toEqual(gone);
    expect(await cancelInvitation({ data: { invitationId: "no-such-invitation" } })).toEqual(gone);
    expect(await resendInvitation({ data: { invitationId: ws.foreignInvitation } })).toEqual(gone);

    const memberGone = { ok: false, error: copy.MEMBER_GONE, gone: true };
    expect(await removeMember({ data: { memberId: ws.foreignMember } })).toEqual(memberGone);
    expect(await removeMember({ data: { memberId: "no-such-member" } })).toEqual(memberGone);
    expect(await updateMemberRole({ data: { memberId: ws.foreignMember, role: "viewer" } })).toEqual(memberGone);
    // And the other workspace is untouched.
    expect(ws.db.query("SELECT status FROM invitation WHERE id = ?").get(ws.foreignInvitation)).toEqual({ status: "pending" });
  });

  test("anything unrecognised is the retry line, never the provider's text", async () => {
    const ws = await workspace();
    ws.as("owner");
    await ws.invite("doomed@example.test");
    const invitationId = ws.pending()[0]!.id;
    ws.db.run("ALTER TABLE invitation RENAME TO invitation_gone");
    expect(await cancelInvitation({ data: { invitationId } })).toEqual({ ok: false, error: copy.MEMBERS_RETRY });
  });
});

describe("resend", () => {
  test("cancels the invitation and sends a new one under a new id", async () => {
    const ws = await workspace();
    ws.as("owner");
    await inviteMember({ data: { email: "again@example.test", role: "operator", organizationId: ws.org.id } });
    const before = ws.pending()[0]!;
    expect(await resendInvitation({ data: { invitationId: before.id } })).toEqual({ ok: true });
    const after = ws.pending();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(before.id);
    expect(after[0]).toMatchObject({ email: "again@example.test", role: "operator" });
    expect(ws.db.query("SELECT status FROM invitation WHERE id = ?").get(before.id)).toEqual({ status: "canceled" });
  });
});

describe("audit", () => {
  test("each mutation writes one ids-only line", async () => {
    const ws = await workspace();
    ws.as("owner");
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      await inviteMember({ data: { email: "audited@example.test", role: "viewer", organizationId: ws.org.id } });
      await removeMember({ data: { memberId: ws.memberOf("viewer") } });
      const lines = info.mock.calls
        .map(([line]) => JSON.parse(String(line)) as { area?: string; action?: string; outcome?: string })
        .filter((line) => line.area === "audit");
      expect(lines.map((line) => [line.action, line.outcome])).toEqual([
        ["member_invited", "success"],
        ["member_removed", "success"],
      ]);
      expect(JSON.stringify(lines)).not.toContain("@");
    } finally {
      info.mockRestore();
    }
  });
});

describe("the invitation rate limit", () => {
  // The HTTP route is blocked in src/server.ts; calling auth.handler directly
  // shows the hook still holds the cap if it were ever served again.
  test("caps sends per inviter, in the plugin's hook", async () => {
    const ws = await workspace();
    ws.as("owner");
    for (let i = 0; i < 20; i++) {
      expect(await ws.invite(`person${i}@example.test`)).toEqual({ ok: true });
    }
    expect(await inviteMember({ data: { email: "one-more@example.test", role: "viewer", organizationId: ws.org.id } })).toEqual({
      ok: false,
      error: copy.MEMBERS_COPY[copy.INVITATION_RATE_LIMITED]!,
    });
    const direct = await ws.auth.handler(
      new Request(`${BASE_URL}/api/auth/organization/invite-member`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL, cookie: fakeRequestHeaders.get("cookie")! },
        body: JSON.stringify({ email: "direct@example.test", role: "viewer", organizationId: ws.org.id }),
      }),
    );
    expect(direct.status).toBe(429);
    expect(ws.pending()).toHaveLength(20);

    // The cap is the inviter's, not the workspace's.
    ws.as("admin");
    expect(await inviteMember({ data: { email: "from-admin@example.test", role: "viewer", organizationId: ws.org.id } })).toEqual({ ok: true });
  });
});

describe("resend never leaves the invitee without a live invitation", () => {
  test("at the rate limit it refuses before cancelling", async () => {
    const ws = await workspace();
    ws.as("owner");
    for (let i = 0; i < 20; i++) await ws.invite(`person${i}@example.test`);
    const before = ws.pending().map((row) => row.id).sort();
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await resendInvitation({ data: { invitationId: before[0]! } })).toEqual({
        ok: false,
        error: copy.MEMBERS_COPY[copy.INVITATION_RATE_LIMITED]!,
      });
      const audit = info.mock.calls.map(([line]) => JSON.parse(String(line))).find((line) => line.area === "audit");
      expect(audit).toMatchObject({ action: "invitation_resent", outcome: "failed", detail: copy.INVITATION_RATE_LIMITED });
      expect(audit.resource.restored).toBeUndefined();
    } finally {
      info.mockRestore();
    }
    expect(ws.pending().map((row) => row.id).sort()).toEqual(before);
  });

  test("a create that still fails puts the old invitation back, and the audit says so", async () => {
    const ws = await workspace();
    ws.as("owner");
    await ws.invite("joined-meanwhile@example.test");
    const old = ws.pending()[0]!;
    // They joined by another route while the invitation was out: the new create is refused.
    const userId = await ws.user("joined-meanwhile@example.test");
    await ws.auth.api.addMember({ body: { userId, role: "viewer", organizationId: ws.org.id } });
    ws.as("owner");
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await resendInvitation({ data: { invitationId: old.id } })).toEqual({
        ok: false,
        error: copy.MEMBERS_COPY.USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION!,
      });
      const audit = info.mock.calls.map(([line]) => JSON.parse(String(line))).find((line) => line.area === "audit");
      expect(audit).toMatchObject({ action: "invitation_resent", outcome: "failed", resource: { restored: "true" } });
    } finally {
      info.mockRestore();
    }
    expect(ws.pending().map((row) => row.id)).toEqual([old.id]);
  });
});

describe("pending invitations are read by status, not filtered from a capped list", () => {
  test("past 100 cancelled rows the live one still lists, cancels and resends", async () => {
    const ws = await workspace();
    ws.as("owner");
    await ws.invite("live@example.test");
    const live = ws.pending()[0]!.id;
    const columns = (ws.db.query("PRAGMA table_info(invitation)").all() as Array<{ name: string }>).map((c) => `"${c.name}"`);
    const copied = columns.map((c) => (c === '"id"' ? "?1" : c === '"email"' ? "?2" : c === '"status"' ? "'canceled'" : c));
    const insert = ws.db.query(
      `INSERT INTO invitation (${columns.join(", ")}) SELECT ${copied.join(", ")} FROM invitation WHERE id = ?3`,
    );
    for (let i = 0; i < 150; i++) insert.run(`old-${i}`, `old${i}@example.test`, live);

    const result = await listWorkspaceMembers();
    if (!result.ok) throw new Error(result.error);
    expect(result.data.invitations.map((i) => i.id)).toEqual([live]);
    expect(await resendInvitation({ data: { invitationId: live } })).toEqual({ ok: true });
    const fresh = ws.pending()[0]!.id;
    expect(await cancelInvitation({ data: { invitationId: fresh } })).toEqual({ ok: true });
  });
});

describe("the page's workspace", () => {
  test("an invitation for a workspace the session has left is refused", async () => {
    const ws = await workspace();
    ws.as("owner");
    const otherWorkspace = ws.db.query("SELECT id FROM organization WHERE id != ?").get(ws.org.id) as { id: string };
    expect(
      await inviteMember({ data: { email: "new@example.test", role: "viewer", organizationId: otherWorkspace.id } }),
    ).toEqual({ ok: false, error: "You switched workspace in another tab. Reload this page." });
    expect(ws.pending()).toEqual([]);
  });

  test("a session in two workspaces with none chosen is asked to choose, not told to ask an admin", async () => {
    const ws = await workspace();
    const userId = await ws.user("double@example.test");
    const other = ws.db.query("SELECT id FROM organization WHERE id != ?").get(ws.org.id) as { id: string };
    await ws.auth.api.addMember({ body: { userId, role: "admin", organizationId: ws.org.id } });
    await ws.auth.api.addMember({ body: { userId, role: "admin", organizationId: other.id } });
    ws.as("double@example.test");
    expect(await listWorkspaceMembers()).toMatchObject({ ok: false, kind: "forbidden", reason: "select-organization" });
    const refused = await removeMember({ data: { memberId: ws.memberOf("viewer") } });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error).toContain("Pick the one you want to work in.");
  });
});

describe("removing a member", () => {
  test("cancels the invitations they sent, in the same operation, and audits how many", async () => {
    const ws = await workspace();
    ws.as("admin");
    await ws.invite("from-admin-1@example.test");
    await ws.invite("from-admin-2@example.test");
    ws.as("owner");
    await ws.invite("from-owner@example.test");
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await removeMember({ data: { memberId: ws.memberOf("admin") } })).toEqual({ ok: true });
      const audit = info.mock.calls.map(([line]) => JSON.parse(String(line))).find((line) => line.area === "audit");
      expect(audit).toMatchObject({ action: "member_removed", outcome: "success", resource: { invitationsCanceled: "2" } });
    } finally {
      info.mockRestore();
    }
    expect(ws.pending().map((row) => row.email)).toEqual(["from-owner@example.test"]);
  });
});

describe("invitation writes are conditional on the status they expect", () => {
  test("an invitation accepted in the meantime is not cancelled", async () => {
    const ws = await workspace();
    ws.as("owner");
    await ws.invite("quick@example.test");
    const id = ws.pending()[0]!.id;
    ws.db.query("UPDATE invitation SET status = 'accepted' WHERE id = ?").run(id);
    expect(await cancelInvitation({ data: { invitationId: id } })).toEqual({
      ok: false,
      error: copy.INVITATION_GONE,
      gone: true,
    });
    expect(ws.db.query("SELECT status FROM invitation WHERE id = ?").get(id)).toEqual({ status: "accepted" });
  });

  test("two resends of the same row leave exactly one live invitation", async () => {
    const ws = await workspace();
    ws.as("owner");
    await ws.invite("twice@example.test");
    const id = ws.pending()[0]!.id;
    const results = await Promise.all([
      resendInvitation({ data: { invitationId: id } }),
      resendInvitation({ data: { invitationId: id } }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: copy.INVITATION_GONE, gone: true }]);
    expect(ws.pending()).toHaveLength(1);
  });
});

describe("step-up", () => {
  test("every write is refused until the caller has stepped up, and nothing lands", async () => {
    const ws = await workspace();
    ws.as("owner");
    await ws.invite("pending@example.test");
    const invitationId = ws.pending()[0]!.id;
    const snapshot = () => ({
      invitations: ws.db.query("SELECT id, status FROM invitation WHERE organizationId = ? ORDER BY id").all(ws.org.id),
      members: ws.db.query("SELECT id, role FROM member WHERE organizationId = ? ORDER BY id").all(ws.org.id),
    });
    const before = snapshot();
    const writes = [
      () => ws.invite("new@example.test"),
      () => resendInvitation({ data: { invitationId } }),
      () => cancelInvitation({ data: { invitationId } }),
      () => updateMemberRole({ data: { memberId: ws.memberOf("operator"), role: "viewer" } }),
      () => removeMember({ data: { memberId: ws.memberOf("viewer") } }),
    ];

    // Enrolled, but the second factor was proved too long ago (or never, on this session).
    ws.db.query('UPDATE session SET "stepUpAt" = NULL').run();
    for (const write of writes) expect(await write()).toMatchObject({ ok: false, reason: "reauth-required" });
    // Not enrolled at all. The reason is what `withStepUp` acts on.
    ws.db.query('UPDATE user SET "twoFactorEnabled" = 0').run();
    for (const write of writes) expect(await write()).toMatchObject({ ok: false, reason: "totp-required" });
    expect(snapshot()).toEqual(before);

    // Reading the page is not a step-up row.
    expect((await listWorkspaceMembers()).ok).toBe(true);

    enrollTotp(ws.db, "owner@example.test");
    for (const write of [writes[0]!, writes[3]!, writes[4]!, writes[1]!]) expect(await write()).toEqual({ ok: true });
  });

  test("a role that may not manage members is told that, never asked for a second factor", async () => {
    const ws = await workspace();
    ws.db.query('UPDATE user SET "twoFactorEnabled" = 0').run();
    ws.as("operator");
    expect(await ws.invite("new@example.test")).toEqual({ ok: false, error: copy.ASK_TO_MANAGE_MEMBERS });
  });
});

describe("the pending list", () => {
  test("is newest first, so old expired rows never crowd out a live one", async () => {
    const ws = await workspace();
    ws.as("owner");
    await ws.invite("template@example.test");
    const template = ws.pending()[0]!.id;
    const columns = (ws.db.query("PRAGMA table_info(invitation)").all() as Array<{ name: string }>).map((c) => `"${c.name}"`);
    const copied = columns.map((c) =>
      c === '"id"' ? "?1" : c === '"email"' ? "?2" : c === '"createdAt"' ? "0" : c === '"expiresAt"' ? "1" : c,
    );
    const insert = ws.db.query(
      `INSERT INTO invitation (${columns.join(", ")}) SELECT ${copied.join(", ")} FROM invitation WHERE id = ?3`,
    );
    for (let i = 0; i < 120; i++) insert.run(`stale-${i}`, `stale${i}@example.test`, template);
    await ws.invite("fresh@example.test");

    const result = await listWorkspaceMembers();
    if (!result.ok) throw new Error(result.error);
    expect(result.data.invitations[0]!.email).toBe("fresh@example.test");
  });
});
