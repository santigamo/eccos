/**
 * eccos-r92o: bulk re-enqueue of failed deliveries inside an explicit window,
 * the recovery step after a gateway fault (eccos-ugb6 failed every forward).
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EccosGateway, REDACTED_PAYLOAD } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount, gatewayStub, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

afterEach(async () => {
  await reset();
});

beforeEach(async () => {
  await bootstrapAccount();
});

const FROM = 1_800_000_000_000;
const TO = FROM + 60_000;

function seed(i: EccosGateway): void {
  const insert = (id: number, status: string, createdAt: number, payload = '{"events":[]}') =>
    i.sql.exec(
      `INSERT INTO deliveries (id, phone_number_id, payload, status, attempts, last_error, next_attempt_at, created_at, finished_at)
       VALUES (?, 'PN', ?, ?, 6, 'Invalid redirect value', 0, ?, ?)`,
      id,
      payload,
      status,
      createdAt,
      status === "pending" ? null : createdAt + 1,
    );
  insert(1, "failed", FROM);
  insert(2, "failed", TO);
  insert(3, "failed", TO + 1); // outside the window
  insert(4, "failed", FROM + 10, REDACTED_PAYLOAD); // content already pruned
  insert(5, "delivered", FROM + 20);
  insert(6, "pending", FROM + 30);
}

describe("retryFailedDeliveries", () => {
  it("re-enqueues only the replayable failed rows inside the window", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => seed(i));
    const result = await new GatewayRPC(createExecutionContext(), env).retryFailedDeliveries(
      { from: FROM, to: TO },
      TEST_WABA_ID,
      TEST_ACCOUNT_ID,
    );
    expect(result).toEqual({ requeued: 2, skippedRedacted: 1 });

    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      for (const id of [1, 2]) {
        expect(i.getDelivery(id)).toMatchObject({ status: "pending", attempts: 0, last_error: null, finished_at: null });
      }
      expect(i.getDelivery(3)).toMatchObject({ status: "failed", attempts: 6 });
      expect(i.getDelivery(4)).toMatchObject({ status: "failed", attempts: 6 });
      expect(i.getDelivery(5)).toMatchObject({ status: "delivered" });
      expect(i.getDelivery(6)).toMatchObject({ status: "pending", attempts: 6 });
    });
  });

  it("refuses a window that is not a window", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      expect(() => i.retryFailedDeliveries(TO, FROM)).toThrow(/invalid retry window/);
      expect(() => i.retryFailedDeliveries(Number.NaN, TO)).toThrow(/invalid retry window/);
    });
  });
});
