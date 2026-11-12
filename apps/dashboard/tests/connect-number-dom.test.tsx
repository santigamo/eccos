import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * Embedded Signup's result, driven through a real DOM: what the customer is
 * told, and whether they are sent to /numbers, for every outcome the flow can
 * end in. Meta's SDK and the server functions are stubbed; navigation and the
 * popup watchdog are the component's own seams.
 */

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const gateway = await import("../src/server/gateway");
const real = {
  getEmbeddedSignupConfig: gateway.getEmbeddedSignupConfig as () => Promise<unknown>,
  startConnect: gateway.startConnect as () => Promise<unknown>,
  exchangeConnectCode: gateway.exchangeConnectCode as (input: unknown) => Promise<unknown>,
  recordConnectSessionEvent: gateway.recordConnectSessionEvent as (input: unknown) => Promise<unknown>,
};
// Delegating, as send-gate-dom does: after this file the real functions answer
// again for whichever file imports the module next.
let stubs = { ...real };
mock.module("../src/server/gateway", () => ({
  ...gateway,
  getEmbeddedSignupConfig: () => stubs.getEmbeddedSignupConfig(),
  startConnect: () => stubs.startConnect(),
  exchangeConnectCode: (input: unknown) => stubs.exchangeConnectCode(input),
  recordConnectSessionEvent: (input: unknown) => stubs.recordConnectSessionEvent(input),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ConnectNumberChoices, resetConnectGuards } = await import("../src/components/dashboard/connect-number");

type LoginCallback = (response: { authResponse?: { code?: string } | null }) => void;

const phone = { waba_id: "100", phone_number_id: "200", display_phone_number: "+1 555 0100" };
const exchanged = (over: Record<string, unknown> = {}) => ({
  ok: true,
  data: {
    ok: true,
    waba_id: "100",
    phone_number_id: "200",
    display_phone_number: "+1 555 0100",
    connected: [phone],
    status: "active",
    ...over,
  },
});

let unmount: (() => void) | null = null;
let navigated: string[] = [];
let loginCallback: LoginCallback | null = null;
let loginCalls = 0;
let handoffs = 0;
let handoffTtlMs = 30 * 60_000;
let order: string[] = [];
let exchanges: { code: string; state: string }[] = [];

beforeEach(() => {
  resetConnectGuards();
  navigated = [];
  loginCallback = null;
  loginCalls = 0;
  handoffs = 0;
  handoffTtlMs = 30 * 60_000;
  order = [];
  exchanges = [];
  stubs = {
    ...real,
    getEmbeddedSignupConfig: async () => ({
      ok: true,
      data: { appId: "app", configId: "cfg", graphVersion: "v25.0" },
    }),
    startConnect: async () => {
      handoffs += 1;
      order.push("start");
      return {
        ok: true,
        data: {
          state: `state-${handoffs}`,
          url: "https://gateway.test/connect",
          expiresAt: Date.now() + handoffTtlMs,
        },
      };
    },
    exchangeConnectCode: async (input: unknown) => {
      exchanges.push((input as { data: { code: string; state: string } }).data);
      return exchanged();
    },
    recordConnectSessionEvent: async () => ({ ok: true }),
  };
  (window as unknown as { FB: unknown }).FB = {
    init: () => {},
    login: (cb: LoginCallback) => {
      loginCalls += 1;
      order.push("login");
      loginCallback = cb;
    },
  };
});

afterEach(() => {
  act(() => unmount?.());
  unmount = null;
  document.body.innerHTML = "";
  delete (window as unknown as { FB?: unknown }).FB;
});

afterAll(async () => {
  stubs = { ...real };
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 5))));

async function mount(node: ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  unmount = () => root.unmount();
  await settle();
  return host;
}

const mountChoices = (popupWatchdogMs = 3_000) =>
  mount(
    <ConnectNumberChoices
      navigate={(path) => navigated.push(path)}
      popupWatchdogMs={popupWatchdogMs}
      abandonDelayMs={10}
    />,
  );

