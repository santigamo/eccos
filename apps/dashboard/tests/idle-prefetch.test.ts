import { beforeEach, describe, expect, test } from "bun:test";

import { idleRoutes, resetIdlePrefetch, startIdlePrefetch, type IdleEnv } from "../src/hooks/use-idle-prefetch";

function fakeEnv(skip = () => false) {
  let queued: (() => void) | null = null;
  const env: IdleEnv = { whenIdle: (run) => {
      queued = run;
      return () => {};
    },
    skip };
  return { env, flush: async () => queued?.(), queued: () => queued !== null };
}

beforeEach(resetIdlePrefetch);

describe("idleRoutes", () => {
  test("a ready workspace gets every destination except Meta-backed templates", () => {
    const routes = idleRoutes({ hasNumber: true, hasWaba: true });
    expect(routes).toContain("/conversations");
    expect(routes).toContain("/webhooks");
    expect(routes).not.toContain("/templates");
  });

  test("gated routes are skipped until their scope exists", () => {
    expect(idleRoutes({ hasNumber: false, hasWaba: true })).toEqual(["/numbers", "/webhooks", "/settings"]);
    expect(idleRoutes({ hasNumber: false, hasWaba: false })).toEqual(["/numbers", "/settings"]);
  });
});

describe("startIdlePrefetch", () => {
  test("waits for idle, then runs tasks strictly one at a time", async () => {
    const { env, flush, queued } = fakeEnv();
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (n: number) => async () => {
      peak = Math.max(peak, ++running);
      await Promise.resolve();
      order.push(n);
      running--;
    };
    startIdlePrefetch([task(1), task(2), task(3)], env);
    expect(order).toEqual([]);
    expect(queued()).toBe(true);
    await flush();
    expect(order).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
  });

  test("runs once per document", async () => {
    const first = fakeEnv();
    const second = fakeEnv();
    let calls = 0;
    const task = async () => void calls++;
    startIdlePrefetch([task], first.env);
    startIdlePrefetch([task], second.env);
    await first.flush();
    expect(second.queued()).toBe(false);
    expect(calls).toBe(1);
  });

  test("nothing to read leaves the once-guard free for when scope arrives", () => {
    startIdlePrefetch([], fakeEnv().env);
    const later = fakeEnv();
    startIdlePrefetch([async () => {}], later.env);
    expect(later.queued()).toBe(true);
  });

  test("saveData or a hidden tab stops the queue", async () => {
    const { env, flush } = fakeEnv(() => true);
    let calls = 0;
    startIdlePrefetch([async () => void calls++], env);
    await flush();
    expect(calls).toBe(0);
  });

  test("a tab hidden midway stops the rest; a failing task does not", async () => {
    let hidden = false;
    const { env, flush } = fakeEnv(() => hidden);
    const ran: string[] = [];
    startIdlePrefetch(
      [
        async () => {
          ran.push("a");
          throw new Error("boom");
        },
        async () => {
          ran.push("b");
          hidden = true;
        },
        async () => void ran.push("c"),
      ],
      env,
    );
    await flush();
    expect(ran).toEqual(["a", "b"]);
  });
});
