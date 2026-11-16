import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { InvitationsView } = await import("../src/routes/invitations");

type Props = Parameters<typeof InvitationsView>[0];
const render = (props: Partial<Props>) =>
  renderToStaticMarkup(
    <InvitationsView invitation={null} error={null} pending={false} onAccept={() => {}} {...props} />,
  );

describe("invitations screen", () => {
  test("names the workspace being joined", () => {
    const html = render({ invitation: { ok: true, data: { organizationName: "NACEX 2801" } } });
    expect(html).toContain("Join NACEX 2801");
    expect(html).toContain("Accept invitation</button>");
  });

  test("an invitation that cannot be read shows its copy and no Accept button", () => {
    const html = render({ invitation: { ok: false, error: "This invitation is not available." } });
    expect(html).toContain("This invitation is not available.");
    expect(html).not.toContain("<button");
  });

  test("a link with no invitation id offers nothing to accept", () => {
    const html = render({});
    expect(html).toContain("No invitation in this link");
    expect(html).not.toContain("<button");
  });

  test("a failed accept keeps the workspace name and shows the server's copy", () => {
    const html = render({
      invitation: { ok: true, data: { organizationName: "NACEX 2801" } },
      error: "Verify your email address, then open the invitation link again.",
    });
    expect(html).toContain("Join NACEX 2801");
    expect(html).toContain("Verify your email address");
  });
});
