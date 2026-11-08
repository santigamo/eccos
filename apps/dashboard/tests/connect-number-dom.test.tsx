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
const { ConnectNumberChoices } = await import("../src/components/dashboard/connect-number");

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

beforeEach(() => {
  navigated = [];
  loginCallback = null;
  loginCalls = 0;
  stubs = {
    ...real,
    getEmbeddedSignupConfig: async () => ({
      ok: true,
      data: { appId: "app", configId: "cfg", graphVersion: "v25.0" },
    }),
    startConnect: async () => ({
      ok: true,
      data: { state: "state-1", url: "https://gateway.test/connect" },
    }),
    exchangeConnectCode: async () => exchanged(),
    recordConnectSessionEvent: async () => ({ ok: true }),
  };
  (window as unknown as { FB: unknown }).FB = {
    init: () => {},
    login: (cb: LoginCallback) => {
      loginCalls += 1;
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
  mount(<ConnectNumberChoices navigate={(path) => navigated.push(path)} popupWatchdogMs={popupWatchdogMs} />);

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

  test("the SDK and the handoff are fetched before the click", async () => {
    let handoffs = 0;
    stubs.startConnect = async () => {
      handoffs += 1;
      return { ok: true, data: { state: "state-1", url: "https://gateway.test/connect" } };
    };
    const host = await mountChoices();
    expect(handoffs).toBe(1);
    await act(async () => card(host, "A new number").click());
    await settle();
    expect(handoffs).toBe(1);
    expect(loginCalls).toBe(1);
  });

  test("a blocked popup clears the spinner and says how to fix it", async () => {
    const host = await mountChoices(20);
    await act(async () => card(host, "A new number").click());
    await settle();
    expect(card(host, "A new number").disabled).toBe(true);
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 60))));
    expect(live(host)).toContain("Allow pop-ups");
    expect(card(host, "A new number").disabled).toBe(false);
    expect(navigated).toEqual([]);
  });

  test("a window that took focus is not a blocked popup", async () => {
    const host = await mountChoices(20);
    await act(async () => card(host, "A new number").click());
    await settle();
    window.dispatchEvent(new Event("blur"));
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 60))));
    expect(live(host)).toBe("");
    expect(card(host, "A new number").disabled).toBe(true);
  });
});
