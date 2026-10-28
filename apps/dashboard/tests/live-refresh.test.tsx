import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";

/**
 * Refresh and live mode on /events and /messages (eccos-8dsv).
 *
 * No DOM here (see `tests/masthead-breadcrumb.test.tsx`), so the hook's effects
 * never run. What is pinned instead: the poller the hook mounts
 * (`pollWhileVisible`, driven by a fake document and real short timers), the
 * controls' two states and their toggle, and that both pages carry them.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

let loaderData: unknown;
let rootData: unknown;

// SPREAD, not replaced — see tests/templates-screen.test.tsx.
const routerModule = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  createFileRoute: () => (opts: unknown) => ({
    ...(opts as object),
    useLoaderData: () => loaderData,
    useSearch: () => ({}),
    useNavigate: () => () => {},
  }),
  Link: (props: { to: string; children: ReactNode; className?: string }) => (
    <a href={props.to} className={props.className}>
      {props.children}
    </a>
  ),
  useLoaderData: () => rootData,
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
}));

const { pollWhileVisible } = await import("../src/hooks/use-live-refresh");
const { RefreshControls } = await import("../src/components/logs/refresh-controls");
const { Route: EventsRoute } = await import("../src/routes/events");
const { Route: MessagesRoute } = await import("../src/routes/messages");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeDocument(visibilityState: DocumentVisibilityState) {
  const listeners = new Set<() => void>();
  return {
    visibilityState,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    listeners,
    set(state: DocumentVisibilityState) {
      this.visibilityState = state;
      for (const listener of listeners) listener();
    },
  };
}

describe("pollWhileVisible", () => {
  test("ticks on the interval while the tab is visible", async () => {
    let ticks = 0;
    const doc = fakeDocument("visible");
    const stop = pollWhileVisible(() => ticks++, 10, doc as unknown as Document);
    await wait(55);
    stop();
    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  test("a hidden tab polls nothing, and coming back ticks at once", async () => {
    let ticks = 0;
    const doc = fakeDocument("hidden");
    const stop = pollWhileVisible(() => ticks++, 10, doc as unknown as Document);
    await wait(40);
    expect(ticks).toBe(0);

    doc.set("visible");
    expect(ticks).toBe(1);
    await wait(35);
    expect(ticks).toBeGreaterThan(1);

    doc.set("hidden");
    const atHide = ticks;
    await wait(40);
    expect(ticks).toBe(atHide);
    stop();
  });

  test("cleanup stops the interval and drops the listener", async () => {
    let ticks = 0;
    const doc = fakeDocument("visible");
    const stop = pollWhileVisible(() => ticks++, 10, doc as unknown as Document);
    stop();
    await wait(40);
    expect(ticks).toBe(0);
    expect(doc.listeners.size).toBe(0);
  });
});

const idle = { live: false, setLive: () => {}, refreshing: false, refresh: () => {} };

describe("RefreshControls", () => {
  test("live is off by default and says so", () => {
    const html = renderToStaticMarkup(<RefreshControls {...idle} />);
    expect(html).toContain("Refresh");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Live off");
  });

  test("live on reads as on", () => {
    const html = renderToStaticMarkup(<RefreshControls {...idle} live />);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Live on");
  });

  test("a refresh in flight is visible", () => {
    const html = renderToStaticMarkup(<RefreshControls {...idle} refreshing />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("animate-spin");
  });

  test("the toggle flips the current state", () => {
    const calls: boolean[] = [];
    for (const live of [false, true]) {
      const tree = RefreshControls({ ...idle, live, setLive: (next) => calls.push(next) });
      const [, toggle] = (tree.props as { children: ReactElement<{ onClick: () => void }>[] })
        .children;
      toggle.props.onClick();
    }
    expect(calls).toEqual([true, false]);
  });

  test("square corners, no em dash in the copy", () => {
    const html = renderToStaticMarkup(<RefreshControls {...idle} live refreshing />);
    expect(html).not.toMatch(/\brounded-(?!none)/);
    expect(html).not.toContain("—");
  });
});

describe("log pages", () => {
  const root = {
    ok: true,
    hasForwardingTarget: false,
    data: {
      stage: "ready",
      status: { counts: { inbound: 0, inboundByType: {}, outbound: {}, deliveries: {} } },
      scope: { selectedWabaId: "waba-a", resources: { wabas: [] } },
    },
  };

  for (const [name, Route] of [
    ["events", EventsRoute],
    ["messages", MessagesRoute],
  ] as const) {
    test(`/${name} carries Refresh and the live toggle`, () => {
      loaderData = { ok: true, data: [] };
      rootData = root;
      const html = renderToStaticMarkup(<Route.component />);
      expect(html).toContain("Refresh");
      expect(html).toContain("Live off");
    });

    test(`/${name} keeps Refresh when the gateway failed`, () => {
      loaderData = { ok: false, kind: "unreachable", error: "down" };
      rootData = root;
      expect(renderToStaticMarkup(<Route.component />)).toContain("Refresh");
    });
  }
});
