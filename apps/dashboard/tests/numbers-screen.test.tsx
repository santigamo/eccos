import { describe, expect, mock, test } from "bun:test";
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

mock.module("cloudflare:workers", () => ({
  env: { BETTER_AUTH_URL: "http://localhost:3000" },
}));

mock.module("@tanstack/react-start", () => {
  const api = {
    validator: (_v: unknown) => api,
    handler: (fn: (arg?: unknown) => unknown) => (arg?: unknown) =>
      fn(arg && typeof arg === "object" && "data" in arg ? arg : { data: arg }),
  };
  return { createServerFn: (_opts?: unknown) => api };
});

mock.module("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("http://localhost:3000/", { headers: new Headers() }),
}));

const { ConnectNumberPanel } = await import(
  "../src/components/dashboard/connect-number"
);

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

  test("the choices ARE the actions, and the footer holds none", () => {
    // The old panel pinned one button in the footer. There is no single action
    // left to pin: picking a path launches that path, because there is nothing
    // to configure in between and a confirm step would only add a click before
    // Meta's own multi-screen flow, which is where backing out is still free.
    // So the footer must not regrow an action that would have to guess a path.
    const html = render();
    expect(html.match(/<button/g)?.length).toBe(2);
    const open = html.indexOf("<footer");
    const close = html.indexOf("</footer>", open);
    expect(open).toBeGreaterThan(-1);
    expect(html.slice(open, close)).not.toContain("<button");
  });
});
