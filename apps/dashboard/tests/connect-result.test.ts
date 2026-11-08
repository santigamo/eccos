import { describe, expect, test } from "bun:test";
import type { ConnectExchangeResult } from "@eccos/gateway-contract";
import {
  CONNECT_CANCELLED_MESSAGE,
  CONNECT_POPUP_BLOCKED_MESSAGE,
  judgeExchange,
  returnPathFor,
} from "../src/lib/connect-result";

const phone = { waba_id: "100", phone_number_id: "200", display_phone_number: "+1 555 0100" };

function ok(over: Partial<Extract<ConnectExchangeResult, { ok: true }>> = {}): ConnectExchangeResult {
  return {
    ok: true,
    waba_id: "100",
    phone_number_id: "200",
    display_phone_number: "+1 555 0100",
    connected: [phone],
    status: "active",
    ...over,
  };
}

describe("judgeExchange", () => {
  test("active and pending with a number land on /numbers", () => {
    expect(judgeExchange(ok())).toEqual({ navigate: true, outcome: "ok", skipped: 0 });
    expect(judgeExchange(ok({ status: "pending" }))).toMatchObject({ navigate: true, outcome: "ok" });
  });

  test("a WABA without a number lands on /numbers, which explains it", () => {
    expect(judgeExchange(ok({ connected: [], phone_number_id: "" }))).toMatchObject({
      navigate: true,
      outcome: "no_number",
    });
  });

  test("failed provisioning lands on /numbers with no retry invitation", () => {
    expect(judgeExchange(ok({ status: "failed" }))).toMatchObject({
      navigate: true,
      outcome: "provisioning_failed",
    });
  });

  test("failed provisioning wins over an empty connected list", () => {
    expect(judgeExchange(ok({ status: "failed", connected: [] }))).toMatchObject({
      outcome: "provisioning_failed",
    });
  });

  test("skipped accounts are counted from the warnings", () => {
    expect(judgeExchange(ok({ warnings: ["a", "b"] }))).toMatchObject({ skipped: 2 });
    expect(returnPathFor("/numbers", 2)).toBe("/numbers?connectSkipped=2");
    expect(returnPathFor("/numbers", 0)).toBe("/numbers");
  });

  test("every gateway failure code says something and keeps its code", () => {
    for (const code of ["state", "denied", "owned", "no_waba", "failed"] as const) {
      const verdict = judgeExchange({ ok: false, error: "raw upstream text", code });
      expect(verdict).toMatchObject({ navigate: false, outcome: code });
      if (verdict.navigate) throw new Error("unreachable");
      expect(verdict.message.length).toBeGreaterThan(20);
      expect(verdict.message).not.toContain("raw upstream text");
    }
  });

  test("copy has no em dashes and never blames Meta for our own errors", () => {
    for (const m of [CONNECT_CANCELLED_MESSAGE, CONNECT_POPUP_BLOCKED_MESSAGE]) {
      expect(m).not.toContain("—");
    }
    const failed = judgeExchange({ ok: false, error: "x", code: "failed" });
    if (failed.navigate) throw new Error("unreachable");
    expect(failed.message).toBe("The connection could not be completed. Try again.");
  });
});
