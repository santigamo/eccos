import { describe, expect, test } from "bun:test";

import { clientGeneration, onClientReset, resetClientState } from "../src/hooks/client-state";
import { createReadCache } from "../src/hooks/read-cache";
import { isDenial, keepLastGood } from "../src/hooks/use-last-good";

const ok = <T>(data: T) => ({ ok: true as const, data });

function loader<T>(data: T) {
  let calls = 0;
  return {
    load: async () => {
      calls++;
      return ok(data);
    },
    calls: () => calls,
  };
}

describe("read cache", () => {
  test("concurrent reads of one key share a single load", async () => {
    const cache = createReadCache<string>(10_000);
    const a = loader("thread");
    const [first, second] = await Promise.all([cache.read("w:1", a.load), cache.read("w:1", a.load)]);
    expect(a.calls()).toBe(1);
    expect(first).toEqual(second);
  });

  test("a completed read is reused within the TTL and loaded again past it", async () => {
    let t = 0;
    const cache = createReadCache<string>(10_000, 50, () => t);
    const a = loader("thread");
    await cache.read("w:1", a.load);
    t = 9_999;
    await cache.read("w:1", a.load);
    expect(a.calls()).toBe(1);
    t = 10_000;
    await cache.read("w:1", a.load);
    expect(a.calls()).toBe(2);
  });

  test("peek returns the last completed read at any age", async () => {
    let t = 0;
    const cache = createReadCache<string>(10, 50, () => t);
    await cache.read("w:1", loader("thread").load);
    t = 60_000;
    expect(cache.peek("w:1")).toBe("thread");
    expect(cache.peek("w:2")).toBeUndefined();
  });

  test("force loads again and the older in-flight read cannot overwrite it", async () => {
    const cache = createReadCache<string>(10_000);
    let release!: () => void;
    const slow = cache.read("k", () => new Promise((resolve) => (release = () => resolve(ok("old")))));
    await cache.read("k", async () => ok("new"), true);
    release();
    await slow;
    expect(cache.peek("k")).toBe("new");
  });

  test("failures are not kept, and a rejection frees the key", async () => {
    const cache = createReadCache<string>(10_000);
    const failure = { ok: false as const, kind: "unreachable" as const, error: "boom" };
    await cache.read("k", async () => failure);
    expect(cache.peek("k")).toBeUndefined();
    await expect(cache.read("k", () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    const retry = loader("fine");
    await cache.read("k", retry.load);
    expect(retry.calls()).toBe(1);
  });

  test("clear starts a new generation: nothing kept or in flight survives", async () => {
    const cache = createReadCache<string>(10_000);
    await cache.read("k", loader("before").load);
    let release!: () => void;
    const pending = cache.read("p", () => new Promise((resolve) => (release = () => resolve(ok("late")))));
    cache.clear();
    expect(cache.peek("k")).toBeUndefined();
    release();
    await pending;
    expect(cache.peek("p")).toBeUndefined();
    const after = loader("after");
    await cache.read("k", after.load);
    expect(after.calls()).toBe(1);
  });

  test("the oldest entry is dropped past the cap", async () => {
    const cache = createReadCache<string>(10_000, 2);
    for (const k of ["a", "b", "c"]) await cache.read(k, loader(k).load);
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("c")).toBe("c");
  });
});

describe("client state", () => {
  test("a reset bumps the generation and tells the caches", () => {
    let cleared = 0;
    onClientReset(() => cleared++);
    const before = clientGeneration();
    resetClientState();
    expect(clientGeneration()).toBe(before + 1);
    expect(cleared).toBe(1);
  });
});

describe("last good by failure class", () => {
  const good = { scope: "s", data: "loaded" };
  const unreachable = { ok: false as const, kind: "unreachable" as const, error: "boom" };
  const unauthenticated = { ok: false as const, kind: "unauthenticated" as const, error: "no session" };
  const forbidden = { ok: false as const, kind: "forbidden" as const, error: "no access" };

  test("a transport failure keeps the data on screen", () => {
    expect(keepLastGood(good, unreachable, "s").shown).toEqual({ ok: true, data: "loaded", failure: unreachable });
  });

  test.each([unauthenticated, forbidden])("$kind shows only the denial and forgets the data", (denial) => {
    const next = keepLastGood(good, denial, "s");
    expect(next.shown).toBe(denial);
    expect(next.good).toBeNull();
    expect(keepLastGood(next.good, unreachable, "s").shown).toBe(unreachable);
  });

  test("only transport failures are not denials", () => {
    expect([unreachable, unauthenticated, forbidden].map(isDenial)).toEqual([false, true, true]);
  });
});
