import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

// No session: a read that reached the server function would fail closed with
// its own copy, so the "cannot be opened" answers below never left the loader.
installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { InvitationsView, loadInvitation } = await import("../src/routes/invitations");
const { signUpHref } = await import("../src/auth/redirect-target");
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
      onRetry={() => {}}
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
    const html = render({ invitation: { ok: false, kind: "unavailable", error: "This invitation is not available." } });
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

  test("a transient failure offers Try again and does not say the invitation cannot be opened", () => {
    const html = render({ invitation: { ok: false, kind: "retry", error: "Something went wrong." } });
    expect(html).toContain("This invitation could not be loaded");
    expect(html).toContain("Try again</button>");
    expect(html).not.toContain("cannot be opened");
    expect(html).not.toContain("Accept invitation</button>");
  });

  test("an already accepted invitation offers the workspace, not a second accept", () => {
    const html = render({ invitation: { ok: true, data: { organizationName: "NACEX 2801", joined: true } } });
    expect(html).toContain("You already joined NACEX 2801");
    expect(html).toContain("Open workspace</button>");
    expect(html).not.toContain("Accept invitation</button>");
  });

  test("with no workspace the bare page says who is signed in and offers both ways out", () => {
    const html = render({
      invitation: { ok: false, kind: "unavailable", error: "nope" },
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
  const read = (answer: unknown) => (async () => answer) as unknown as Parameters<typeof loadInvitation>[1];
  const throws = (err: unknown) =>
    (async () => {
      throw err;
    }) as unknown as Parameters<typeof loadInvitation>[1];

  test("no id is no invitation; an id the validator would refuse cannot be opened", async () => {
    expect(await loadInvitation(undefined)).toBeNull();
    for (const id of ["", "   ", "x".repeat(257)]) {
      const invitation = await loadInvitation(id, throws(new Error("must not read")));
      expect(invitation).toEqual({
        ok: false,
        kind: "unavailable",
        error: "This link is incomplete. Open it again from your invitation email.",
      });
      expect(render({ invitation })).toContain("This invitation cannot be opened");
    }
  });

  test("a read that throws is transient, with the page's own copy", async () => {
    expect(await loadInvitation("inv_1", throws(new Error("fetch failed")))).toEqual({
      ok: false,
      kind: "retry",
      error: "Something went wrong with this invitation. Please try again.",
    });
  });

  test("a lapsed session goes to sign-in and comes back to this invitation", async () => {
    const thrown = await loadInvitation("inv 1", read({ ok: false, kind: "signed-out", error: "" })).catch((e) => e);
    expect(thrown.options).toMatchObject({
      href: "/signin?redirect=%2Finvitations%3Fid%3Dinv%25201",
      reloadDocument: true,
    });
  });
});

describe("sign-up from an invitation link", () => {
  test("the route keeps a console page as the redirect and drops anything else", () => {
    expect(signupSearch({ redirect: "/invitations?id=inv_1" })).toEqual({ redirect: "/invitations?id=inv_1" });
    expect(signupSearch({ redirect: "https://evil.test/" })).toEqual({});
    expect(signupSearch({})).toEqual({});
  });

  test("sign-in hands its redirect to sign-up only when it is a console page", () => {
    expect(signUpHref("/invitations?id=inv_1")).toBe("/signup?redirect=%2Finvitations%3Fid%3Dinv_1");
    expect(signUpHref("//evil.test")).toBe("/signup");
    expect(signUpHref(undefined)).toBe("/signup");
  });

  test("the way back to sign-in keeps the invitation", () => {
    const html = renderToStaticMarkup(<SignUpView redirectTo="/invitations?id=inv_1" />);
    expect(html).toContain('href="/signin?redirect=%2Finvitations%3Fid%3Dinv_1"');
    expect(renderToStaticMarkup(<SignUpView />)).toContain('href="/signin"');
  });
});
