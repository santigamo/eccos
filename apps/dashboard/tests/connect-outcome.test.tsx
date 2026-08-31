import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConnectOutcome,
  normalizeConnectError,
  normalizeConnectSkipped,
} from "../src/components/dashboard/connect-outcome";

/**
 * eccos-5z9: Meta's Embedded Signup callback lands on the gateway, which now
 * redirects the operator back to /numbers carrying an outcome. This pins the
 * console half of that contract: which codes are accepted off the URL, and what
 * the operator is actually told.
 *
 * The component has no route or Worker dependencies, so it renders with plain
 * `react-dom/server` and no module mocks.
 */

function render(props: Parameters<typeof ConnectOutcome>[0]): string {
  return renderToStaticMarkup(<ConnectOutcome {...props} />);
}

function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

describe("connect outcome search params", () => {
  test("accepts only the codes the gateway can send", () => {
    for (const code of ["state", "denied", "owned", "no_waba", "failed"]) {
      expect(normalizeConnectError(code)).toBe(code as never);
    }
    // A hand-edited or stale URL must not reach the copy lookup.
    expect(normalizeConnectError("javascript:alert(1)")).toBeUndefined();
    expect(normalizeConnectError("")).toBeUndefined();
    expect(normalizeConnectError(42)).toBeUndefined();
  });

  test("skipped counts are positive integers or nothing", () => {
    expect(normalizeConnectSkipped("2")).toBe(2);
    expect(normalizeConnectSkipped(1)).toBe(1);
    expect(normalizeConnectSkipped("0")).toBeUndefined();
    expect(normalizeConnectSkipped("-1")).toBeUndefined();
    expect(normalizeConnectSkipped("1.5")).toBeUndefined();
    expect(normalizeConnectSkipped("many")).toBeUndefined();
  });
});

describe("ConnectOutcome", () => {
  test("success is silent: the connected number is its own confirmation", () => {
    // Design rule 1 — a banner an operator sees always means something.
    const html = render({});
    expect(text(html)).toBe("");
    expect(html).not.toContain("border-l-2");
  });

  test("the live region is mounted even while empty, so it can announce", () => {
    expect(render({})).toContain('aria-live="polite"');
  });

  test("every failure code says something an operator can act on", () => {
    const codes = ["state", "denied", "owned", "no_waba", "failed"] as const;
    for (const code of codes) {
      const body = text(render({ connectError: code }));
      expect(body.length).toBeGreaterThan(20);
      // The console owns the wording; a raw provider error never reaches here.
      expect(body).not.toContain("Graph");
      expect(body).not.toContain("HTTP");
    }
  });

  test("failures take the destructive rail, a partial result the amber one", () => {
    expect(render({ connectError: "owned" })).toContain("border-l-[#e03131]");
    expect(render({ connectSkipped: 2 })).toContain("border-l-[#f0a020]");
  });

  test("a failure code wins over a skipped count", () => {
    const html = render({ connectError: "failed", connectSkipped: 3 });
    expect(text(html)).toBe("Meta could not complete the connection. Try again.");
  });

  test("the skipped sentence agrees in number", () => {
    expect(text(render({ connectSkipped: 1 }))).toContain("Account was skipped");
    expect(text(render({ connectSkipped: 3 }))).toContain("3 WhatsApp Business Accounts were skipped");
  });

  test("no em dashes in visible copy", () => {
    for (const props of [{ connectError: "state" as const }, { connectSkipped: 2 }]) {
      expect(render(props)).not.toContain("—");
    }
  });
});
