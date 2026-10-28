import { describe, expect, test } from "bun:test";
import { createBootstrap } from "../src/lib/bootstrap";

describe("createBootstrap", () => {
  test("the guard's read is taken by the loader: one request per navigation", async () => {
    let calls = 0;
    const b = createBootstrap(async () => ++calls);
    const [a, c] = await Promise.all([b.read("w1"), b.read("w1")]);
    expect(a).toBe(1);
    expect(c).toBe(1);
    expect(await b.take("w1")).toBe(1);
    expect(calls).toBe(1);
  });

  test("a take with no guard read starts its own, and a second take reads again", async () => {
    let calls = 0;
    const b = createBootstrap(async () => ++calls);
    expect(await b.take("w1")).toBe(1);
    expect(await b.take("w1")).toBe(2);
  });

  test("scopes are independent", async () => {
    const b = createBootstrap(async (w) => w ?? "none");
    expect(await b.read("a")).toBe("a");
    expect(await b.read(undefined)).toBe("none");
    expect(await b.take("a")).toBe("a");
  });

  test("an unclaimed read expires, and a failed read is not kept", async () => {
    let t = 0;
    let calls = 0;
    const b = createBootstrap(async () => ++calls, () => t);
    await b.read("w1");
    t = 6_000;
    expect(await b.read("w1")).toBe(2);

    let fail = true;
    const f = createBootstrap(async () => {
      if (fail) throw new Error("down");
      return "ok";
    });
    await expect(f.read("w1")).rejects.toThrow("down");
    fail = false;
    expect(await f.read("w1")).toBe("ok");
  });
});
