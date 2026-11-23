import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import type { MembersPage } from "../src/members";

/** The /members screen, rendered through the router-free `MembersView`. */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { MembersView } = await import("../src/routes/members");
const { InviteMemberForm, inviteEmailProblem } = await import("../src/components/dashboard/invite-member-sheet");
const { InvitationsTable } = await import("../src/components/dashboard/invitations-table");
const { removeMemberCopy } = await import("../src/components/dashboard/remove-member-dialog");
const { roleChangeCost } = await import("../src/components/dashboard/change-role-dialog");
const { expiresIn } = await import("../src/lib/invitation-expiry");
const { RoleChoices } = await import("../src/components/dashboard/role-choices");
const { roleInSentence } = await import("../src/lib/member-roles");

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const PAGE: MembersPage = {
  organizationId: "org-a",
  callerRole: "admin",
  members: [
    { memberId: "m1", name: "Olga", email: "olga@example.test", role: "owner", joinedAt: NOW, isSelf: false },
    { memberId: "m2", name: "Ana", email: "ana@example.test", role: "admin", joinedAt: NOW, isSelf: true },
    { memberId: "m3", name: "Pau", email: "pau@example.test", role: "operator", joinedAt: NOW, isSelf: false },
  ],
  invitations: [
    { id: "i1", email: "new@example.test", role: "viewer", inviterName: "Ana", expiresAt: NOW - 1000, expired: true },
  ],
};

