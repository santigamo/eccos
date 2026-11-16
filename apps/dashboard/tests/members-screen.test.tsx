import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import type { MembersPage } from "../src/members";

/** The /members screen, rendered through the router-free `MembersView`. */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { MembersView } = await import("../src/routes/members");
const { InviteMemberForm } = await import("../src/components/dashboard/invite-member-sheet");
const { removeMemberCopy } = await import("../src/components/dashboard/remove-member-dialog");
const { ASK_TO_MANAGE_MEMBERS } = await import("../src/lib/members-copy");

const PAGE: MembersPage = {
  callerRole: "admin",
  members: [
    { memberId: "m1", name: "Olga", email: "olga@example.test", role: "owner", joinedAt: 1_700_000_000_000, isSelf: false },
    { memberId: "m2", name: "Ana", email: "ana@example.test", role: "admin", joinedAt: 1_700_000_000_000, isSelf: true },
    { memberId: "m3", name: "Pau", email: "pau@example.test", role: "operator", joinedAt: 1_700_000_000_000, isSelf: false },
  ],
  invitations: [
    { id: "i1", email: "new@example.test", role: "viewer", inviterName: "Ana", expiresAt: 1_700_000_000_000, expired: true },
  ],
};

describe("MembersView for an admin", () => {
  const html = renderToStaticMarkup(<MembersView page={PAGE} />);

  test("offers the invite as the page's action", () => {
    expect(html).toContain("Invite member");
  });

  test("lists members, tags the caller's row and leaves it alone", () => {
    for (const email of ["olga@example.test", "ana@example.test", "pau@example.test"]) expect(html).toContain(email);
    expect(html).toContain(">You<");
    // One role select, on the operator's row: never the caller's, never an owner's.
    expect(html.match(/aria-label="Role of /g)).toHaveLength(1);
    expect(html).toContain('aria-label="Role of Pau"');
    // An admin cannot remove the owner, nor themselves: Remove only on the operator.
    expect(html.match(/>Remove</g)).toHaveLength(1);
  });

  test("lists pending invitations, an expired one saying so", () => {
    expect(html).toContain("new@example.test");
    expect(html).toContain("Expired");
    expect(html).toContain('aria-label="Actions for the invitation to new@example.test"');
  });

  test("an owner may remove another owner", () => {
    const owners: MembersPage = {
      ...PAGE,
      callerRole: "owner",
      members: PAGE.members.map((m) => (m.memberId === "m2" ? { ...m, role: "owner" } : m)),
    };
    expect(renderToStaticMarkup(<MembersView page={owners} />).match(/>Remove</g)).toHaveLength(2);
  });

  test("with no pending invitations, says what an invitation does", () => {
    const empty = renderToStaticMarkup(<MembersView page={{ ...PAGE, invitations: [] }} />);
    expect(empty).toContain("No pending invitations");
    expect(empty).toContain("An invitation emails a link to join this workspace");
  });
});

describe("MembersView for an operator", () => {
  const html = renderToStaticMarkup(<MembersView error={ASK_TO_MANAGE_MEMBERS} />);

  test("one line pointing at an owner or admin, and no controls", () => {
    expect(html).toContain("Ask an owner or admin of this workspace to manage members.");
    expect(html).not.toContain("Invite member");
    expect(html).not.toContain("<table");
  });
});

describe("the invite form", () => {
  const html = renderToStaticMarkup(<InviteMemberForm />);

  test("three roles, each with its one plain line, and no owner", () => {
    expect(html).toContain("Manages numbers, API keys, billing and members.");
    expect(html).toContain("Reads and replies to conversations.");
    expect(html).toContain("Reads only.");
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).not.toContain('value="owner"');
    expect(html).toContain("Send invitation");
  });
});

describe("removing a member states the cost", () => {
  test("for everyone: access ends, their API keys keep working", () => {
    expect(removeMemberCopy("operator")).toEqual([
      "Their access ends on their next request.",
      "API keys they created keep working. Revoke them in Settings if they should stop.",
    ]);
  });

  test("for an admin, their connection link stops too", () => {
    expect(removeMemberCopy("admin")).toContain("The connection link they made stops working.");
  });
});
