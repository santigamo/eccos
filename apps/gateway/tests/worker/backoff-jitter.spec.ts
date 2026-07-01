import { describe, expect, it } from "vitest";
import { backoffMs, withJitter } from "../../src/gateway";

// Pure unit tests for the F9 thundering-herd fix: `backoffMs` itself must stay an
// exact, deterministic curve (asserted elsewhere in alarm.spec.ts), while jitter is
// applied only where `next_attempt_at` is actually scheduled, via `withJitter`.

describe("withJitter", () => {
  it("stays within +/-10% of the base duration across many samples", () => {
    for (let i = 0; i < 200; i++) {
      const jittered = withJitter(5_000, Math.random);
      expect(jittered).toBeGreaterThanOrEqual(4_500);
      expect(jittered).toBeLessThanOrEqual(5_500);
    }
  });

  it("is deterministic for a given random source (bounds + midpoint)", () => {
    expect(withJitter(5_000, () => 0)).toBe(4_500);
    expect(withJitter(5_000, () => 1)).toBe(5_500);
    expect(withJitter(5_000, () => 0.5)).toBe(5_000);
  });

  it("scales with the base duration, including the capped backoff ceiling", () => {
    const capped = backoffMs(6); // 3_600_000ms, the 1-hour cap
    // withJitter rounds to an integer ms, so assert the exact rounded bounds
    // (capped * 1.1 carries float error: 3_960_000.0000000005).
    expect(withJitter(capped, () => 0)).toBe(3_240_000); // capped - 10%
    expect(withJitter(capped, () => 1)).toBe(3_960_000); // capped + 10%
  });

  it("does not mutate the deterministic backoffMs curve", () => {
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(2)).toBe(25_000);
    expect(backoffMs(3)).toBe(125_000);
    expect(backoffMs(6)).toBe(3_600_000);
  });
});
