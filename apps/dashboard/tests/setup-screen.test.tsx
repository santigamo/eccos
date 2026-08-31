import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Rendering contract for the first-run connect screen (see `setup-screen.tsx`).
 * React's own `react-dom/server` (`renderToStaticMarkup`) needs no DOM — same
 * lightweight pattern as `tests/ui.test.tsx` / `tests/status.test.tsx`.
 *
 * Importing `setup-screen.tsx` pulls in `src/server/gateway.ts`, which imports
 * `cloudflare:workers` (a virtual module that only exists inside the Workers
 * runtime) and `@tanstack/react-start` / `@tanstack/react-start/server`. The
 * same `mock.module` approach as `tests/gateway.test.ts` is used here, BEFORE
 * dynamically importing the real component.
 *
 * Design contract assertions (docs/DASHBOARD-DESIGN.md): square corners, the
 * page anatomy (pixel kicker, big Inter heading, hatch band), and the panel's
 * header/body/footer alignment.
 */

mock.module("cloudflare:workers", () => ({
  env: { BETTER_AUTH_URL: "http://localhost:3000" },
}));

mock.module("@tanstack/react-start", () => ({
  createServerFn: (_opts?: unknown) => {
    const api = {
      validator: (_v: unknown) => api,
      handler: (fn: (arg?: unknown) => unknown) => (arg?: unknown) =>
        fn(arg && typeof arg === "object" && "data" in arg ? arg : { data: arg }),
    };
    return api;
  },
}));

mock.module("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("http://localhost:3000/", { headers: new Headers() }),
}));

const { SetupScreen } = await import("../src/components/dashboard/setup-screen");

const ACCOUNT = { accountId: "acc_test123", name: "Dunder Mifflin", createdAt: 1 };
// The route renders `<SetupScreen state={state.data} />`, so the fixture is the
// unwrapped DashboardState, not the `Result` envelope around it.
const STATE = {
  stage: "account-ready" as const,
  resources: { account: ACCOUNT, keys: [], wabas: [], phones: [] },
};

function render(): string {
  return renderToStaticMarkup(<SetupScreen state={STATE} />);
}

describe("SetupScreen (first-run connect)", () => {
  test("Embedded Signup is the only way in", () => {
    // Decided 2026-08-31: onboarding stays one action. The token path (Cloud
    // API test numbers) is a separate, later surface, not a peer option here.
    const html = render();
    expect(html).toContain("Meta Embedded Signup");
    expect(html).toContain("Connect WhatsApp");
    expect(html).not.toContain("access token");
    expect(html).not.toContain('type="password"');
  });

  test("no step rail: there is one step, so nothing pretends otherwise", () => {
    const html = render();
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain("stepper");
  });

  test("wears the console masthead and page anatomy, not a bespoke header", () => {
    const html = render();
    // Same masthead construction as app-header.tsx: logomark + Inter wordmark,
    // pixel label on the right. The wordmark is NOT the pixel face.
    expect(html).toContain("/assets/logomark.png");
    expect(html).toContain("bg-(--nav-bg)");
    expect(html).toContain("Operator Console");
    // Page anatomy: pixel kicker, then the hatch band divider.
    expect(html).toContain("font-pixel");
    expect(html).toContain("First run");
    expect(html).toContain("hatch-band");
  });

  test("names the workspace it is about to connect", () => {
    const html = render();
    expect(html).toContain("Dunder Mifflin");
  });

  test("states the coexistence fact before the operator commits", () => {
    // The number stays on the phone; that is the whole reason this flow is
    // whatsapp_business_app_onboarding and not a plain onboarding.
    const html = render();
    expect(html).toContain("stays on the WhatsApp Business");
  });

  test("keeps the panel copy short enough to scan", () => {
    // Reviewed 2026-08-31: the panel had grown to ~90 words of prose for a
    // screen with one job. Budget the panel's visible words so sentences do
    // not creep back in; the masthead and heading are excluded.
    const html = render();
    const panel = html.slice(html.indexOf('data-slot="frame-panel"'));
    const text = panel.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
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
    const visible = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
    expect(visible).not.toContain("\u2014");
  });
});

/**
 * Layout contract (docs/DASHBOARD-DESIGN.md). Both assertions exist because
 * both regressed once: the panel header was indented a padding step deeper
 * than the content below it, and the action drifted between left, right and
 * full width across screens.
 */
describe("SetupScreen layout contract", () => {
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
