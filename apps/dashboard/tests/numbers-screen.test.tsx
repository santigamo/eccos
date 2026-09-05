import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Rendering contract for the connect-a-number panel (see
 * `components/dashboard/connect-number.tsx`), which is both the empty state of
 * /numbers on first run and the "add another" action once numbers exist.
 * React's own `react-dom/server` needs no DOM.
 *
 * Importing it pulls in `src/server/gateway.ts`, which imports
 * `cloudflare:workers` (a virtual module that only exists inside the Workers
 * runtime) and `@tanstack/react-start`. The same `mock.module` approach as
 * `tests/gateway.test.ts` is used here, BEFORE importing the real component.
 *
 * Design contract assertions (docs/DASHBOARD-DESIGN.md): square corners, the
 * panel's header/body/footer alignment, and a copy budget.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { CONNECT_FORK_DESCRIPTION, ConnectNumberChoices, ConnectNumberPanel } =
  await import("../src/components/dashboard/connect-number");
const { AddNumberButton } = await import("../src/routes/numbers");

function render(heading = "Meta Embedded Signup"): string {
  return renderToStaticMarkup(<ConnectNumberPanel heading={heading} />);
}

describe("ConnectNumberPanel", () => {
  test("Embedded Signup is the only way in, and it offers exactly two paths", () => {
    // Decided 2026-08-31: connecting a number goes through Embedded Signup. The
    // token path (Cloud API test numbers, eccos-up9) is a separate, later
    // surface. What changed on 2026-09-02 is that Embedded Signup itself forks:
    // `featureType` rides in FB.login's extras, so which onboarding runs is
    // fixed before the popup opens and has to be the customer's choice.
    const html = render();
    expect(html).toContain("Meta Embedded Signup");
    expect(html).toContain("Keep the number on the WhatsApp Business app");
    expect(html).toContain("Bring a number to the Cloud API");
    expect(html).not.toContain("access token");
    expect(html).not.toContain('type="password"');
  });

  test("each path states its own consequence before the operator commits", () => {
    // THE POINT OF THE FORK. Taking the Cloud API path with a number that is
    // live on the WhatsApp Business app removes it from the app, and nothing
    // Meta shows says so. Both consequences are on the cards, not in a doc, and
    // neither may quietly disappear in a copy edit.
    const html = render();
    expect(html).toContain("Removes the number from the WhatsApp Business app");
    expect(html).toContain("Syncs run once");
  });

  test("the heading is the caller's, so first run and add-another differ", () => {
    expect(render("Add another number")).toContain("Add another number");
  });

  test("keeps the panel copy short enough to scan", () => {
    // Reviewed 2026-08-31 at 55 words, when this panel had ONE job and one
    // button. It now presents an irreversible fork, and each path owes the
    // reader a title, a line of detail, and its consequence, which is six
    // pieces of copy that did not exist before. So the budget moved with the
    // job rather than being deleted: 100 words is roughly that content and no
    // prose. If this fails, the fix is almost certainly a sentence that crept
    // back into the description or a card detail, not a seventh piece of copy.
    const html = render();
    const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    expect(text.split(" ").length).toBeLessThan(100);
  });

  test("panels and buttons stay square", () => {
    const html = render();
    // rounded-(--frame-radius) etc. resolve to 0 (app.css pins --radius-*: 0),
    // so they are square by token; exclude token-based utilities.
    const stripped = html
      .replace(/rounded-none/g, "")
      .replace(/rounded-\([^)]*\)/g, "")
      .replace(/rounded-\[[^\]]*\]/g, "");
    expect(stripped).not.toMatch(/rounded-/);
  });

  test("no em dashes in visible UI copy", () => {
    const html = render();
    const visible = html
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<script[\s\S]*?<\/script>/g, "");
    expect(visible).not.toContain("—");
  });

  test("panel header and panel body share a left edge", () => {
    // FrameHeader nested inside FramePanel would otherwise stack both
    // paddings; the panel zeroes its direct header/footer horizontal padding.
    // `&` and `>` arrive HTML-escaped inside the class attribute.
    const html = render();
    expect(html).toContain("[&amp;&gt;[data-slot=frame-panel-header]]:px-0");
  });

  test("the choices ARE the actions, and there is no footer band", () => {
    // The old panel pinned one button in a full-bleed footer. There is no
    // single action left to pin: picking a path launches that path, because
    // there is nothing to configure in between and a confirm step would only
    // add a click before Meta's own multi-screen flow, which is where backing
    // out is still free.
    //
    // The band went with it. A full-width rule plus its -mx chrome for one
    // 12px sentence was another rectangle in a panel that already read as a
    // grid; the sentence stayed, the rule did not.
    const html = render();
    expect(html.match(/<button/g)?.length).toBe(2);
    expect(html).not.toContain("<footer");
    expect(html).toContain("Meta brings you back to this page");
  });

  test("the cards wear interactive anatomy, not structural hairlines", () => {
    // THE REGRESSION THIS SUITE MISSED ONCE. These buttons rested on `--line`
    // (7%, which app.css calls "structural hairlines") with no fill, so the two
    // biggest actions in the product were drawn in the ink of the dividers
    // between them and the affordance existed only on hover. The contract's
    // rule for a ghost control is a `--ghost-fill` body under a `--line-strong`
    // edge, and the landing's own .btn-ghost is built the same way.
    const html = render();
    expect(html).toContain("border-(--line-strong)");
    expect(html).toContain("bg-(--ghost-fill)");
    // The landing signature: the edge turns green under the pointer. The
    // "before shipping" checklist says a screen that looks cleaner but lost a
    // green edge has regressed, so this is pinned rather than assumed.
    expect(html).toContain("hover:border-(--ghost-edge-hover)");
    expect(html).toContain("group-hover:text-primary");
  });
});

