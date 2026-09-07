import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Page, StatusTag, Unreachable, fmtTs } from "../src/ui";

/**
 * Lightweight render smoke tests for the primitives every operator view is
 * built from (`Page`, `Unreachable`, `StatusTag`) — including the
 * "Gateway unreachable" state that every view (Status/Messages/Events/
 * Forwarding queue/Templates/Settings) falls back to when the `GATEWAY` RPC binding
 * can't be reached (see `tests/gateway.test.ts` for the data-layer side of
 * that same state). Views reach this card through `FailureView`, which routes
 * the other failure classes elsewhere — `tests/failure-view.test.tsx` covers
 * that split.
 *
 * These use React's own `react-dom/server` (`renderToStaticMarkup`), which
 * needs no DOM — it produces an HTML string directly, so no jsdom / Testing
 * Library dependency is required. `react` and `react-dom` are already direct
 * dependencies of this package.
 *
 * What's intentionally NOT covered here: rendering the actual route
 * components (`StatusPage`, `DeliveriesPage`, …). Those call
 * `Route.useLoaderData()` / `Route.useNavigate()`, which require a live
 * TanStack Router context (a matching route tree + router instance) around
 * them — wiring that up is real integration-test infrastructure, not a
 * lightweight smoke test, and isn't attempted here. The per-view *data path*
 * each of those components renders from (reachable vs. unreachable gateway)
 * is fully covered in `tests/gateway.test.ts`; full page rendering (and
 * anything visual) is left to the manual QA checklist
 * (`docs/ui-qa-checklist.md`) and the planned automated visual-regression
 * follow-up noted there.
 */

describe("Unreachable (shared graceful-degradation state, all views)", () => {
  test("renders the gateway-unreachable copy and the RPC error message", () => {
    const html = renderToStaticMarkup(<Unreachable error="fetch failed: ECONNREFUSED" />);
    expect(html).toContain("Gateway unreachable");
    expect(html).toContain("GATEWAY");
    expect(html).toContain("fetch failed: ECONNREFUSED");
  });
});

describe("Page (shared page shell, all views)", () => {
  test("renders the title, optional actions, and children without crashing", () => {
    const html = renderToStaticMarkup(
      <Page title="Deliveries" actions={<button type="button">Retry</button>}>
        <div>row content</div>
      </Page>,
    );
    expect(html).toContain("Deliveries");
    expect(html).toContain("Retry");
    expect(html).toContain("row content");
  });

  test("renders with no actions supplied", () => {
    const html = renderToStaticMarkup(<Page title="Events">{null}</Page>);
    expect(html).toContain("Events");
  });
});

describe("StatusTag (the status column on every log and table)", () => {
  test.each([
    ["delivered", "delivered"],
    ["failed", "failed"],
    ["pending", "pending"],
    ["some-unknown-status", "some-unknown-status"],
  ])("renders the %s status label", (status, expected) => {
    const html = renderToStaticMarkup(<StatusTag status={status} />);
    expect(html).toContain(expected);
  });

  test("the forward hop's own words carry their tones", () => {
    // `forwarded` is success, `held` and `retrying` are amber (a state with
    // something to do about it), and `queued` is NEUTRAL — it is the ordinary
    // state of a healthy queue for a few seconds, and colouring it would fire
    // on every well-behaved gateway (data rule 1).
    expect(renderToStaticMarkup(<StatusTag status="forwarded" />)).toContain("--tag-live-bg");
    expect(renderToStaticMarkup(<StatusTag status="held" />)).toContain("240,160,32");
    expect(renderToStaticMarkup(<StatusTag status="queued" />)).toContain("--tag-soon-bg");
  });

  test("a counted label takes the tone of its state word", () => {
    // `retrying 2/6` is one tag because the ratio IS the reading — 5/6 is one
    // attempt from terminal and 1/6 is noise. Without the first-word lookup it
    // would miss the map and fall back to neutral, losing the amber it was
    // written for.
    const html = renderToStaticMarkup(<StatusTag status="retrying 2/6" />);
    expect(html).toContain("retrying 2/6");
    expect(html).toContain("240,160,32");
  });
});

describe("fmtTs (timestamp formatting used across every log view)", () => {
  test("formats a numeric epoch-ms timestamp as ISO", () => {
    expect(fmtTs(0)).toBe(new Date(0).toISOString());
  });

  test("falls back to an em dash for null/undefined/garbage", () => {
    expect(fmtTs(null)).toBe("—");
    expect(fmtTs(undefined)).toBe("—");
    expect(fmtTs("not-a-number")).toBe("—");
  });
});
