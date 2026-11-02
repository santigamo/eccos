import { describe, expect, test } from "bun:test";
import { checkSendRate } from "../src/send-rate-limit";

function limiter(success = true) {
  const calls: { key: string }[] = [];
  const limit = async (o: { key: string }) => {
    calls.push(o);
    return { success };
  };
  return { calls, binding: { limit } as RateLimit };
}

describe("checkSendRate", () => {
  test("a listed account uses the HIGH binding", async () => {
    const std = limiter();
    const high = limiter();
    const env = { SEND_RATE_LIMITER: std.binding, SEND_RATE_LIMITER_HIGH: high.binding, HIGH_THROUGHPUT_ACCOUNTS: "a1, a2" };
    expect(await checkSendRate(env, "a2", "W1")).toBe(true);
    expect(high.calls).toEqual([{ key: "a2:W1" }]);
    expect(std.calls).toHaveLength(0);
  });

  test("an unlisted account uses the standard binding", async () => {
    const std = limiter(false);
    const high = limiter();
    const env = { SEND_RATE_LIMITER: std.binding, SEND_RATE_LIMITER_HIGH: high.binding, HIGH_THROUGHPUT_ACCOUNTS: "a1" };
    expect(await checkSendRate(env, "a3", "W1")).toBe(false);
    expect(std.calls).toEqual([{ key: "a3:W1" }]);
    expect(high.calls).toHaveLength(0);
  });

  test("a listed account without a HIGH binding falls back to standard", async () => {
    const std = limiter();
    expect(await checkSendRate({ SEND_RATE_LIMITER: std.binding, HIGH_THROUGHPUT_ACCOUNTS: "a1" }, "a1", "W1")).toBe(true);
    expect(std.calls).toEqual([{ key: "a1:W1" }]);
  });

  test("an empty list never selects HIGH, and no binding means no limit", async () => {
    const std = limiter();
    const high = limiter();
    await checkSendRate({ SEND_RATE_LIMITER: std.binding, SEND_RATE_LIMITER_HIGH: high.binding, HIGH_THROUGHPUT_ACCOUNTS: "" }, "", "W1");
    expect(high.calls).toHaveLength(0);
    expect(std.calls).toHaveLength(1);
    expect(await checkSendRate({}, "a1", "W1")).toBe(true);
  });
});