describe("AddNumberButton", () => {
  test("closed: the page's primary action in the header", () => {
    // Moved from a ghost disclosure under the table to the `Page` header's
    // action slot: level with the title, top right, and in the primary
    // variant — the view's one solid button. The fork is not in the markup at
    // all until the button opens it.
    const html = renderToStaticMarkup(
      <AddNumberButton expanded={false} onToggle={() => {}} />,
    );
    expect(html).toContain("+ Add number");
    expect(html).toContain("bg-primary");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("Meta Embedded Signup");
  });

  test("open: the trigger STAYS, and says so", () => {
    // It used to render nothing while open, which is the defect this change
    // set started from: with the trigger gone and the panel offering no close,
    // the only ways out of /numbers were Meta's popup or leaving the page.
    // Behind a backdrop a visible trigger asks no "which one do I use?"
    // question, and Base UI needs it to restore focus to on close.
    const html = renderToStaticMarkup(
      <AddNumberButton expanded={true} onToggle={() => {}} />,
    );
    expect(html).toContain("+ Add number");
    expect(html).toContain('aria-expanded="true"');
  });

  test("the button never points at the token route", () => {
    // Hard constraint from numbers.tsx: /numbers/attach-token stays unlinked
    // from this page, so the add-number affordance must not grow an "or
    // attach by token" line in either state.
    const collapsed = renderToStaticMarkup(
      <AddNumberButton expanded={false} onToggle={() => {}} />,
    );
    const expanded = renderToStaticMarkup(
      <AddNumberButton expanded={true} onToggle={() => {}} />,
    );
    expect(collapsed).not.toContain("token");
    expect(expanded).not.toContain("token");
  });
});

describe("ConnectNumberChoices", () => {
  // The fork with no container of its own — what the dialog renders on the
  // populated page, and what `ConnectNumberPanel` frames on first run. Pinned
  // separately so the split cannot quietly become two forks.
  const bare = () => renderToStaticMarkup(<ConnectNumberChoices />);

  test("carries the paths and the consequence, and no frame of its own", () => {
    const html = bare();
    expect(html).toContain("Keep the number on the WhatsApp Business app");
    expect(html).toContain("Bring a number to the Cloud API");
    expect(html).toContain("Removes the number from the WhatsApp Business app");
    // No Frame, no heading: the container supplies both. A bordered glass
    // panel inside a bordered glass dialog is the panel-in-panel this split
    // exists to prevent.
    expect(html).not.toContain("Meta Embedded Signup");
    expect(html).not.toContain("data-slot=\"frame\"");
  });

  test("the framing sentence is shared, not duplicated", () => {
    // Both containers render CONNECT_FORK_DESCRIPTION themselves — the panel
    // in `FrameDescription`, the dialog in `DialogDescription` — so the fork
    // itself must NOT carry it, or first run would show it twice.
    // Compared on a fragment, not the whole constant: the apostrophe in
    // "Meta's" is entity-escaped in the markup.
    const fragment = "The choice locks the moment Meta";
    expect(CONNECT_FORK_DESCRIPTION).toContain(fragment);
    expect(bare()).not.toContain(fragment);
    expect(render()).toContain(fragment);
  });
});
