import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountResources } from "@eccos/gateway-contract";

/**
 * Rendering contract for the /numbers table (eccos-lpk).
 *
 * The Embedded Signup callback now provisions before it hands the operator
 * back, so a `pending` row is the tail case rather than the normal one — and
 * the tail is exactly what used to be a bare amber tag with no explanation and
 * no way out. These tests pin the two halves of the fix: pending says what it
 * means, and the row that can still change carries the action.
 *
 * Same import gymnastics as `numbers-screen.test.tsx`: the component imports
 * `src/server/gateway.ts`, which pulls `cloudflare:workers` and
 * `@tanstack/react-start`, so both are mocked BEFORE the real import. React's
 * own `react-dom/server` needs no DOM.
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

const { NumbersTable } = await import("../src/components/dashboard/numbers-table");

type Status = "pending" | "active" | "failed";

function resources(...wabas: Array<{ wabaId: string; status: Status; phones: number }>): AccountResources {
  return {
    account: { accountId: "account-a", name: "Account A", createdAt: 1 },
    keys: [],
    wabas: wabas.map((waba) => ({
      accountId: "account-a",
      wabaId: waba.wabaId,
      callbackUrl: null,
      createdAt: 1,
      provisionedAt: waba.status === "active" ? 2 : null,
      status: waba.status,
      provisioningError: null,
      phones: Array.from({ length: waba.phones }, (_, index) => ({
        phoneNumberId: `${waba.wabaId}-phone-${index}`,
        displayPhoneNumber: `+34 600 000 00${index}`,
      })),
    })),
    phones: [],
  };
}

function render(state: AccountResources): string {
  return renderToStaticMarkup(<NumbersTable resources={state} />);
}

function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

describe("NumbersTable", () => {
  test("an active number is quiet: a tag, and no action to take", () => {
    const html = render(resources({ wabaId: "waba-a", status: "active", phones: 1 }));
    expect(html).toContain("active");
    expect(html).not.toContain("Re-check");
    // Colour and copy are spent on state that means something; waiting copy has
    // no business on a connected number.
    expect(text(html)).not.toContain("Waiting on Meta");
  });

  test("a pending number says what pending means", () => {
    const html = render(resources({ wabaId: "waba-a", status: "pending", phones: 1 }));
    const body = text(html);
    expect(body).toContain("Waiting on Meta");
    expect(body).toContain("subscribing it to its Meta webhooks");
    // And it says the wait is not the operator's to babysit.
    expect(body).toContain("keeps retrying on its own");
  });

  test("a pending number offers the re-check that can change it", () => {
    const html = render(resources({ wabaId: "waba-a", status: "pending", phones: 1 }));
    expect(html).toContain("Re-check");
    expect(html).toContain('aria-label="Re-check +34 600 000 000"');
  });

  test("a failed number can be re-checked too, and an active one cannot", () => {
    const html = render(
      resources(
        { wabaId: "waba-failed", status: "failed", phones: 1 },
        { wabaId: "waba-ok", status: "active", phones: 1 },
      ),
    );
    expect(html.match(/Re-check\b/g) ?? []).toHaveLength(2); // aria-label + button text
    // The active row holds the column's rhythm with a muted em-dash.
    expect(html).toContain('<span class="text-muted-foreground">—</span>');
  });

  test("the waiting note counts rows, not accounts", () => {
    const html = render(resources({ wabaId: "waba-a", status: "pending", phones: 2 }));
    expect(text(html)).toContain("2 numbers are registered");
  });

  test("the live region is mounted before it has anything to announce", () => {
    // An element that appears with its message is not reliably announced; one
    // that fills up is.
    const html = render(resources({ wabaId: "waba-a", status: "pending", phones: 1 }));
    expect(html).toContain('aria-live="polite"');
  });

  test("the table stays square and keeps its machine-voice headers", () => {
    const html = render(resources({ wabaId: "waba-a", status: "pending", phones: 1 }));
    const stripped = html
      .replace(/rounded-none/g, "")
      .replace(/rounded-\([^)]*\)/g, "")
      .replace(/rounded-\[[^\]]*\]/g, "");
    expect(stripped).not.toMatch(/rounded-/);
    expect(html).toContain("tracking-wider");
    expect(text(html)).toContain("Action");
  });
});
