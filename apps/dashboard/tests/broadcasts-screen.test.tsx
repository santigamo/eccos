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

function renderList(
  items: unknown[],
  opts: { cursor?: string; root?: unknown; origin?: string | null } = {},
): string {
  loaderData = { list: { ok: true, data: { items, nextCursor: null } }, origin: opts.origin ?? null };
  searchParams = { wabaId: "waba-a", ...(opts.cursor ? { cursor: opts.cursor } : {}) };
  rootData = { ok: true, data: opts.root ?? readyState };
  return renderToStaticMarkup(<list.Route.component />);
}

const pausedState = {
  ...readyState,
  scope: { ...readyState.scope, resources: { ...readyState.scope.resources, account: { billingStatus: "paused" } } },
};

function renderDetail(data: unknown, search: Record<string, string> = { wabaId: "waba-a" }): string {
  loaderData = { ok: true, data };
  searchParams = search;
  rootData = { ok: true, data: readyState };
  return renderToStaticMarkup(<detail.Route.component />);
}

describe("/broadcasts", () => {
  test("a row names the template, links to its page and reads the funnel", () => {
    const html = renderList([summary({ total: 2431, delivery: { delivered: 1102, read: 640, failed: 0 } })]);
    expect(html).toContain("promo_autumn");
    expect(html).toContain('href="/broadcasts/$broadcastId"');
    expect(html).toContain(">sending<");
    for (const header of ["Recipients", "Sent", "Delivered", "Read", "Failed"]) expect(html).toContain(header);
    expect(html).toContain(">2,431<");
    expect(html).toContain(">1,102<");
    expect(html).toContain(">640<");
  });

  test("a running broadcast reads paused with its queue while the workspace's sending is paused", () => {
    expect(renderList([summary()], { root: pausedState })).toContain("5 waiting");
    expect(renderList([summary()], { root: pausedState })).toContain(">paused<");
    expect(renderList([summary()])).not.toContain("waiting");
  });

  test("a halted row states its reason beside the tag", () => {
    expect(renderList([summary({ status: "halted", haltReason: "first 20 sends failed" })])).toContain(
      "first 20 sends failed",
    );
  });

  test("populated: the intro line says what the page is for", () => {
    expect(renderList([summary()])).toContain("Eccos paces the sends and reports every recipient here.");
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

  test("first run: the block replaces the grid, with the API door filled in and no dead button", () => {
    const html = renderList([], { origin: "https://api.eccos.chat" });
    expect(html).toContain("No broadcasts yet");
    expect(html).toContain("Send one template to your whole list");
    expect(html).toContain("/v1/wabas/waba-a/broadcasts");
    expect(html).toContain("Show the full request");
    expect(html).toContain("Copy as curl");
    expect(html).toContain("https://docs.eccos.chat/bulk-sending");
    expect(html).toContain(">Example<");
    expect(html).not.toContain("New broadcast");
    expect(html).not.toContain("Created");
    expect(html).not.toContain("Eccos paces the sends");
  });

  test("first run: an admin is sent to create a key; anyone else is told to ask one", () => {
    expect(renderList([], { root: { ...readyState, canAdminister: true, role: "admin" } })).toContain("Create an API key");
    const member = renderList([], { root: { ...readyState, canAdminister: false, role: "member" } });
    expect(member).toContain("Ask an admin of this workspace for an API key.");
    expect(member).not.toContain("Create an API key");
  });

  test("an empty page past the first is not a first run", () => {
    const html = renderList([], { cursor: ID });
    expect(html).toContain("NO MORE BROADCASTS");
    expect(html).toContain("Back to the newest");
    expect(html).not.toContain("Send one template to your whole list");
  });

  test("a failed read renders the failure, not the grid", () => {
    loaderData = { list: { ok: false, kind: "unreachable", error: "boom" }, origin: null };
    searchParams = {};
    rootData = { ok: true, data: readyState };
    expect(renderToStaticMarkup(<list.Route.component />)).not.toContain("No broadcasts yet");
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

  test("the meta line states the broadcast's pace, not the account's rate", () => {
    const html = renderDetail(page());
    expect(html).toContain("paced at up to 48 a minute");
    expect(html).not.toContain("60/min");
  });

  test("paused by billing: the tag, the queue and what happens to it", () => {
    rootData = { ok: true, data: pausedState };
    loaderData = { ok: true, data: page() };
    searchParams = { wabaId: "waba-a" };
    const html = renderToStaticMarkup(<detail.Route.component />);
    expect(html).toContain(">paused<");
    expect(html).toContain("The 5 queued recipients are waiting; nothing is lost.");
  });

  test("one skipped duplicate reads singular", () => {
    expect(renderDetail(page({ duplicatesSkipped: 1 }))).toContain("1 duplicate skipped");
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
