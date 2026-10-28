import { describe, expect, test } from "bun:test";
import { watchRootFreshness } from "../src/hooks/use-root-refresh";

function target(visibility: DocumentVisibilityState) {
  const handlers: Record<string, Array<() => void>> = {};
  const on = (type: string, fn: () => void) => (handlers[type] ??= []).push(fn);
  const off = (type: string, fn: () => void) => {
    handlers[type] = (handlers[type] ?? []).filter((h) => h !== fn);
  };
  return {
    win: { addEventListener: on, removeEventListener: off } as unknown as Window,
    doc: { visibilityState: visibility, addEventListener: on, removeEventListener: off } as unknown as Document,
    fire: (type: string) => handlers[type]?.forEach((h) => h()),
  };
}

describe("watchRootFreshness", () => {
  test("refreshes on focus or visibility after 30s, not before", () => {
    const t = target("visible");
    let refreshes = 0;
    let now = 100_000;
    watchRootFreshness(t.win, t.doc, () => 100_000, () => refreshes++, 30_000, () => now);
    now = 120_000;
    t.fire("focus");
    expect(refreshes).toBe(0);
    now = 131_000;
    t.fire("focus");
    t.fire("visibilitychange");
    expect(refreshes).toBe(2);
  });

  test("a hidden tab does not refresh, and cleanup detaches", () => {
    const t = target("hidden");
    let refreshes = 0;
    const stop = watchRootFreshness(t.win, t.doc, () => 0, () => refreshes++, 30_000, () => 999_999);
    t.fire("visibilitychange");
    expect(refreshes).toBe(0);
    stop();
    (t.doc as { visibilityState: string }).visibilityState = "visible";
    t.fire("focus");
    expect(refreshes).toBe(0);
  });
});
