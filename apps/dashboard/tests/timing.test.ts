import { describe, expect, test } from "bun:test";
import { beginTiming, finishTiming, timed, timedProxy } from "../src/server/timing";

describe("timing", () => {
  test("records stages, sums repeats and formats Server-Timing", async () => {
    const request = new Request("https://example.test/");
    beginTiming(request);
    await timed(request.headers, "auth-session", async () => {});
    await timed(request.headers, "rpc-a", async () => {});
    await timed(request.headers, "rpc-a", async () => {});
    const report = finishTiming(request)!;
    expect(report.header).toMatch(
      /^auth-session;dur=[\d.]+, rpc-a;dur=[\d.]+;desc="2x", total;dur=[\d.]+$/,
    );
    expect(report.counts).toEqual({ "rpc-a": 2 });
    expect(finishTiming(request)).toBeNull();
  });

  test("is a transparent no-op without an active request and preserves errors", async () => {
    expect(await timed(new Headers(), "x", async () => 7)).toBe(7);
    expect(await timed(undefined, "x", async () => 8)).toBe(8);
    const request = new Request("https://example.test/");
    beginTiming(request);
    await expect(timed(request, "boom", () => Promise.reject(new Error("e")))).rejects.toThrow("e");
    expect(finishTiming(request)!.stages).toHaveProperty("boom");
  });

  test("timedProxy times every method and keeps results", async () => {
    const request = new Request("https://example.test/");
    beginTiming(request);
    const api = timedProxy(request.headers, { ping: async (n: number) => n + 1, tag: "t" }, "rpc-");
    expect(await api.ping(1)).toBe(2);
    expect(api.tag).toBe("t");
    expect(Object.keys(finishTiming(request)!.stages)).toEqual(["rpc-ping"]);
  });

  test("calls an RPC-stub-like target as a method, never through .apply/.call", async () => {
    // A service-binding stub answers every property with a remote method,
    // `apply` and `call` included.
    const remote = (name: string): unknown =>
      new Proxy(async (n: number) => `${name}:${n}`, { get: (_t, prop) => remote(String(prop)) });
    const stub = new Proxy({}, { get: (_t, prop) => remote(String(prop)) }) as { ping: (n: number) => Promise<string> };
    const request = new Request("https://example.test/");
    beginTiming(request);
    expect(await timedProxy(request.headers, stub, "rpc-").ping(1)).toBe("ping:1");
    finishTiming(request);
  });
});
