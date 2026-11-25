/**
 * eccos-dbb3.3: while the account's billing status blocks sends, forwarding is held and inbound is
 * still stored. Resuming forwards new events only; the held backlog goes out on a manual replay.
 */
import { env, exports } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signPayload } from "@eccos/core/signature";
import type { BillingStatus } from "@eccos/gateway-contract/billing-status";
import type { EccosGateway } from "../../src/gateway";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount, gatewayStub, holdAlarms, runAlarm, SUBSCRIBER_SECRET, SUBSCRIBER_URL, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

let forwarded: string[];

beforeEach(async () => {
  await bootstrapAccount();
  await holdAlarms();
  await gatewayStub().saveConfig({ SUBSCRIBER_WEBHOOK_URL: SUBSCRIBER_URL, SUBSCRIBER_SECRET: SUBSCRIBER_SECRET });
  forwarded = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) !== SUBSCRIBER_URL) return new Response("not found", { status: 404 });
    const body = JSON.parse(String(init?.body)) as { events: Array<{ messageId: string }> };
    forwarded.push(...body.events.map((event) => event.messageId));
    return new Response("ok", { status: 200 });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const rpc = () => new GatewayRPC(createExecutionContext(), env);

function setStatus(billingStatus: BillingStatus) {
  return getControlPlaneStub(env).setAccountBilling(TEST_ACCOUNT_ID, { billingStatus });
}

async function post(messageId: string) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: TEST_WABA_ID,
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: "PNID1" },
          messages: [{ from: "34600000000", id: messageId, timestamp: "1700000000", type: "text", text: { body: "hola" } }],
        },
      }],
    }],
  });
  return exports.default.fetch("http://example.com/webhooks/meta", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
    body,
  });
}

/** Posts the webhook and runs the alarm its ingest armed. */
async function receive(messageId: string) {
  const res = await post(messageId);
  expect(res.status).toBe(200);
  await runAlarm();
}

function deliveries(): Promise<Array<{ status: string; attempts: number }>> {
  return runInDurableObject(gatewayStub(), (instance: EccosGateway) =>
    instance.sql.exec("SELECT status, attempts FROM deliveries ORDER BY id").toArray() as Array<{ status: string; attempts: number }>,
  );
}

describe("billing hold", () => {
  it("stores inbound while paused but forwards nothing and spends no attempt", async () => {
    await setStatus("paused");
    await receive("wamid.P1");
    await receive("wamid.P2");

    expect(forwarded).toEqual([]);
    expect(await deliveries()).toEqual([
      { status: "held", attempts: 0 },
      { status: "held", attempts: 0 },
    ]);
    const counts = await runInDurableObject(gatewayStub(), (instance: EccosGateway) => instance.getCounts());
    expect(counts.inbound).toBe(2);
    expect(await rpc().getHeldEvents(TEST_ACCOUNT_ID)).toEqual({ events: 2, messages: 2 });
  });

  it("holds a closed account too, and refuses a replay while forwarding is still held", async () => {
    await setStatus("closed");
    await receive("wamid.C1");
    expect(forwarded).toEqual([]);
    expect(await rpc().replayHeldEvents(TEST_ACCOUNT_ID)).toEqual({ ok: false, code: "subscription_required" });
    expect(await deliveries()).toEqual([{ status: "held", attempts: 0 }]);
  });

  it("on resume forwards new events only, leaving the backlog held", async () => {
    await setStatus("paused");
    await receive("wamid.OLD");
    await setStatus("active");
    await receive("wamid.NEW");

    expect(forwarded).toEqual(["wamid.NEW"]);
    expect(await rpc().getHeldEvents(TEST_ACCOUNT_ID)).toEqual({ events: 1, messages: 1 });
  });

  it("replays the backlog once, in order", async () => {
    await setStatus("paused");
    for (const id of ["wamid.R1", "wamid.R2", "wamid.R3"]) await receive(id);
    await setStatus("active");

    expect(await rpc().replayHeldEvents(TEST_ACCOUNT_ID)).toEqual({ ok: true, replayed: 3 });
    await runAlarm();
    expect(forwarded).toEqual(["wamid.R1", "wamid.R2", "wamid.R3"]);

    expect(await rpc().replayHeldEvents(TEST_ACCOUNT_ID)).toEqual({ ok: true, replayed: 0 });
    await runAlarm();
    expect(forwarded).toHaveLength(3);
    expect(await rpc().getHeldEvents(TEST_ACCOUNT_ID)).toEqual({ events: 0, messages: 0 });
  });

  it("holds a row that was already retrying, without spending its retries", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response("down", { status: 503 }));
    await receive("wamid.RETRY");
    expect(await deliveries()).toEqual([{ status: "pending", attempts: 1 }]);

    await setStatus("paused");
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      instance.sql.exec("UPDATE deliveries SET next_attempt_at = 0");
    });
    await runAlarm();
    expect(await deliveries()).toEqual([{ status: "held", attempts: 1 }]);
    expect(forwarded).toEqual([]);
  });

  it("held rows age out with content retention", async () => {
    await setStatus("paused");
    await receive("wamid.AGED");
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      instance.pruneExpired(Date.now() + 31 * 24 * 60 * 60 * 1000, 30, 90);
    });
    expect(await deliveries()).toEqual([]);
  });

  for (const status of [undefined, "open", "setup", "past_due", "cancelled"] as const) {
    it(`forwards as usual for ${status ?? "a legacy account with no stored status"}`, async () => {
      if (status) await setStatus(status);
      await receive(`wamid.${status ?? "legacy"}`);
      expect(forwarded).toEqual([`wamid.${status ?? "legacy"}`]);
      expect(await deliveries()).toEqual([{ status: "delivered", attempts: 1 }]);
    });
  }
});
