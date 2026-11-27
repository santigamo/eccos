import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";

/**
 * The Send at cell after hydration, in a real DOM (happy-dom): a pending row reads
 * in the viewer's zone, which a static render never reaches.
 */

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SendAtCell } = await import("../src/components/scheduled/send-at-cell");
const { localTime, utcInstant } = await import("../src/lib/send-at");

afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const SEND_AT = Date.UTC(2026, 10, 28, 8, 0, 0, 123);

async function text(status: "pending" | "sent"): Promise<string> {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<SendAtCell row={{ status, sendAt: SEND_AT, expiresAt: SEND_AT + 3_600_000 }} />));
  const out = host.textContent ?? "";
  await act(async () => root.unmount());
  return out;
}

describe("SendAtCell in the browser", () => {
  test("a pending row reads local, zone named, over the UTC instant and its expiry", async () => {
    const at = localTime(SEND_AT);
    const out = await text("pending");
    expect(out).toContain(`${at.day}, ${at.clock} ${at.zone}`);
    expect(out).toContain(utcInstant(SEND_AT));
    expect(out).toContain("expires ");
    expect(out).not.toContain(".123Z");
  });

  test("an ended row stays exact UTC", async () => {
    expect(await text("sent")).toBe(new Date(SEND_AT).toISOString());
  });
});
