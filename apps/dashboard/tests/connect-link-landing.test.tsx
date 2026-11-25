import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LinkOutcome, LinkStart, LinkView } from "../src/lib/connect-link/api";

/**
 * The connection link's landing page through a real DOM: what its reader is
 * told in each state, and what reaches the server, and when.
 */

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { ConnectLinkLanding } = await import("../src/components/connect-link/landing");
const { en } = await import("../src/lib/connect-link/en");
const { es } = await import("../src/lib/connect-link/es");
const { COEXISTENCE_FEATURE_TYPE } = await import("../src/lib/embedded-signup");

type LoginCallback = (response: { authResponse?: { code?: string } | null }) => void;
type Api = Parameters<typeof ConnectLinkLanding>[0]["api"];

const READY: LinkView = {
  status: "ready",
  workspace: "NACEX 2801",
  inviter: "Rubén",
  closed: false,
  signup: { appId: "app", configId: "cfg", graphVersion: "v25.0" },
};

let calls: string[];
let view: LinkView | "limited" | "unreachable";
let start: LinkStart;
let outcome: LinkOutcome | "unreachable";
/** Answers the exchange gives before `outcome`, in order. */
let earlier: LinkOutcome[];
let login: { callback: LoginCallback; options: { extras?: { featureType?: string } } } | null;
let events: unknown[];
let forgotten: boolean[];
let unmount: (() => void) | null = null;

const api = {
  view: async () => {
    calls.push("view");
    return view;
  },
  start: async () => {
    calls.push("start");
    return start;
  },
  exchange: async (_token: string, code: string, state: string) => {
    calls.push(`exchange:${code}:${state}`);
    return earlier.shift() ?? outcome;
  },
  event: (_token: string, event: unknown) => void events.push(event),
} as NonNullable<Api>;

const sdk = {
  init: () => {},
  login: (callback: LoginCallback, options: object) => {
    calls.push("login");
    login = { callback, options };
  },
};

beforeEach(() => {
  calls = [];
  events = [];
  forgotten = [];
  login = null;
  view = READY;
  start = { ok: true, state: "state-1" };
  outcome = { outcome: "connected", phone: "+34 600 000 222" };
  earlier = [];
  window.open = (() => ({ closed: false })) as unknown as typeof window.open;
});

afterEach(() => {
  act(() => unmount?.());
  unmount = null;
  document.body.innerHTML = "";
});

afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 5))));

async function mount(copy = en, token: string | null = "tok"): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <ConnectLinkLanding
        copy={copy}
        api={api}
        readToken={() => token}
        forgetToken={() => void forgotten.push(true)}
        loadSdk={async () => sdk}
        busyRetryMs={1}
      />,
    ),
  );
  unmount = () => root.unmount();
  await settle();
  return host;
}

/** The connect button: the last one, after a Copy that Meta's error may bring. */
const button = (host: HTMLElement) => ([...host.querySelectorAll("button")].at(-1) ?? null) as HTMLButtonElement | null;

async function click(host: HTMLElement) {
  await act(async () => button(host)?.click());
  await settle();
}

async function answer(response: Parameters<LoginCallback>[0]) {
  await act(async () => login?.callback(response));
  await settle();
}

