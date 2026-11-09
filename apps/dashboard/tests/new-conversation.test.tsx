import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * The inbox's "New conversation" entry. The sheet it opens is closed on first
 * render, so only the entry point is pinned here. The send-to-thread path is
 * not covered by an automated test: its DOM case passed alone and failed in
 * the full suite, as the sheet's portal did not open once other files had run.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const routerModule = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  useNavigate: () => () => Promise.resolve(),
  useRouter: () => ({ invalidate: async () => {} }),
}));

const { NewConversation } = await import("../src/components/conversations/new-conversation");

const PHONES = [{ phoneNumberId: "PNID1", displayPhoneNumber: "+34600000000" }];

describe("NewConversation", () => {
  test("renders nothing without a number to send from", () => {
    expect(
      renderToStaticMarkup(<NewConversation wabaId="waba-a" linkWabaId={null} phones={[]} />),
    ).toBe("");
  });

  test("renders the entry button, square-cornered, when a number exists", () => {
    const html = renderToStaticMarkup(
      <NewConversation wabaId="waba-a" linkWabaId={null} phones={PHONES} />,
    );
    expect(html).toContain("New conversation");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*class="[^"]*rounded-none/);
    expect(html).not.toContain("rounded-md");
  });
});
