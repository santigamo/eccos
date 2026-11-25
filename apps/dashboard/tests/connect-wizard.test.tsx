import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * The first-run connect wizard in a real DOM: the step flow, the clarifying
 * "which icon" branch, the live status (moved only by Meta's session events,
 * the FB.login callback and the exchange), and every troubleshooting screen.
 * Meta's SDK and the server functions are stubbed as in connect-number-dom.
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
  getConnectReadiness: gateway.getConnectReadiness as () => Promise<unknown>,
};
let stubs = { ...real };
mock.module("../src/server/gateway", () => ({
  ...gateway,
  getEmbeddedSignupConfig: () => stubs.getEmbeddedSignupConfig(),
  startConnect: () => stubs.startConnect(),
  exchangeConnectCode: (input: unknown) => stubs.exchangeConnectCode(input),
  recordConnectSessionEvent: (input: unknown) => stubs.recordConnectSessionEvent(input),
  getConnectReadiness: () => stubs.getConnectReadiness(),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ConnectWizard } = await import("../src/components/connect-wizard/connect-wizard");
const { resetConnectGuards } = await import("../src/components/dashboard/use-embedded-signup");

type LoginCallback = (response: { authResponse?: { code?: string } | null }) => void;

const exchanged = (over: Record<string, unknown> = {}) => ({
  ok: true,
  data: {
    ok: true,
    waba_id: "100",
    phone_number_id: "200",
    display_phone_number: "+34 612 345 678",
    connected: [{ waba_id: "100", phone_number_id: "200", display_phone_number: "+34 612 345 678" }],
    status: "active",
    ...over,
  },
});

let unmount: (() => void) | null = null;
let navigated: string[] = [];
let loginCallback: LoginCallback | null = null;
let loginCalls = 0;
let popup: { closed: boolean } | null = null;
const originalOpen = window.open;

beforeEach(() => {
  resetConnectGuards();
  navigated = [];
  loginCallback = null;
  loginCalls = 0;
  popup = { closed: false };
  stubs = {
    ...real,
    getEmbeddedSignupConfig: async () => ({ ok: true, data: { appId: "app", configId: "cfg", graphVersion: "v25.0" } }),
    startConnect: async () => ({
      ok: true,
      data: { state: "state-1", url: "https://gateway.test/connect", expiresAt: Date.now() + 60_000 },
    }),
    exchangeConnectCode: async () => exchanged(),
    recordConnectSessionEvent: async () => ({ ok: true }),
    getConnectReadiness: async () => ({ ok: true, data: { ready: true } }),
  };
  window.open = (() => popup) as unknown as typeof window.open;
  (window as unknown as { FB: unknown }).FB = {
    init: () => {},
    login: (cb: LoginCallback) => {
      loginCalls += 1;
      loginCallback = cb;
      window.open("https://www.facebook.com/", "_blank");
    },
  };
});

afterEach(() => {
  act(() => unmount?.());
  unmount = null;
  document.body.innerHTML = "";
  window.open = originalOpen;
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

const wizard = (props: Partial<Parameters<typeof ConnectWizard>[0]> = {}) =>
  mount(<ConnectWizard navigate={(path) => navigated.push(path)} abandonDelayMs={10} popupWatchdogMs={3_000} {...props} />);

function control(host: HTMLElement, text: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>("button, a, label")].find((el) => el.textContent?.includes(text));
  if (!found) throw new Error(`no control "${text}" in: ${host.textContent}`);
  return found;
}
const press = (host: HTMLElement, text: string) => act(async () => control(host, text).click());
const heading = (host: HTMLElement) => host.querySelector("h2")?.textContent ?? "";
const progress = (host: HTMLElement) => host.querySelector("p")?.textContent ?? "";

/** Post a session message as Meta's window. */
const post = (event: string, data: Record<string, unknown> = {}) =>
  act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://www.facebook.com",
        source: popup as unknown as MessageEventSource,
        data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event, data }),
      }),
    );
  });

