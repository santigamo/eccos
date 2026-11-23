import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

/** The one clipboard control (`components/dashboard/copy-button.tsx`). */

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CopyButton } = await import("../src/components/dashboard/copy-button");

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

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

async function clickCopy() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<CopyButton value="acc_123" />));
  unmount = () => root.unmount();
  const button = host.querySelector("button") as HTMLButtonElement;
  await act(async () => button.click());
  return button;
}

describe("CopyButton", () => {
  test("copies the value and says so", async () => {
    const copied: string[] = [];
    setClipboard({ writeText: async (text: string) => void copied.push(text) });
    const button = await clickCopy();
    expect(copied).toEqual(["acc_123"]);
    expect(button.textContent).toBe("Copied");
  });

  test("a refused write says it failed instead of rejecting unhandled", async () => {
    setClipboard({ writeText: async () => Promise.reject(new Error("denied")) });
    expect((await clickCopy()).textContent).toBe("Copy failed");
  });

  test("a browser with no clipboard API says it failed", async () => {
    setClipboard(undefined);
    expect((await clickCopy()).textContent).toBe("Copy failed");
  });

  test("the label comes back after a moment", async () => {
    setClipboard({ writeText: async () => {} });
    const button = await clickCopy();
    expect(button.textContent).toBe("Copied");
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 2_100))));
    expect(button.textContent).toBe("Copy");
  });
});
