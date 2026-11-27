import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The scheduled page (`routes/scheduled.tsx`), rendered statically with the router
 * hooks stubbed — the approach of `tests/broadcasts-screen.test.tsx`. The cancel
 * dialog is click-driven and not opened here; its wording is pinned through
 * `cancelScheduledCopy`.
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
  Link: (props: { to: string; children: React.ReactNode; className?: string; "aria-current"?: string }) => (
    <a href={props.to} className={props.className} aria-current={props["aria-current"]}>
      {props.children}
    </a>
  ),
  useLoaderData: () => rootData,
  useRouter: () => ({ invalidate: () => {} }),
}));

const screen = await import("../src/routes/scheduled");
const { cancelScheduledCopy } = await import("../src/components/scheduled/cancel-scheduled-dialog");
const { fmtTs } = await import("../src/ui");

const SEND_AT = 1_760_000_000_000;

const row = (over: Record<string, unknown> = {}) => ({
  key: "appt-1042",
  status: "pending",
  phoneNumberId: "phone-a",
  to: "34600000001",
  template: { name: "reminder_24h", language: "es" },
  sendAt: SEND_AT,
  expiresAt: SEND_AT + 3_600_000,
  attempts: 0,
  messageId: null,
  failureReason: null,
  error: null,
  createdAt: SEND_AT - 86_400_000,
  updatedAt: SEND_AT - 86_400_000,
  ...over,
});

const zeros = { pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0 };

const readyState = {
  stage: "ready",
  scope: {
    accountId: "account-a",
    selectedWabaId: "waba-a",
    resources: { wabaId: "waba-a", wabas: [{ wabaId: "waba-a", phones: [{ phoneNumberId: "phone-a" }] }] },
  },
};

function render(
  items: unknown[],
  opts: { counts?: Record<string, number>; search?: Record<string, string>; root?: unknown } = {},
): string {
  loaderData = {
    list: { ok: true, data: { items, nextCursor: null, counts: { ...zeros, ...opts.counts } } },
    origin: null,
  };
  searchParams = { wabaId: "waba-a", ...opts.search };
  rootData = { ok: true, data: opts.root ?? readyState };
  return renderToStaticMarkup(<screen.Route.component />);
}

describe("/scheduled", () => {
  test("a pending row shows the time with its expiry, the key, the full number, the template and Cancel", () => {
    const html = render([row()], { counts: { pending: 1 } });
    expect(html).toContain(fmtTs(SEND_AT));
    expect(html).toContain(`expires ${fmtTs(SEND_AT + 3_600_000)}`);
    expect(html).toContain("appt-1042");
    expect(html).toContain("34600000001");
    expect(html).toContain("reminder_24h");
    expect(html).toContain(">Cancel<");
  });

  test("a sent row shows the wamid tail and has no Cancel or action column", () => {
    const html = render([row({ status: "sent", messageId: "wamid.HBgLNTQ5MDAwMDAwMDEVAgARGBI", attempts: 1 })], {
      counts: { sent: 1 },
      search: { status: "sent" },
    });
    expect(html).toContain("wamid.HBgLNTQ5MDAwMDAwMDEVAgARGBI");
    expect(html).not.toContain(">Cancel<");
    expect(html).not.toContain("Actions");
    expect(html).not.toContain("expires ");
  });

  test("a failed row reads expired, or Meta's code and text", () => {
    const search = { status: "failed" };
    const expired = render([row({ status: "failed", failureReason: "expired" })], { counts: { failed: 1 }, search });
    expect(expired).toContain(">expired<");
    const rejected = render(
      [
        row({
          status: "failed",
          failureReason: "rejected",
          error: JSON.stringify({ code: 131026, message: "Message undeliverable" }),
        }),
      ],
      { counts: { failed: 1 }, search },
    );
    expect(rejected).toContain("131026");
    expect(rejected).toContain("Message undeliverable");
  });

  test("an unknown outcome is worded as such", () => {
    expect(render([row({ status: "unknown", attempts: 1 })], { counts: { unknown: 1 }, search: { status: "unknown" } })).toContain(
      "unknown outcome",
    );
  });

  test("the tabs list all six statuses, zeros included, and mark the current one", () => {
    const html = render([], { counts: { cancelled: 1 }, search: { status: "sent" } });
    for (const status of ["pending", "sending", "sent", "failed", "unknown"]) {
      expect(html).toContain(`${status} <span class="tabular-nums">0</span>`);
    }
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  test("failed is red only when something failed, and pending is never amber", () => {
    expect(render([], { counts: { pending: 3 } })).not.toContain("text-destructive-foreground");
    const failing = render([], { counts: { pending: 3, failed: 2 } });
    expect(failing).toContain("text-destructive-foreground");
    expect(failing).not.toMatch(/amber|warning/);
  });

  test("first run: nothing under any status shows the block, with the API door and no dead button", () => {
    const html = render([]);
    expect(html).toContain("No scheduled sends yet");
    expect(html).toContain("Send a template at a time you choose");
    expect(html).toContain("…/scheduled/appt-8812");
    expect(html).toContain("Copy as curl");
    expect(html).toContain("https://docs.eccos.chat/scheduled-sends");
    expect(html).not.toContain("Schedule a send");
    expect(html).not.toContain("scheduled sends by status");
  });

  test("an empty pending tab beside ended sends says nothing is pending, not that there are none", () => {
    const pending = render([], { counts: { sent: 300 } });
    expect(pending).toContain("NOTHING PENDING");
    expect(pending).not.toContain("NO SCHEDULED SENDS");
    expect(pending).toContain("A pending send goes out at its time, or expires.");
    const sent = render([], { counts: { pending: 1 }, search: { status: "sent" } });
    expect(sent).toContain("NONE SENT YET");
    expect(sent).toContain("Show pending");
  });

  test("sending paused with sends pending: they wait, and expire", () => {
    const paused = {
      ...readyState,
      scope: { ...readyState.scope, resources: { ...readyState.scope.resources, account: { billingStatus: "closed" } } },
    };
    const html = render([row()], { counts: { pending: 37 }, root: paused });
    expect(html).toContain("The 37 pending sends wait, and each one that has not gone out by its expiry is not sent.");
    expect(render([row()], { counts: { pending: 37 } })).not.toContain("Sending is paused");
    expect(render([], { counts: { sent: 2 }, root: paused })).not.toContain("Sending is paused");
  });

  test("a cursor page with no rows offers the way back", () => {
    const html = render([], { counts: { pending: 1 }, search: { cursor: "gone" } });
    expect(html).toContain("NO MATCHES");
    expect(html).toContain("back to the first page");
  });

  test("a failed read renders the failure, not the grid", () => {
    loaderData = { list: { ok: false, kind: "unreachable", error: "boom" }, origin: null };
    searchParams = {};
    rootData = { ok: true, data: readyState };
    expect(renderToStaticMarkup(<screen.Route.component />)).not.toContain("No scheduled sends yet");
  });
});

describe("cancel confirmation", () => {
  test("names the number and the time, in the operator's words", () => {
    expect(cancelScheduledCopy({ to: "34600111222", sendAt: Date.UTC(2026, 10, 20, 8) }, "Europe/Madrid")).toBe(
      "It will not be sent to +34600111222 on Fri 20 Nov at 09:00 CET. It can be scheduled again under the same key.",
    );
  });

  test("a number stored with its own + and spaces prints one +", () => {
    expect(cancelScheduledCopy({ to: "+34 600 111 222", sendAt: Date.UTC(2026, 10, 20, 8) }, "Europe/Madrid")).toContain(
      "sent to +34600111222 on",
    );
  });
});
