import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/** The admin's side of a connection link: its dialog on /numbers. */

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ConnectLinkPanel } = await import("../src/components/dashboard/connect-link-dialog");

type Load = NonNullable<Parameters<typeof ConnectLinkPanel>[0]["load"]>;
const URL_1 = "http://localhost:3000/connect#0123456789abcdef.first";
const URL_2 = "http://localhost:3000/connect#0123456789abcdef.second";
const pending = { state: "pending" as const, expiresAt: 1, connectedPhone: null, creatorUserId: "user-1" };

let unmount: (() => void) | null = null;

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

async function mount(load: (fresh: boolean) => unknown) {
  const asked: boolean[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const seam = (async ({ data }: { data: { fresh: boolean } }) => {
    asked.push(data.fresh);
    return load(data.fresh);
  }) as unknown as Load;
  await act(async () => root.render(<ConnectLinkPanel load={seam} />));
  unmount = () => root.unmount();
  await settle();
  return asked;
}

const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;

describe("ConnectLinkPanel", () => {
  test("shows a fresh link ready to copy, with its status", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    const asked = await mount(() => ({ ok: true, data: { link: pending, url: URL_1 } }));
    expect(asked).toEqual([false]);
    expect(document.body.textContent).toContain(URL_1);
    expect(document.body.textContent).toContain("Not opened yet");
    await act(async () => button("Copy link").click());
    await settle();
    expect(copied).toEqual([URL_1]);
    expect(button("Copied")).toBeDefined();
  });

  test("an existing link shows its status but cannot be copied again", async () => {
    await mount(() => ({ ok: true, data: { link: { ...pending, state: "opened" }, url: null } }));
    expect(document.body.textContent).toContain("Opened, not finished");
    expect(document.body.textContent).toContain(
      "This link was sent already. Make a new one to get its address again; the old one stops working.",
    );
    // No dead Copy button: making a new link is the one thing left, so it is the primary action.
    expect(button("Copy link")).toBeUndefined();
    expect(button("New link").className).toContain("bg-primary");
  });

  test("a link mid-connection is not replaced, and the dialog says why", async () => {
    await mount((fresh) => ({
      ok: true,
      data: { link: { ...pending, state: "opened" }, url: null, ...(fresh ? { busy: true } : {}) },
    }));
    await act(async () => button("New link").click());
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("in progress");
  });

  test("a second click while a request is out does not ask twice", async () => {
    let release: (value: unknown) => void = () => {};
    const asked = await mount((fresh) =>
      fresh
        ? new Promise((resolve) => {
            release = resolve;
          })
        : { ok: true, data: { link: pending, url: URL_1 } },
    );
    await act(async () => {
      button("New link").click();
      button("New link").click();
    });
    await act(async () => release({ ok: true, data: { link: pending, url: URL_2 } }));
    await settle();
    expect(asked).toEqual([false, true]);
  });

  test("a used link reads as connected, with the number", async () => {
    await mount(() => ({
      ok: true,
      data: { link: { state: "connected", expiresAt: 1, connectedPhone: "+34 600 000 222" }, url: null },
    }));
    expect(document.body.textContent).toContain("Connected +34 600 000 222");
  });

  test("New link asks for a replacement and shows the new address", async () => {
    const asked = await mount((fresh) => ({ ok: true, data: { link: pending, url: fresh ? URL_2 : URL_1 } }));
    await act(async () => button("New link").click());
    await settle();
    expect(asked).toEqual([false, true]);
    expect(document.body.textContent).toContain(URL_2);
    expect(document.body.textContent).not.toContain(URL_1);
  });

  test("a role that may not connect gets the refusal, and nothing to copy", async () => {
    await mount(() => ({ ok: false, kind: "forbidden", reason: "missing-permission", error: "no" }));
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
    expect(button("Copy link")).toBeUndefined();
  });
});