describe("MembersView for an admin", () => {
  const html = renderToStaticMarkup(<MembersView page={PAGE} />);

  test("offers the invite as the page's action", () => {
    expect(html).toContain("Invite member");
  });

  test("titles each section with its count, in the title tier", () => {
    expect(html).toMatch(/<h2 class="m-0 text-base font-semibold text-foreground">Members<span[^>]*>3<\/span><\/h2>/);
    expect(html).toMatch(/Pending invitations<span[^>]*>1<\/span>/);
  });

  test("a member is a name over an email, the role a tag, the caller's row tagged and left alone", () => {
    expect(html).toContain('<span class="text-sm font-medium text-foreground">Pau</span>');
    expect(html).toContain('<span class="block text-xs text-muted-foreground">pau@example.test</span>');
    expect(html).not.toMatch(/font-mono[^"]*">pau@example\.test/);
    expect(html).toContain(">Operator<");
    expect(html).toContain(">You<");
    // One kebab, on the operator: never the caller's row, never an owner's for an admin.
    expect(html.match(/aria-label="Actions for /g)).toHaveLength(2);
    expect(html).toContain('aria-label="Actions for Pau"');
    expect(html).not.toContain('aria-label="Actions for Olga"');
    expect(html).not.toContain('aria-label="Actions for Ana"');
  });

  test("an owner gets a kebab on another owner, to remove", () => {
    const owners: MembersPage = {
      ...PAGE,
      callerRole: "owner",
      members: PAGE.members.map((m) => (m.memberId === "m2" ? { ...m, role: "owner" } : m)),
    };
    expect(renderToStaticMarkup(<MembersView page={owners} />)).toContain('aria-label="Actions for Olga"');
  });

  test("with no pending invitations, says what an invitation does", () => {
    const empty = renderToStaticMarkup(<MembersView page={{ ...PAGE, invitations: [] }} />);
    expect(empty).toContain("No pending invitations");
    expect(empty).toContain("An invitation emails a link to join this workspace");
    // The live region is mounted here too, for the failure of the last row's act.
    expect(empty).toContain('aria-live="polite"');
  });
});

describe("pending invitations", () => {
  const live = { ...PAGE.invitations[0]!, expiresAt: NOW + 7 * DAY, expired: false };
  const html = renderToStaticMarkup(
    <InvitationsTable invitations={[live, PAGE.invitations[0]!]} onChanged={() => {}} now={NOW} />,
  );

  test("expiry leads with words and keeps the exact time under them", () => {
    expect(html).toContain(">in 7 days<");
    expect(html).toContain(">Expired<");
    expect(html).toContain('<span class="block font-mono text-xs text-muted-foreground">2023-11-21 22:13:20 UTC</span>');
  });

  test("Resend and Cancel share one kebab per row", () => {
    expect(html.match(/aria-label="Actions for the invitation to new@example.test"/g)).toHaveLength(2);
  });
});

describe("MembersView when the read is refused", () => {
  test("a role without administer gets the role refusal, with no controls", () => {
    const html = renderToStaticMarkup(
      <MembersView failure={{ ok: false, kind: "forbidden", reason: "missing-permission", error: "x" }} />,
    );
    expect(html).toContain("Not available to your role");
    expect(html).toContain("Ask an owner or an admin");
    expect(html).not.toContain("Invite member");
    expect(html).not.toContain("<table");
  });

  test("no workspace chosen asks for the choice, not for an admin", () => {
    const html = renderToStaticMarkup(
      <MembersView
        failure={{
          ok: false,
          kind: "forbidden",
          reason: "select-organization",
          error: "x",
          organizations: [{ id: "o1", name: "Agency" }],
        }}
      />,
    );
    expect(html).toContain("Choose a workspace");
    expect(html).toContain("Agency");
  });

  test("signed out offers the way back in", () => {
    const html = renderToStaticMarkup(<MembersView failure={{ ok: false, kind: "unauthenticated", error: "x" }} />);
    expect(html).toContain('href="/signin"');
  });
});

describe("the invite form", () => {
  const html = renderToStaticMarkup(<InviteMemberForm organizationId="org-a" />);

  test("three roles, each with its one plain line, and no owner", () => {
    expect(html).toContain("Manages numbers, API keys, billing and members.");
    expect(html).toContain("Reads and replies to conversations.");
    expect(html).toContain("Reads only.");
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).not.toContain('value="owner"');
    expect(html).toContain("Send invitation");
  });
});

describe("the change-role dialog's reading", () => {
  test("the current role is a label with its article, never the raw id", () => {
    expect(roleInSentence("viewer")).toBe("a Viewer");
    expect(roleInSentence("admin")).toBe("an Admin");
    expect(roleInSentence("operator")).toBe("an Operator");
  });

  test("the member's current role is tagged among the options, and only it", () => {
    const html = renderToStaticMarkup(<RoleChoices name="r" value={null} current="operator" onChange={() => {}} />);
    expect(html.match(/>Current</g)).toHaveLength(1);
    expect(html).toMatch(/>Operator<\/span><span class="[^"]*uppercase">Current</);
  });
});

describe("the invite form's email rule is the server's", () => {
  test("an address without a domain suffix is refused in the form", () => {
    expect(inviteEmailProblem("ana@empresa")).toBe("Enter a full email address, like name@company.com.");
    expect(inviteEmailProblem("ana@empresa.com")).toBeNull();
    expect(inviteEmailProblem("")).toBeNull();
  });
});

describe("a role change states its cost", () => {
  test("demoting an admin ends their management and their connection link", () => {
    expect(roleChangeCost("admin", "operator")).toContain("connection link they made stops working");
    expect(roleChangeCost("admin", "viewer")).toContain("connection link they made stops working");
  });

  test("granting admin says what it grants", () => {
    expect(roleChangeCost("viewer", "admin")).toBe("They will manage numbers, API keys, billing and members.");
  });

  test("between operator and viewer there is nothing to warn about", () => {
    expect(roleChangeCost("operator", "viewer")).toBeNull();
    expect(roleChangeCost("operator", "operator")).toBeNull();
  });
});

describe("removing a member states the cost", () => {
  test("for everyone: access ends, their API keys keep working", () => {
    expect(removeMemberCopy("operator")).toEqual([
      "Their access ends on their next request.",
      "API keys they created keep working. Revoke them in API keys if they should stop.",
      "Invitations they sent that are still pending are cancelled.",
    ]);
  });

  test("for an admin, their connection link stops too", () => {
    expect(removeMemberCopy("admin")).toContain("The connection link they made stops working.");
  });
});

describe("expiresIn", () => {
  test("days, then hours, then minutes, then expired", () => {
    expect(expiresIn(NOW + 7 * DAY, NOW)).toBe("in 7 days");
    expect(expiresIn(NOW + DAY, NOW)).toBe("in 1 day");
    expect(expiresIn(NOW + 5 * 60 * 60 * 1000, NOW)).toBe("in 5 h");
    expect(expiresIn(NOW + 10 * 1000, NOW)).toBe("in 1 min");
    expect(expiresIn(NOW, NOW)).toBe("Expired");
  });
});