function card(host: HTMLElement, title: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(title));
  if (!found) throw new Error(`no card ${title}`);
  return found;
}

const live = (host: HTMLElement) => host.querySelector("output")?.textContent ?? "";

/** Click the new-number card, then have Meta's window report `response`. */
async function runFlow(host: HTMLElement, response: Parameters<LoginCallback>[0]) {
  await act(async () => card(host, "A new number").click());
  await settle();
  expect(loginCalls).toBe(1);
  await act(async () => loginCallback?.(response));
  await settle();
}

const FINISHED = { authResponse: { code: "code-1" } };

describe("ConnectNumberChoices in a real DOM", () => {
  test("the live region is mounted empty and gets filled", async () => {
    const host = await mountChoices();
    expect(host.querySelector("output")).not.toBeNull();
    expect(live(host)).toBe("");
  });

  test("a connected number goes to /numbers", async () => {
    const host = await mountChoices();
    await runFlow(host, FINISHED);
    expect(navigated).toEqual(["/numbers"]);
    expect(live(host)).toBe("");
  });

  test("pending provisioning goes to /numbers too", async () => {
    stubs.exchangeConnectCode = async () => exchanged({ status: "pending" });
    const host = await mountChoices();
    await runFlow(host, FINISHED);
    expect(navigated).toEqual(["/numbers"]);
  });

  test("failed provisioning goes to /numbers with no retry message", async () => {
    stubs.exchangeConnectCode = async () => exchanged({ status: "failed" });
    const host = await mountChoices();
    await runFlow(host, FINISHED);
    expect(navigated).toEqual(["/numbers"]);
    expect(live(host)).toBe("");
  });

  test("no phone number goes to /numbers, where it is explained", async () => {
    stubs.exchangeConnectCode = async () => exchanged({ connected: [], phone_number_id: "" });
    const host = await mountChoices();
    await runFlow(host, FINISHED);
    expect(navigated).toEqual(["/numbers"]);
  });

  test("skipped accounts are carried to /numbers", async () => {
    stubs.exchangeConnectCode = async () => exchanged({ warnings: ["x"] });
    const host = await mountChoices();
    await runFlow(host, FINISHED);
    expect(navigated).toEqual(["/numbers?connectSkipped=1"]);
  });

  for (const code of ["owned", "denied", "state", "no_waba", "failed"]) {
    test(`a ${code} failure stays here with a message and a live retry`, async () => {
      stubs.exchangeConnectCode = async () => ({ ok: true, data: { ok: false, code, error: "raw" } });
      const host = await mountChoices();
      await runFlow(host, FINISHED);
      expect(navigated).toEqual([]);
      expect(live(host).length).toBeGreaterThan(20);
      expect(live(host)).not.toContain("raw");
      expect(card(host, "A new number").disabled).toBe(false);
    });
  }

  test("closing Meta's window is a neutral note, not a navigation", async () => {
    const host = await mountChoices();
    await runFlow(host, { authResponse: null });
    expect(navigated).toEqual([]);
    expect(live(host)).toContain("Nothing changed");
    expect(host.querySelector("output")?.className).not.toContain("e03131");
    expect(card(host, "A new number").disabled).toBe(false);
  });

  test("a thrown exchange is an unknown outcome: /numbers, no raw text, no retry", async () => {
    stubs.exchangeConnectCode = async () => {
      throw new Error("Failed to fetch");
    };
    const host = await mountChoices();
    await runFlow(host, FINISHED);
    expect(navigated).toEqual(["/numbers"]);
    expect(live(host)).toBe("");
  });

  test("an unreachable result after the state was spent is unknown too", async () => {
    stubs.exchangeConnectCode = async () => ({ ok: false, kind: "unreachable", error: "boom" });
    const host = await mountChoices();
    await runFlow(host, FINISHED);
    expect(navigated).toEqual(["/numbers"]);
    expect(live(host)).not.toContain("boom");
  });

  test("mounting loads nothing from the gateway and starts nothing", async () => {
    await mountChoices();
    expect(handoffs).toBe(0);
    expect(loginCalls).toBe(0);
  });

  test("the click calls FB.login in its own task, with nothing left to await", async () => {
    const host = await mountChoices();
    // A synchronous act: no microtask or timer may run between click and login.
    act(() => card(host, "A new number").click());
    expect(loginCalls).toBe(1);
    // The handoff is requested only after the window exists, in parallel with it.
    expect(handoffs).toBe(1);
    expect(order).toEqual(["login", "start"]);
  });

  test("the SDK is invoked before the click handler returns, even if the config is slow later", async () => {
    const host = await mountChoices();
    stubs.getEmbeddedSignupConfig = () => new Promise(() => {});
    stubs.startConnect = () => new Promise(() => {});
    act(() => card(host, "A new number").click());
    expect(loginCalls).toBe(1);
  });

  test("a click before the SDK loaded shows Open Meta for the chosen path, keeps it selected, and that click logs in synchronously", async () => {
    stubs.getEmbeddedSignupConfig = async () => {
      throw new Error("offline");
    };
    const busy: boolean[] = [];
    const host = await mount(<ConnectNumberChoices navigate={(path) => navigated.push(path)} onBusyChange={(b) => busy.push(b)} />);
    stubs.getEmbeddedSignupConfig = real.getEmbeddedSignupConfig === stubs.getEmbeddedSignupConfig ? stubs.getEmbeddedSignupConfig : (async () => ({
      ok: true,
      data: { appId: "app", configId: "cfg", graphVersion: "v25.0" },
    }));
    await act(async () => card(host, "A new number").click());
    await settle();
    expect(loginCalls).toBe(0);
    expect(handoffs).toBe(0);
    const open = [...host.querySelectorAll("button")].find((b) => b.textContent === "Open Meta for a new number");
    expect(open).toBeDefined();
    expect(card(host, "A new number").disabled).toBe(true);
    expect(busy.at(-1)).toBe(true);

    act(() => open?.click());
    expect(loginCalls).toBe(1);
    await act(async () => loginCallback?.(FINISHED));
    await settle();
    expect(exchanges).toEqual([{ code: "code-1", state: "state-1" }]);
  });

  test("a click during a mount load that rejects retries instead of reusing the rejection", async () => {
    let calls = 0;
    let rejectFirst: (e: Error) => void = () => {};
    stubs.getEmbeddedSignupConfig = () => {
      calls += 1;
      if (calls === 1) return new Promise((_, reject) => {
          rejectFirst = reject;
        });
      return Promise.resolve({ ok: true, data: { appId: "app", configId: "cfg", graphVersion: "v25.0" } });
    };
    const host = await mountChoices();
    await act(async () => card(host, "A new number").click());
    await act(async () => rejectFirst(new Error("offline")));
    await settle();
    expect(live(host)).toBe("");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Open Meta for a new number")).toBe(true);
  });

  test("a failed handoff shows its error when Meta's window returns with a code", async () => {
    const host = await mountChoices();
    stubs.startConnect = async () => ({ ok: false, kind: "unreachable", error: "down" });
    act(() => card(host, "A new number").click());
    await act(async () => loginCallback?.(FINISHED));
    await settle();
    expect(exchanges).toEqual([]);
    expect(live(host)).toBe("down");
    expect(card(host, "A new number").disabled).toBe(false);
  });

  test("a window the browser refused is blocked at once, with the host and a way out", async () => {
    const original = window.open;
    window.open = () => null;
    (window as unknown as { FB: { login: unknown } }).FB.login = (cb: LoginCallback) => {
      loginCalls += 1;
      loginCallback = cb;
      window.open("https://www.facebook.com/", "_blank");
    };
    try {
      const host = await mountChoices();
      act(() => card(host, "A new number").click());
      expect(live(host)).toContain("blocked");
      expect(live(host)).toContain(window.location.host);
      expect(live(host)).not.toContain("Start again");
      expect(card(host, "A new number").disabled).toBe(false);
      // Nothing was requested from the gateway for a window that never opened.
      expect(handoffs).toBe(0);
      // A late callback from the refused attempt is not a cancel.
      await act(async () => loginCallback?.({ authResponse: null }));
      expect(live(host)).toContain("blocked");
    } finally {
      window.open = original;
    }
  });

  test("a window that did open is never called blocked, however long it takes", async () => {
    const original = window.open;
    window.open = (() => ({ closed: false })) as unknown as typeof window.open;
    (window as unknown as { FB: { login: unknown } }).FB.login = (cb: LoginCallback) => {
      loginCalls += 1;
      loginCallback = cb;
      window.open("https://www.facebook.com/", "_blank");
    };
    try {
      const host = await mountChoices(20);
      act(() => card(host, "A new number").click());
      await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 60))));
      expect(live(host)).toContain("may be behind this one");
      expect(live(host)).not.toContain("blocked");
      expect(live(host)).toContain("Start again");
    } finally {
      window.open = original;
    }
  });

  test("closing the window with no Meta message records where we know it stopped: nowhere", async () => {
    const events: unknown[] = [];
    const tracked: [string, unknown][] = [];
    stubs.recordConnectSessionEvent = async (input: unknown) => {
      events.push((input as { data: unknown }).data);
      return { ok: true };
    };
    (window as unknown as { umami: unknown }).umami = { track: (n: string, d: unknown) => tracked.push([n, d]) };
    const host = await mountChoices();
    await runFlow(host, { authResponse: null });
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 40))));
    expect(events).toEqual([{ event: "POPUP_CLOSED" }]);
    expect(tracked.find(([n]) => n === "es_abandon")?.[1]).toEqual({ step: "none", events: 0, after: "<10s" });
    delete (window as unknown as { umami?: unknown }).umami;
  });

  test("closing the window after Meta reported a step records that step", async () => {
    const events: unknown[] = [];
    const tracked: [string, unknown][] = [];
    stubs.recordConnectSessionEvent = async (input: unknown) => {
      events.push((input as { data: unknown }).data);
      return { ok: true };
    };
    (window as unknown as { umami: unknown }).umami = { track: (n: string, d: unknown) => tracked.push([n, d]) };
    const host = await mountChoices();
    await act(async () => card(host, "A new number").click());
    await settle();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://www.facebook.com",
          data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "PHONE_NUMBER_SETUP" } }),
        }),
      );
    });
    await act(async () => loginCallback?.({ authResponse: null }));
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 40))));
    expect(events).toContainEqual({ event: "CANCEL", currentStep: "PHONE_NUMBER_SETUP" });
    expect(events).toContainEqual({ event: "POPUP_CLOSED", currentStep: "PHONE_NUMBER_SETUP" });
    expect(tracked.find(([n]) => n === "es_abandon")?.[1]).toMatchObject({ step: "PHONE_NUMBER_SETUP", events: 1 });
    delete (window as unknown as { umami?: unknown }).umami;
  });

  const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

  test("a retry after a cancel logs in again and exchanges with its own handoff", async () => {
    const host = await mountChoices();
    await runFlow(host, { authResponse: null });
    expect(handoffs).toBe(1);

    act(() => card(host, "A new number").click());
    expect(loginCalls).toBe(2);
    await act(async () => loginCallback?.(FINISHED));
    await settle();
    expect(handoffs).toBe(2);
    expect(exchanges).toEqual([{ code: "code-1", state: "state-2" }]);
  });

  test("a window that cannot be observed gets a neutral note that claims nothing, and Start again", async () => {
    const host = await mountChoices(20);
    await act(async () => card(host, "A new number").click());
    await settle();
    await wait(60);
    expect(live(host)).toContain("behind this one");
    expect(live(host)).toContain("If you do not see Meta's window");
    expect(live(host)).not.toContain("should be open");
    expect(live(host)).toContain("Start again");
    // Message only: the cards stay disabled until the customer resets.
    expect(card(host, "A new number").disabled).toBe(true);
    expect(navigated).toEqual([]);
  });

  test("a behind-this-window note followed by a completed callback still exchanges and navigates", async () => {
    const host = await mountChoices(20);
    await act(async () => card(host, "A new number").click());
    await settle();
    await wait(60);
    expect(live(host)).toContain("behind this one");

    await act(async () => loginCallback?.(FINISHED));
    await settle();
    expect(exchanges).toEqual([{ code: "code-1", state: "state-1" }]);
    expect(navigated).toEqual(["/numbers"]);
  });

  test("only one exchange runs at a time", async () => {
    let release: (value: unknown) => void = () => {};
    stubs.exchangeConnectCode = (input: unknown) => {
      exchanges.push((input as { data: { code: string; state: string } }).data);
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const host = await mountChoices();
    await act(async () => card(host, "A new number").click());
    await settle();
    await act(async () => {
      loginCallback?.(FINISHED);
      loginCallback?.(FINISHED);
    });
    expect(exchanges.length).toBe(1);
    await act(async () => release(exchanged()));
    await settle();
    expect(navigated).toEqual(["/numbers"]);
  });

  test("Start again resets the view so the customer can pick again", async () => {
    const host = await mountChoices(20);
    await act(async () => card(host, "A new number").click());
    await settle();
    await wait(60);

    const again = [...host.querySelectorAll("button")].find((b) => b.textContent === "Start again");
    await act(async () => again?.click());
    expect(live(host)).toBe("");
    expect(card(host, "A new number").disabled).toBe(false);
  });

  test("a window that took focus is not a blocked popup", async () => {
    const host = await mountChoices(20);
    await act(async () => card(host, "A new number").click());
    await settle();
    window.dispatchEvent(new Event("blur"));
    await wait(60);
    expect(live(host)).toBe("");
    expect(card(host, "A new number").disabled).toBe(true);
  });

  test("a page hidden by a popup opening as a tab is not a blocked popup either", async () => {
    const host = await mountChoices(20);
    await act(async () => card(host, "A new number").click());
    await settle();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await wait(60);
    expect(live(host)).toBe("");
  });

  test("once the page is leaving, a second window's code is not exchanged", async () => {
    const host = await mountChoices(20);
    await act(async () => card(host, "A new number").click());
    await settle();
    await wait(60);
    await act(async () => loginCallback?.(FINISHED));
    await settle();
    expect(navigated).toEqual(["/numbers"]);

    await act(async () => loginCallback?.({ authResponse: { code: "code-2" } }));
    await settle();
    expect(exchanges).toEqual([{ code: "code-1", state: "state-1" }]);
  });

  test("a retry after a failed result exchanges again", async () => {
    let calls = 0;
    stubs.exchangeConnectCode = async (input: unknown) => {
      exchanges.push((input as { data: { code: string; state: string } }).data);
      calls += 1;
      return calls === 1 ? { ok: true, data: { ok: false, code: "failed", error: "x" } } : exchanged();
    };
    const host = await mountChoices();
    await runFlow(host, FINISHED);
    expect(navigated).toEqual([]);

    await act(async () => card(host, "A new number").click());
    await settle();
    await act(async () => loginCallback?.({ authResponse: { code: "code-2" } }));
    await settle();
    expect(exchanges.map((e) => e.code)).toEqual(["code-1", "code-2"]);
    expect(navigated).toEqual(["/numbers"]);
  });

  test("a code arriving clears the behind-this-window note", async () => {
    let release: (value: unknown) => void = () => {};
    stubs.exchangeConnectCode = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const host = await mountChoices(20);
    await act(async () => card(host, "A new number").click());
    await settle();
    await wait(60);
    expect(live(host)).toContain("behind this one");

    await act(async () => loginCallback?.(FINISHED));
    expect(live(host)).toBe("");
    await act(async () => release(exchanged()));
    await settle();
  });

  test("Start again does nothing while an exchange is in flight", async () => {
    let release: (value: unknown) => void = () => {};
    stubs.exchangeConnectCode = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const host = await mountChoices(20);
    await act(async () => card(host, "A new number").click());
    await settle();
    await wait(60);
    const again = [...host.querySelectorAll("button")].find((b) => b.textContent === "Start again");
    await act(async () => loginCallback?.(FINISHED));
    await act(async () => again?.click());
    expect(card(host, "A new number").disabled).toBe(true);
    await act(async () => release(exchanged()));
    await settle();
  });

  async function blockThenStartAgain(host: HTMLElement) {
    await act(async () => card(host, "A new number").click());
    await settle();
    const staleCallback = loginCallback;
    await wait(60);
    const again = [...host.querySelectorAll("button")].find((b) => b.textContent === "Start again");
    await act(async () => again?.click());
    return staleCallback;
  }

  test("an old window's cancel after Start again changes nothing on screen but is still recorded", async () => {
    const events: unknown[] = [];
    stubs.recordConnectSessionEvent = async (input: unknown) => {
      events.push((input as { data: unknown }).data);
      return { ok: true };
    };
    const host = await mountChoices(20);
    const stale = await blockThenStartAgain(host);
    await act(async () => stale?.({ authResponse: null }));
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 40))));
    expect(live(host)).toBe("");
    expect(events).toEqual([{ event: "POPUP_CLOSED" }]);
  });

  test("an old window's cancel does not stop the watchdog of the newer attempt", async () => {
    const host = await mountChoices(60);
    await act(async () => card(host, "A new number").click());
    await settle();
    const stale = loginCallback;
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 100))));
    const again = [...host.querySelectorAll("button")].find((b) => b.textContent === "Start again");
    // Reset by hand, then open a second window and let the first one report a cancel.
    await act(async () => again?.click());
    await act(async () => card(host, "A new number").click());
    await settle();
    await act(async () => stale?.({ authResponse: null }));
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 100))));
    expect(live(host)).toContain("If you do not see Meta's window");
  });

  test("an old window's cancel does not re-enable the cards of a newer attempt", async () => {
    const host = await mountChoices(20);
    const stale = await blockThenStartAgain(host);
    await act(async () => card(host, "A new number").click());
    await settle();
    await act(async () => stale?.({ authResponse: null }));
    expect(live(host)).toBe("");
    expect(card(host, "A new number").disabled).toBe(true);
  });

  test("a visibilitychange while the page is still visible does not stop the watchdog", async () => {
    const host = await mountChoices(20);
    await act(async () => card(host, "A new number").click());
    await settle();
    document.dispatchEvent(new Event("visibilitychange"));
    await wait(60);
    expect(live(host)).toContain("behind this one");
  });

  test("a remounted panel cannot exchange a second code while the first is in flight", async () => {
    let release: (value: unknown) => void = () => {};
    stubs.exchangeConnectCode = (input: unknown) => {
      exchanges.push((input as { data: { code: string; state: string } }).data);
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const first = await mountChoices();
    await act(async () => card(first, "A new number").click());
    await settle();
    const firstCallback = loginCallback;

    // The dialog is closed with X mid-flow and opened again.
    act(() => unmount?.());
    document.body.innerHTML = "";
    const second = await mountChoices();
    await act(async () => card(second, "A new number").click());
    await settle();
    const secondCallback = loginCallback;

    await act(async () => {
      firstCallback?.(FINISHED);
      secondCallback?.({ authResponse: { code: "code-2" } });
    });
    expect(exchanges).toEqual([{ code: "code-1", state: "state-1" }]);
    await act(async () => release(exchanged()));
    await settle();
    await act(async () => secondCallback?.({ authResponse: { code: "code-3" } }));
    await settle();
    expect(exchanges.length).toBe(1);
  });
});
