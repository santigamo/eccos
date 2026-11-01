import { describe, expect, test } from "bun:test";
import { PUBLIC_PATHS } from "../src/auth/redirect-target";
import { watchRootFreshness } from "../src/hooks/use-root-refresh";

function target(visibility: DocumentVisibilityState) {
  const handlers: Record<string, Array<() => void>> = {};
  const on = (type: string, fn: () => void) => {
    handlers[type] = [...(handlers[type] ?? []), fn];
  };
  const off = (type: string, fn: () => void) => {
    handlers[type] = (handlers[type] ?? []).filter((h) => h !== fn);
  };
  return {
    win: { addEventListener: on, removeEventListener: off } as unknown as Window,
    doc: { visibilityState: visibility, addEventListener: on, removeEventListener: off } as unknown as Document,
    fire: (type: string) => {
      for (const h of handlers[type] ?? []) h();
    },
  };
}

describe("watchRootFreshness", () => {
  test("refreshes on focus or visibility after 30s, not before", () => {
    const t = target("visible");
    let refreshes = 0;
    let now = 100_000;
    watchRootFreshness(t.win, t.doc, () => 100_000, () => "/numbers", () => refreshes++, 30_000, () => now);
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
    const stop = watchRootFreshness(t.win, t.doc, () => 0, () => "/numbers", () => refreshes++, 30_000, () => 999_999);
    t.fire("visibilitychange");
    expect(refreshes).toBe(0);
    stop();
    (t.doc as { visibilityState: string }).visibilityState = "visible";
    t.fire("focus");
    expect(refreshes).toBe(0);
  });

  test("never refreshes on a public auth page, so a reset token or half-filled form survives", () => {
    const t = target("visible");
    let refreshes = 0;
    let path = "/reset-password";
    watchRootFreshness(t.win, t.doc, () => 0, () => path, () => refreshes++, 30_000, () => 999_999);
    for (const page of PUBLIC_PATHS) {
      path = page;
      t.fire("focus");
      t.fire("visibilitychange");
    }
    expect(refreshes).toBe(0);
    // Signed in and navigated into the app: the same listeners refresh again.
    path = "/numbers";
    t.fire("focus");
    expect(refreshes).toBe(1);
  });
});
