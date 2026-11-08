import { describe, expect, test } from "bun:test";
import type { ConnectExchangeResult } from "@eccos/gateway-contract";
import { CONNECT_CANCELLED_MESSAGE, judgeExchange } from "../src/components/dashboard/connect-result";

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
  test("active and pending with a number are connected", () => {
    expect(judgeExchange(ok())).toEqual({ connected: true });
    expect(judgeExchange(ok({ status: "pending" }))).toEqual({ connected: true });
  });

  test("a WABA without a number is not a connection", () => {
    const verdict = judgeExchange(ok({ connected: [], phone_number_id: "" }));
    expect(verdict).toMatchObject({ connected: false, outcome: "no_number" });
  });

  test("failed provisioning is not a connection", () => {
    const verdict = judgeExchange(ok({ status: "failed" }));
    expect(verdict).toMatchObject({ connected: false, outcome: "provisioning_failed" });
  });

  test("every gateway failure code says something and keeps its code", () => {
    for (const code of ["state", "denied", "owned", "no_waba", "failed"] as const) {
      const verdict = judgeExchange({ ok: false, error: "raw upstream text", code });
      expect(verdict).toMatchObject({ connected: false, outcome: code });
      if (verdict.connected) throw new Error("unreachable");
      expect(verdict.message.length).toBeGreaterThan(20);
      expect(verdict.message).not.toContain("raw upstream text");
    }
  });

  test("copy has no em dashes and the cancel note is not an error", () => {
    const messages = [CONNECT_CANCELLED_MESSAGE];
    for (const r of [ok({ connected: [] }), ok({ status: "failed" })]) {
      const v = judgeExchange(r);
      if (!v.connected) messages.push(v.message);
    }
    for (const m of messages) expect(m).not.toContain("—");
    expect(CONNECT_CANCELLED_MESSAGE).toContain("Nothing changed");
  });
});
