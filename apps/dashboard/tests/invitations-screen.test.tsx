import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

// No session: a read that reached the server function would fail closed with
// its own copy, so the "cannot be opened" answers below never left the loader.
installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { InvitationsView, loadInvitation } = await import("../src/routes/invitations");
const { SignUpView } = await import("../src/components/blocks/auth-13/signup-view");
const { signupSearch } = await import("../src/routes/signup");

type Props = Parameters<typeof InvitationsView>[0];
const render = (props: Partial<Props>) =>
  renderToStaticMarkup(
    <InvitationsView
      invitation={null}
      error={null}
      pending={false}
      onAccept={() => {}}
      signedInAs={null}
      hasWorkspace
      signingOut={false}
      onSignOut={() => {}}
      {...props}
    />,
  );
const open = { ok: true as const, data: { organizationName: "NACEX 2801", joined: false } };

describe("invitations screen", () => {
  test("names the workspace being joined", () => {
    const html = render({ invitation: open });
    expect(html).toContain("Join NACEX 2801");
    expect(html).toContain("Accept invitation</button>");
  });

  test("an invitation that cannot be read shows its copy and no Accept button", () => {
    const html = render({ invitation: { ok: false, error: "This invitation is not available." } });
    expect(html).toContain("This invitation cannot be opened");
    expect(html).toContain("This invitation is not available.");
    expect(html).not.toContain("<button");
  });

  test("a link with no invitation id offers nothing to accept", () => {
    const html = render({});
    expect(html).toContain("No invitation in this link");
    expect(html).not.toContain("<button");
  });

  test("a failed accept keeps the workspace name and shows the server's copy", () => {
    const html = render({ invitation: open, error: "Verify your email address, then open the invitation link again." });
    expect(html).toContain("Join NACEX 2801");
    expect(html).toContain("Verify your email address");
  });

  test("an already accepted invitation offers the workspace, not a second accept", () => {
    const html = render({ invitation: { ok: true, data: { organizationName: "NACEX 2801", joined: true } } });
    expect(html).toContain("You already joined NACEX 2801");
    expect(html).toContain("Open workspace</button>");
    expect(html).not.toContain("Accept invitation</button>");
  });

  test("with no workspace the bare page says who is signed in and offers both ways out", () => {
    const html = render({
      invitation: { ok: false, error: "nope" },
      signedInAs: "wrong@corp.test",
      hasWorkspace: false,
    });
    expect(html).toContain("Signed in as");
    expect(html).toContain("wrong@corp.test");
    expect(html).toContain("Sign out</button>");
    expect(html).toContain('href="/onboarding"');
    expect(render({ signedInAs: "member@corp.test" })).not.toContain('href="/onboarding"');
  });
});

describe("loadInvitation", () => {
  test("no id is no invitation; an id the validator would refuse cannot be opened", async () => {
    expect(await loadInvitation(undefined)).toBeNull();
    for (const id of ["", "   ", "x".repeat(257)]) {
      const read = await loadInvitation(id);
      expect(read).toEqual({ ok: false, error: "This link is incomplete. Open it again from your invitation email." });
      expect(render({ invitation: read })).toContain("This invitation cannot be opened");
    }
  });
});

describe("sign-up from an invitation link", () => {
  test("the route keeps a console page as the redirect and drops anything else", () => {
    expect(signupSearch({ redirect: "/invitations?id=inv_1" })).toEqual({ redirect: "/invitations?id=inv_1" });
    expect(signupSearch({ redirect: "https://evil.test/" })).toEqual({});
    expect(signupSearch({})).toEqual({});
  });

  test("the way back to sign-in keeps the invitation", () => {
    const html = renderToStaticMarkup(<SignUpView redirectTo="/invitations?id=inv_1" />);
    expect(html).toContain('href="/signin?redirect=%2Finvitations%3Fid%3Dinv_1"');
    expect(renderToStaticMarkup(<SignUpView />)).toContain('href="/signin"');
  });
});