/** Walk to "What Meta shows" for a path, and open Meta. */
async function openMeta(host: HTMLElement, path: "business-app" | "new-number" = "business-app") {
  await press(host, "I have them, continue");
  await press(host, path === "business-app" ? "In the WhatsApp Business app" : "It is a new number");
  await press(host, "Open Meta");
  await settle();
}

describe("the step flow", () => {
  test("get ready, your number, what Meta shows: progress, focus and Back", async () => {
    const host = await wizard();
    expect(progress(host)).toBe("Step 1 of 6 · Get ready");
    expect(heading(host)).toBe("Let's connect your WhatsApp number");
    expect(host.textContent).toContain("You do not need a card");

    await press(host, "I have them, continue");
    expect(progress(host)).toBe("Step 2 of 6 · Your number");
    expect(document.activeElement?.textContent).toBe("Where do you use this number today?");

    await press(host, "In the WhatsApp Business app");
    expect(progress(host)).toBe("Step 3 of 6 · What Meta shows");
    expect(host.textContent).toContain("Scan a square code with your phone");
    expect(host.textContent).not.toContain("Is this number on WhatsApp today?");

    await press(host, "Back");
    await press(host, "It is a new number");
    expect(host.textContent).toContain("Enter the code Meta sends you");
    // The new-number path warns before Meta opens: it takes a live number off the app.
    expect(host.textContent).toContain("Is this number on WhatsApp today?");
    expect(loginCalls).toBe(0);
  });

  test("on a phone, the first step recommends a computer (hidden from sm up)", async () => {
    const host = await wizard();
    const rail = [...host.querySelectorAll("div")].find((d) => d.textContent?.startsWith("This goes better on a computer"));
    expect(rail?.className).toContain("sm:hidden");
    expect(host.textContent).toContain("Copy the link to open there");
  });

  test("a closed workspace reads every step but cannot open Meta", async () => {
    const host = await wizard({ closed: true });
    await press(host, "I have them, continue");
    await press(host, "It is a new number");
    expect((control(host, "Open Meta") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a role that may not connect is told so on the step that opens Meta", async () => {
    const host = await wizard({ blocked: "missing-permission" });
    await press(host, "I have them, continue");
    await press(host, "In the WhatsApp Business app");
    expect(host.textContent).toContain("Your role in this workspace does not allow this");
    expect((control(host, "Open Meta") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the clarifying question", () => {
  test("the regular WhatsApp icon explains the move, then continues on the Business app path", async () => {
    const host = await wizard();
    await press(host, "I have them, continue");
    await press(host, "Help me check");
    expect(heading(host)).toBe("Which WhatsApp icon is on your phone?");
    expect(host.querySelectorAll('input[type="radio"]').length).toBe(2);
    expect(host.textContent).not.toContain("Continue");

    await press(host, "A phone inside a bubble");
    expect(host.textContent).toContain("Then move the number to WhatsApp Business first");
    expect(host.querySelectorAll("ol li").length).toBe(3);

    await press(host, "I moved it, continue");
    expect(progress(host)).toBe("Step 3 of 6 · What Meta shows");
    expect(host.textContent).toContain("Scan a square code");
  });

  test("the Business icon continues straight on; a different number goes back to the choice", async () => {
    const host = await wizard();
    await press(host, "I have them, continue");
    await press(host, "Help me check");
    await press(host, "A letter B inside a bubble");
    expect(host.textContent).not.toContain("Then move the number");
    await press(host, "Continue");
    expect(host.textContent).toContain("Scan a square code");

    await press(host, "Back");
    await press(host, "Help me check");
    await press(host, "A phone inside a bubble");
    await press(host, "Use a different number");
    expect(heading(host)).toBe("Where do you use this number today?");
  });
});

describe("the live connection status", () => {
  test("moves only on the window, Meta's answer and the exchange, then stops at connected", async () => {
    let finishExchange: (v: unknown) => void = () => {};
    stubs.exchangeConnectCode = () => new Promise((resolve) => (finishExchange = resolve));
    const onContinue = mock(() => {});
    const host = await wizard({ onContinue });
    await openMeta(host);
    expect(loginCalls).toBe(1);
    expect(progress(host)).toBe("Step 4 of 6 · Connect");
    expect(heading(host)).toBe("Meta's window is open");
    const current = () => host.querySelector('[aria-current="step"]')?.textContent ?? "";
    expect(current()).toContain("You finish Meta's four screens");
    expect(host.textContent).toContain("We cannot see inside Meta's window");

    // A session event from Meta's window changes nothing it does not say.
    await post("CANCEL", { current_step: "BUSINESS_PORTFOLIO" });
    expect(current()).toContain("You finish Meta's four screens");

    await act(async () => loginCallback?.({ authResponse: { code: "code-1" } }));
    await settle();
    expect(current()).toContain("Meta hands your number to Eccos");
    expect(host.textContent).not.toContain("Cancel and go back");

    await act(async () => finishExchange(exchanged()));
    await settle();
    expect(heading(host)).toBe("Your number is connected");
    expect(host.textContent).toContain("+34 612 345 678");
    expect(host.textContent).toContain("Nothing changed on your phone");
    expect(current()).toContain("Your first message goes through");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Meta handed your number to Eccos.");
    expect(navigated).toEqual([]);

    await press(host, "Continue");
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  test("Meta's FINISH event marks the screens done before the callback", async () => {
    const host = await wizard();
    await openMeta(host);
    await post("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING");
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain("Meta hands your number to Eccos");
  });

  test("with no onContinue, connected continues to the goal chooser on /setup", async () => {
    const host = await wizard();
    await openMeta(host);
    await act(async () => loginCallback?.({ authResponse: { code: "code-1" } }));
    await settle();
    await press(host, "Continue");
    expect(navigated).toEqual(["/setup"]);
  });

  test("anything short of a clean connect still lands on /numbers, where it is explained", async () => {
    stubs.exchangeConnectCode = async () => exchanged({ status: "failed" });
    const host = await wizard();
    await openMeta(host);
    await act(async () => loginCallback?.({ authResponse: { code: "code-1" } }));
    await settle();
    expect(navigated).toEqual(["/numbers"]);
  });

  test("an unobservable window says it is opening until Meta speaks", async () => {
    popup = null;
    window.open = (() => undefined) as unknown as typeof window.open;
    const host = await wizard();
    await openMeta(host);
    expect(heading(host)).toBe("Opening Meta's window");
    await post("CANCEL");
    expect(heading(host)).toBe("Meta's window is open");
  });

  test("a window behind this one offers the fix; cancel goes back to the brief", async () => {
    const host = await wizard({ popupWatchdogMs: 10 });
    document.hasFocus = () => true;
    await openMeta(host);
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 40))));
    expect(host.textContent).toContain("Don't see Meta's window?");
    await press(host, "Show me the fix");
    expect(host.textContent).toContain("Click the small icon of a window with a cross.");
    await press(host, "Cancel and go back");
    expect(heading(host)).toBe("This is what Meta will ask you");
  });
});

describe("troubleshooting", () => {
  async function reported(code: string) {
    const host = await wizard();
    await openMeta(host);
    await post("ERROR", { error_code: code, session_id: "f34b51d" });
    await act(async () => loginCallback?.({ authResponse: null }));
    await settle();
    return host;
  }

  test("another provider holds the number: a message to send them, and Meta's references", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    const host = await reported("3441067");
    expect(heading(host)).toBe("Another provider is still holding this number");
    expect(document.activeElement?.textContent).toBe("Another provider is still holding this number");
    expect(host.textContent).toContain("Meta error 3441067 · session f34b51d");
    await press(host, "Copy a message you can send them");
    await settle();
    expect(copied[0]).toContain("Please release it");
    expect(host.textContent).toContain("Still stuck? Write to me.");

    await press(host, "Try again");
    expect(loginCalls).toBe(2);
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  test("regular WhatsApp: the move, then a retry on the Business app path", async () => {
    const host = await wizard();
    await openMeta(host, "new-number");
    await post("ERROR", { error_code: "3441069" });
    await act(async () => loginCallback?.({ authResponse: null }));
    await settle();
    expect(heading(host)).toBe("This number is on regular WhatsApp, not WhatsApp Business");
    let options: unknown;
    (window as unknown as { FB: { login: unknown } }).FB.login = (cb: LoginCallback, opts: unknown) => {
      loginCallback = cb;
      options = opts;
    };
    await press(host, "I moved it, try again");
    expect(JSON.stringify(options)).toContain("whatsapp_business_app_onboarding");
  });

  test("the six-digit PIN is told apart from Meta's SMS code", async () => {
    const host = await reported("3441075");
    expect(heading(host)).toBe("Meta asked for a six-digit PIN");
    expect(host.textContent).toContain("It is not the code Meta sends by SMS.");
    expect(host.textContent).toContain("I forgot it, and the number is on my phone");
  });

  test("an error with no screen of its own is Meta's report, with a way out", async () => {
    const host = await reported("2655145");
    expect(host.textContent).toContain("Meta has restricted your Facebook account");
    await press(host, "Use a different number");
    expect(heading(host)).toBe("Where do you use this number today?");
  });

  test("the browser blocked the window: where the icon is, and Open Meta again", async () => {
    window.open = (() => null) as unknown as typeof window.open;
    const host = await wizard();
    await openMeta(host);
    expect(heading(host)).toBe("Your browser stopped Meta's window");
    expect(host.textContent).toContain(`Always allow pop-ups from ${window.location.host}`);
    await press(host, "I don't see that icon");
    expect(host.textContent).toContain("Site settings");
    window.open = (() => popup) as unknown as typeof window.open;
    await press(host, "Open Meta again");
    expect(heading(host)).toBe("Meta's window is open");
  });

  test("a window closed half way: nothing changed, find your case, and where it stopped", async () => {
    const host = await wizard();
    await openMeta(host);
    await post("CANCEL", { current_step: "WHATSAPP_BUSINESS_APP_ONBOARDING_QR_CODE" });
    await act(async () => loginCallback?.({ authResponse: null }));
    await settle();
    expect(heading(host)).toBe("Meta's window closed before the end");
    expect(host.textContent).toContain("I could not scan the square code");
    expect(host.textContent).toContain("Closed at the QR code screen");
    expect(host.textContent).not.toContain("email");
  });

  test("a failed exchange is shown in the console's words", async () => {
    stubs.exchangeConnectCode = async () => ({ ok: true, data: { ok: false, code: "owned", error: "raw" } });
    const host = await wizard();
    await openMeta(host);
    await act(async () => loginCallback?.({ authResponse: { code: "code-1" } }));
    await settle();
    expect(heading(host)).toBe("The connection did not finish");
    expect(host.textContent).toContain("already connected to another Eccos workspace");
    expect(host.textContent).not.toContain("raw");
  });

  test("write to Santi: their words and the technical part, sent through a mailto", async () => {
    const host = await reported("3441067");
    await press(host, "Write to Santi");
    expect(heading(host)).toBe("Write to me and we will fix it together");
    expect(progress(host)).toBe("Step 4 of 6 · Connect");
    expect(host.textContent).toContain("Path: WhatsApp Business app");
    expect(host.textContent).toContain("Meta error 3441067 · session f34b51d");
    const field = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(host.querySelector(`label[for="${field.id}"]`)?.textContent).toBe("What happened?");
    const send = control(host, "Send to Santi") as HTMLAnchorElement;
    expect(send.getAttribute("href")).toStartWith("mailto:santi@eccos.chat?");
    expect(decodeURIComponent(send.getAttribute("href") ?? "")).toContain("Meta error 3441067");
    await press(host, "Back");
    expect(heading(host)).toBe("Another provider is still holding this number");
  });
});