describe("the landing", () => {
  test("rendering the page calls nothing: a link preview has no side effect", () => {
    const html = renderToString(<ConnectLinkLanding copy={es} api={api} readToken={() => "tok"} />);
    expect(html).toContain(es.loading);
    expect(html).toContain('lang="es"');
    expect(calls).toEqual([]);
  });

  test("names the inviter and the workspace in the intro, in the page's language", async () => {
    const host = await mount(es);
    expect(host.textContent).toContain(
      "Rubén te pide conectar a NACEX 2801 el número de tu app WhatsApp Business. La app seguirá funcionando igual.",
    );
    expect(host.querySelectorAll("strong")[0]?.textContent).toBe("Rubén");
    expect(host.querySelectorAll("li")).toHaveLength(2);
    expect(button(host)?.textContent).toBe("Conectar con Meta");
    expect(host.textContent).toContain(es.ownership);
    expect(calls).toEqual(["view"]);
  });

  test("opens Meta on the Business app path, and only then asks for a state", async () => {
    const host = await mount();
    await click(host);
    expect(calls).toEqual(["view", "login", "start"]);
    expect(login?.options.extras?.featureType).toBe(COEXISTENCE_FEATURE_TYPE);
    expect(button(host)?.disabled).toBe(true);
  });

  test("a finished flow exchanges the code and says the number is connected", async () => {
    const host = await mount();
    await click(host);
    await answer({ authResponse: { code: "meta-code" } });
    expect(calls.at(-1)).toBe("exchange:meta-code:state-1");
    expect(host.textContent).toContain("Connected.");
    expect(host.textContent).toContain("+34 600 000 222 now works with NACEX 2801");
    expect(button(host)).toBeNull();
  });

  test("closing Meta's window connects nothing and leaves the link usable", async () => {
    const host = await mount();
    await click(host);
    await answer({ authResponse: null });
    expect(host.textContent).toContain(en.cancelled);
    expect(host.textContent).not.toContain(en.notConnected);
    expect(host.textContent).toContain(en.release.lead);
    expect(calls).not.toContain("exchange");
    expect(button(host)?.disabled).toBe(false);
  });

  const reportError = (code: string) =>
    act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://www.facebook.com",
          data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "ERROR", data: { error_code: code, session_id: "f34b51d" } }),
        }),
      );
    });

  test("an error Meta reports just after its window closed still replaces the cancel note", async () => {
    const host = await mount(es);
    await click(host);
    await answer({ authResponse: null });
    expect(host.querySelector("output")?.textContent).toContain(es.cancelled);
    await reportError("3441067");
    const said = host.querySelector("output")?.textContent ?? "";
    expect(said).toContain("Otro porfolio empresarial tiene este número");
    expect(said).toContain("Error de Meta 3441067 · sesión f34b51d");
  });

  test("an error Meta reported explains itself in the page's language, with Meta's references", async () => {
    const host = await mount(es);
    await click(host);
    await reportError("3441067");
    await answer({ authResponse: null });
    const said = host.querySelector("output")?.textContent ?? "";
    expect(said).toContain("No conectado");
    expect(said).toContain("Otro porfolio empresarial tiene este número");
    expect(said).toContain("Suele ser tu proveedor de WhatsApp anterior. Pide que libere el número y vuelve a este mismo enlace.");
    expect(said).toContain("Error de Meta 3441067 · sesión f34b51d");
    // The error replaces the intro, the list and the heads-up; the button stays.
    expect(host.textContent).not.toContain(es.release.lead);
    expect(host.textContent).not.toContain(es.beforeTitle);
    expect(host.textContent).not.toContain(es.intro[1]);
    expect(button(host)?.textContent).toBe(es.button);
    expect(button(host)?.disabled).toBe(false);
  });

  test("an unknown error gets the generic title, the cancel note and Meta's references", async () => {
    const host = await mount();
    await click(host);
    await reportError("524126");
    await answer({ authResponse: null });
    const said = host.querySelector("output")?.textContent ?? "";
    expect(said).toContain(en.unknownError);
    expect(said).toContain(en.cancelled);
    expect(said).toContain("Meta error 524126 · session f34b51d");
  });

  test("Copy puts Meta's references on the clipboard, in the page's language", async () => {
    const copied: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    try {
      const host = await mount(es);
      await click(host);
      await reportError("3441067");
      await answer({ authResponse: null });
      const copy = [...host.querySelectorAll("button")].find((b) => b.textContent === "Copiar");
      if (!copy) throw new Error("no Copiar button");
      await act(async () => copy.click());
      await settle();
      expect(copied).toEqual(["Error de Meta 3441067 · sesión f34b51d"]);
      expect(copy.textContent).toBe("Copiado");
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  test("says to release a number another provider holds, before Meta opens", async () => {
    expect((await mount(es)).textContent).toContain(`${es.release.lead} ${es.release.rest}`);
    act(() => unmount?.());
    expect((await mount()).textContent).toContain(`${en.release.lead} ${en.release.rest}`);
  });

  test("each refusal reads in its own words and keeps the button", async () => {
    const said: Array<[LinkOutcome, string]> = [
      [{ outcome: "owned" }, en.owned("Rubén")],
      [{ outcome: "no_waba" }, en.noWaba],
      [{ outcome: "subscription_required" }, en.closed("Rubén")],
      [{ outcome: "state" }, en.attemptExpired],
      [{ outcome: "failed" }, en.failed],
    ];
    for (const [result, text] of said) {
      outcome = result;
      const host = await mount();
      await click(host);
      await answer({ authResponse: { code: "c" } });
      expect(host.textContent).toContain(text);
      expect(button(host)?.disabled).toBe(false);
      act(() => unmount?.());
    }
  });

  test("a registration whose number is not ready hands over to the inviter", async () => {
    outcome = { outcome: "pending" };
    const host = await mount();
    await click(host);
    await answer({ authResponse: { code: "c" } });
    expect(host.textContent).toContain(en.pending("Rubén"));
    expect(button(host)).toBeNull();
  });

  test("an exchange with no known result is being checked: no button, no 'start again'", async () => {
    for (const result of [{ outcome: "unknown" } as const, "unreachable" as const]) {
      outcome = result;
      const host = await mount();
      await click(host);
      await answer({ authResponse: { code: "c" } });
      expect(host.textContent).toContain(en.unknown("Rubén"));
      expect(button(host)).toBeNull();
      act(() => unmount?.());
    }
  });

  test("a link held by another exchange is retried with the same code, then says it is busy", async () => {
    earlier = [{ outcome: "busy" }];
    const retried = await mount();
    await click(retried);
    await answer({ authResponse: { code: "c" } });
    await settle();
    expect(calls.filter((call) => call === "exchange:c:state-1")).toHaveLength(2);
    expect(retried.textContent).toContain("Connected.");
    act(() => unmount?.());

    outcome = { outcome: "busy" };
    const held = await mount();
    await click(held);
    await answer({ authResponse: { code: "c" } });
    await settle();
    expect(held.textContent).toContain(en.busy);
    expect(held.textContent).not.toContain(en.gone("Rubén"));
    expect(button(held)?.disabled).toBe(false);
  });

  test("Meta answering inside login, before a state exists, never leaves the page connecting", async () => {
    const eager = { ...sdk, login: (callback: LoginCallback) => callback({ authResponse: { code: "early" } }) };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(<ConnectLinkLanding copy={en} api={api} readToken={() => "tok"} loadSdk={async () => eager} />),
    );
    unmount = () => root.unmount();
    await settle();
    await click(host);
    expect(host.textContent).toContain(en.notPrepared);
    expect(button(host)?.disabled).toBe(false);
    expect(button(host)?.textContent).toBe(en.button);
    expect(calls).toEqual(["view"]);
  });

  test("a closed workspace says so and never offers Meta", async () => {
    view = { ...READY, closed: true };
    const host = await mount();
    expect(host.textContent).toContain("This workspace cannot add numbers right now. Tell Rubén.");
    expect(button(host)).toBeNull();
    expect(calls).toEqual(["view"]);
  });

  test("numbers left out are said after the connected line", async () => {
    outcome = { outcome: "connected", phone: "+34 600 000 222", leftOut: true };
    const host = await mount();
    await click(host);
    await answer({ authResponse: { code: "c" } });
    expect(host.textContent).toContain("+34 600 000 222 now works with NACEX 2801");
    expect(host.textContent).toContain(en.leftOut("Rubén"));
  });

  test("a link that asks too often for a state is told to wait", async () => {
    const limitedStart = { ...api, start: async () => "limited" as const };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(<ConnectLinkLanding copy={en} api={limitedStart} readToken={() => "tok"} forgetToken={() => {}} loadSdk={async () => sdk} />),
    );
    unmount = () => root.unmount();
    await settle();
    await click(host);
    expect(host.textContent).toContain(en.limited);
    expect(button(host)?.disabled).toBe(false);
  });

  test("a spent, expired or unknown link says who to ask", async () => {
    view = { status: "gone", inviter: "Rubén" };
    expect((await mount()).textContent).toContain("This link no longer works. Ask Rubén for a new one.");
    // And the stored token goes with it, so a reload does not present it again.
    expect(forgotten.length).toBeGreaterThan(0);
    act(() => unmount?.());
    view = { status: "gone", inviter: null };
    expect((await mount()).textContent).toContain(en.gone(en.sender));
    act(() => unmount?.());
    calls = [];
    expect((await mount(en, null)).textContent).toContain(en.gone(en.sender));
    expect(calls).toEqual([]);
  });

  test("a link that dies mid-flow replaces the page with the same message", async () => {
    start = { ok: false, code: "gone" };
    const host = await mount();
    await click(host);
    expect(host.textContent).toContain(en.gone("Rubén"));
    await answer({ authResponse: { code: "late" } });
    expect(calls).not.toContain("exchange:late:state-1");
  });

  test("a blocked pop-up mints no state", async () => {
    window.open = (() => null) as unknown as typeof window.open;
    const opening = { ...sdk, login: () => void window.open("https://facebook.com") };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(<ConnectLinkLanding copy={en} api={api} readToken={() => "tok"} loadSdk={async () => opening} />),
    );
    unmount = () => root.unmount();
    await settle();
    await click(host);
    expect(host.textContent).toContain("Your browser blocked Meta's window");
    expect(calls).toEqual(["view"]);
  });

  test("too many attempts and a dead connection each say what to do", async () => {
    view = "limited";
    expect((await mount()).textContent).toContain(en.limited);
    act(() => unmount?.());
    view = "unreachable";
    expect((await mount()).textContent).toContain(en.unreachable);
  });

  test("Meta's session events are recorded; anything else posted to the page is not", async () => {
    await mount();
    const post = (origin: string) =>
      act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin,
            data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "QR" } }),
          }),
        );
      });
    await post("https://evil-facebook.com");
    await post("https://www.facebook.com");
    expect(events).toEqual([{ event: "CANCEL", currentStep: "QR" }]);
  });
});
