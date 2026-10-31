/**
 * eccos-r8x0: a failed forward has to reach the operator. Each failed attempt
 * writes one structured log line, and a delivery that exhausts its attempts
 * feeds a throttled Telegram HQ alert (off here: the test env sets no
 * OPS_TELEGRAM_* secret, so nothing may leave for api.telegram.org).
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EccosGateway, OPS_ALERT_INTERVAL_MS } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { alarmOf, bootstrapAccount, gatewayStub, holdAlarms, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

beforeEach(async () => {
  await bootstrapAccount();
  await holdAlarms();
});

describe("failed-delivery alert throttle", () => {
  it("sends the first alert, then counts quietly until the window has passed", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const t0 = 1_800_000_000_000;
      expect(i.recordOpsAlert("failure", t0)).toEqual({ send: true, count: 1 });
      expect(i.recordOpsAlert("failure", t0 + 1_000)).toEqual({ send: false, count: 1 });
      expect(i.recordOpsAlert("failure", t0 + 2_000)).toEqual({ send: false, count: 2 });
      // The next alert reports the two it held back plus its own.
      expect(i.recordOpsAlert("failure", t0 + OPS_ALERT_INTERVAL_MS)).toEqual({ send: true, count: 3 });
    });
  });

  it("keeps its bookkeeping out of the config the console reads", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.recordOpsAlert("failure", 1_800_000_000_000);
    });
    const config = await new GatewayRPC(createExecutionContext(), env).getConfig(TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(Object.keys(config).some((key) => key.includes("alert") || key.includes("failures"))).toBe(false);
  });
});

describe("a delivery that exhausts its attempts", () => {
  it("logs every failed attempt and reaches the alert path without calling Telegram", async () => {
    await new GatewayRPC(createExecutionContext(), env).setSubscriberConfig(
      { url: "https://subscriber.example/hook" },
      TEST_WABA_ID,
      TEST_ACCOUNT_ID,
    );
    await gatewayStub().ingest([
      { type: "reply", from: "34600000000", messageId: "wamid.OPS", text: "hello", at: 1_700_000_000_000 },
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      // FORWARD_MAX_ATTEMPTS is 3 in the test bindings; make each retry due now.
      for (let attempt = 0; attempt < 3; attempt++) {
        i.sql.exec("UPDATE deliveries SET next_attempt_at = 0 WHERE status = 'pending'");
        await alarmOf(i);
      }
      expect(i.getDelivery(1)).toMatchObject({ status: "failed", last_error: "subscriber returned 503" });
      // The terminal failure was counted, so the next one inside the window is held.
      expect(i.recordOpsAlert("failure", Date.now())).toEqual({ send: false, count: 1 });
    });

    const lines = warn.mock.calls
      .map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
      .filter((line) => line?.area === "forward");
    expect(lines.map((line) => line.event)).toEqual(["attempt-failed", "attempt-failed", "delivery-failed"]);
    expect(lines[2]).toMatchObject({ deliveryId: 1, attempt: 3, error: "subscriber returned 503" });
    // The object knows which WABA it serves (its idFromName name), so the line is actionable.
    expect(lines[2].wabaId).toContain(TEST_WABA_ID);
    expect(lines[2]).toMatchObject({ httpStatus: 503, phoneNumberId: null });
    expect(lines[2].durationMs).toBeTypeOf("number");
    // Identifiers only: the forwarded text never reaches the log.
    expect(JSON.stringify(lines)).not.toContain("hello");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("api.telegram.org"))).toBe(false);
  });
});
