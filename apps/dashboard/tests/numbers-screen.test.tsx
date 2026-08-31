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
  test("Embedded Signup is the only way in", () => {
    // Decided 2026-08-31: connecting a number stays one action. The token path
    // (Cloud API test numbers, eccos-up9) is a separate, later surface.
    const html = render();
    expect(html).toContain("Meta Embedded Signup");
    expect(html).toContain("Connect WhatsApp");
    expect(html).not.toContain("access token");
    expect(html).not.toContain('type="password"');
  });

  test("states the coexistence fact before the operator commits", () => {
    // The number stays on the phone; that is the whole reason this flow is
    // whatsapp_business_app_onboarding and not a plain onboarding.
    const html = render();
    expect(html).toContain("stays on the WhatsApp Business");
  });

  test("the heading is the caller's, so first run and add-another differ", () => {
    expect(render("Add another number")).toContain("Add another number");
  });

  test("keeps the panel copy short enough to scan", () => {
    // Reviewed 2026-08-31: the panel had grown to ~90 words of prose for a
    // surface with one job. Budget its visible words so sentences do not creep
    // back in.
    const html = render();
    const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    expect(text.split(" ").length).toBeLessThan(55);
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

  test("the action lives in the panel footer, pinned right", () => {
    const html = render();
    const open = html.indexOf("<footer");
    const close = html.indexOf("</footer>", open);
    expect(open).toBeGreaterThan(-1);
    const footer = html.slice(open, close);
    expect(footer).toContain("ml-auto");
    expect(footer).toContain("Connect WhatsApp");
  });
});
