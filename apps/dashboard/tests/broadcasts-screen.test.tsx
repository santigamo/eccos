import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The broadcast pages (`routes/broadcasts.tsx`, `routes/broadcasts_.$broadcastId.tsx`),
 * rendered statically with the router hooks stubbed — the approach of
 * `tests/templates-screen.test.tsx`. The cancel dialog is click-driven and not
 * opened here; its wording is pinned through `cancelConfirmCopy`.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

let loaderData: unknown;
let searchParams: Record<string, string> = {};
let rootData: unknown;

const routerModule = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  createFileRoute: () => (opts: unknown) => ({
    ...(opts as object),
    useLoaderData: () => loaderData,
    useSearch: () => searchParams,
    useNavigate: () => () => {},
  }),
  Link: (props: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={props.to} className={props.className}>
      {props.children}
    </a>
  ),
  useLoaderData: () => rootData,
  useRouter: () => ({ invalidate: () => {} }),
}));

const list = await import("../src/routes/broadcasts");
const detail = await import("../src/routes/broadcasts_.$broadcastId");
const { cancelConfirmCopy } = await import("../src/components/broadcasts/cancel-broadcast-dialog");

const ID = `bc_${"a".repeat(32)}`;

const summary = (over: Record<string, unknown> = {}) => ({
  id: ID,
  status: "running",
  phoneNumberId: "phone-a",
  template: { name: "promo_autumn", language: "es" },
  total: 12,
  duplicatesSkipped: 2,
  ratePerMinute: 60,
  counts: { queued: 5, sending: 0, sent: 5, failed: 1, unknown: 1, cancelled: 0 },
  delivery: { delivered: 4, read: 2, failed: 0 },
  haltReason: null,
  createdAt: 1_760_000_000_000,
  finishedAt: null,
  ...over,
});

const recipient = (over: Record<string, unknown> = {}) => ({
  seq: 0,
  to: "34600000001",
  status: "sent",
  messageId: "wamid.HBgLNTQ5MDAwMDAwMDEVAgARGBI",
  error: null,
  attempts: 1,
  ...over,
});

const readyState = {
  stage: "ready",
  scope: {
    accountId: "account-a",
    selectedWabaId: "waba-a",
    resources: { wabas: [{ wabaId: "waba-a", phones: [{ phoneNumberId: "phone-a" }] }] },
  },
};

function renderList(items: unknown[], nextCursor: string | null = null): string {
  loaderData = { ok: true, data: { items, nextCursor } };
  searchParams = { wabaId: "waba-a" };
  rootData = { ok: true, data: readyState };
  return renderToStaticMarkup(<list.Route.component />);
}

function renderDetail(data: unknown, search: Record<string, string> = { wabaId: "waba-a" }): string {
  loaderData = { ok: true, data };
  searchParams = search;
  rootData = { ok: true, data: readyState };
  return renderToStaticMarkup(<detail.Route.component />);
}

describe("/broadcasts", () => {
  test("a row names the template, links to its page and reads progress against the total", () => {
    const html = renderList([summary()]);
    expect(html).toContain("promo_autumn");
    expect(html).toContain('href="/broadcasts/$broadcastId"');
    expect(html).toContain(">sending<");
    expect(html).toContain("7 / 12");
    expect(html).toContain("4 · 2");
  });

  test("failed is red only when there is something to act on", () => {
    const html = renderList([summary()]);
    expect(html).toContain("text-destructive-foreground");
    expect(html).toContain('href="/broadcasts/$broadcastId"');
    const clean = renderList([summary({ counts: { queued: 0, sending: 0, sent: 12, failed: 0, unknown: 0, cancelled: 0 } })]);
    expect(clean).not.toContain("text-destructive-foreground");
  });

  test("unknown outcomes are counted and linked on their own, not folded into failed", () => {
    const html = renderList([summary({ counts: { queued: 0, sending: 0, sent: 10, failed: 0, unknown: 2, cancelled: 0 } })]);
    expect(html).toContain("unknown</a>");
    expect(html.match(/text-destructive-foreground/g)).toHaveLength(1);
  });

  test("empty: says what will appear and links the guide", () => {
    const html = renderList([]);
    expect(html).toContain("NO BROADCASTS YET");
    expect(html).toContain("https://docs.eccos.chat/bulk-sending");
  });

  test("a failed read renders the failure, not the grid", () => {
    loaderData = { ok: false, kind: "unreachable", error: "boom" };
    searchParams = {};
    rootData = { ok: true, data: readyState };
    expect(renderToStaticMarkup(<list.Route.component />)).not.toContain("NO BROADCASTS YET");
  });
});

describe("/broadcasts/$broadcastId", () => {
  const page = (over: Record<string, unknown> = {}, rows: unknown[] = [recipient()]) => ({
    broadcast: summary(over),
    recipients: { items: rows, nextCursor: null },
  });

  test("Cancel is offered only while the broadcast is running", () => {
    expect(renderDetail(page())).toContain("Cancel broadcast");
    for (const status of ["completed", "cancelled", "halted"]) {
      expect(renderDetail(page({ status, haltReason: status === "halted" ? "x" : null }))).not.toContain(
        "Cancel broadcast",
      );
    }
  });

  test("the halt notice shows only when halted, as text", () => {
    expect(renderDetail(page())).not.toContain("Stopped:");
    const html = renderDetail(page({ status: "halted", haltReason: "Meta rejected the template (132001)" }));
    expect(html).toContain("Stopped: Meta rejected the template (132001)");
  });

  test("the facts strip carries totals and the per-status counts as filter links", () => {
    const html = renderDetail(page());
    expect(html).toContain("2 duplicates skipped");
    expect(html).toContain("Eccos → Meta accepted");
    expect(html).toContain("2 read");
    expect(html).toContain("queued");
    expect(html).not.toContain("cancelled <span");
  });

  test("a recipient shows its full number, a 1-based position and Meta's error", () => {
    const html = renderDetail(
      page({}, [
        recipient({
          seq: 4,
          status: "failed",
          messageId: null,
          attempts: 1,
          error: JSON.stringify({ code: 131026, message: "Message undeliverable" }),
        }),
      ]),
    );
    expect(html).toContain("34600000001");
    expect(html).toContain(">5<");
    expect(html).toContain("131026");
    expect(html).toContain("Message undeliverable");
  });

  test("an unknown outcome is worded as such", () => {
    expect(renderDetail(page({}, [recipient({ status: "unknown", messageId: null })]))).toContain("unknown outcome");
  });

  test("not found: says so and offers the way back", () => {
    const html = renderDetail(null);
    expect(html).toContain("BROADCAST NOT FOUND");
    expect(html).toContain("Back to broadcasts");
  });

  test("a filtered page with no rows offers to clear the filter", () => {
    const html = renderDetail(page({}, []), { wabaId: "waba-a", status: "cancelled" });
    expect(html).toContain("NO MATCHES");
  });
});

describe("cancel confirmation", () => {
  test("states the cost in recipients, not in hedges", () => {
    expect(cancelConfirmCopy({ queued: 4, sending: 1, sent: 7, failed: 0, unknown: 0, cancelled: 0 })).toBe(
      "4 queued recipients will not be messaged. The 1 being sent now may still go out. The 7 already sent stay sent. A cancelled broadcast cannot be resumed.",
    );
  });
});
