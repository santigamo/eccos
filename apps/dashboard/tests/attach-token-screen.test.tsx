import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The unlisted pasted-token route (`routes/numbers_.attach-token.tsx`).
 *
 * The panel itself has its own suite (`tests/connect-token-form.test.tsx`);
 * what is pinned here is the ROUTE — that it exists, that it says where you
 * are, and that it carries the panel that used to live on /settings. The
 * "is it unlisted?" half is asserted where the two structures meet, in
 * `tests/scope-requirements.test.ts`: reachable in `SCOPE_REQUIREMENTS`, absent
 * from `NAV_MAIN`, and that asymmetry is the decision rather than a drift.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { AttachTokenPage } = await import("../src/routes/numbers_.attach-token");

const html = renderToStaticMarkup(<AttachTokenPage />);

describe("the attach-by-token route", () => {
  test("has a real header band, because nobody arrives here from a link", () => {
    // Every other route opens with a kicker over a heading. This one needs it
    // more than any of them: there is no nav entry highlighting it and no
    // sentence that sent you, so a bare form would be a credential field on an
    // unexplained page.
    expect(html).toContain("Connection");
    expect(html).toContain("Attach by token");
    expect(html).toContain("hatch-band");
  });

  test("carries the token panel, with its precondition intact", () => {
    // MOVED FROM `settings-screen.test.tsx`. The honesty mitigation travels
    // with the panel: it states up front that only this deployment's own Meta
    // app can be introspected, and names Embedded Signup as the path that works
    // for a business. Being unlisted does not excuse it from saying so —
    // anyone who has the URL still deserves the refusal in advance.
    expect(html).toContain("Meta access token");
    expect(html).toContain("own Meta app");
    expect(html).toContain("Connect with Meta");
    expect(html).toContain('type="password"');
  });

  test("keeps the two laws: square corners, machine-voice labels", () => {
    const stripped = html
      .replace(/rounded-none/g, "")
      .replace(/rounded-\([^)]*\)/g, "")
      .replace(/rounded-\[[^\]]*\]/g, "");
    expect(stripped).not.toMatch(/rounded-/);
    expect(html).toContain("text-[11px] font-medium tracking-wider text-muted-foreground uppercase");
  });

  test("spends no primary: the page's only control is the ghost submit", () => {
    // One primary per view, and this view has no action worth the brand glow —
    // an operator who typed this URL is already committed to the one form on
    // the page.
    expect(html).toContain("border-(--line-strong)");
    expect(html).toContain("bg-(--ghost-fill)");
    expect(html).not.toContain("--caustic");
  });
});
