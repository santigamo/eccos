import { env, exports } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signPayload } from "@eccos/core/signature";
import type { AccountFunnel, BillingStatus } from "@eccos/gateway-contract";
import type { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import type { EccosGateway } from "../../src/gateway";
import worker from "../../src/worker";
import {
  bootstrapAccount,
  gatewayStub,
  holdAlarms,
  runAlarm,
  SUBSCRIBER_SECRET,
  SUBSCRIBER_URL,
  TEST_ACCOUNT_ID,
  TEST_WABA_ID,
} from "./helpers";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);

let subscriberStatus = 200;
let apiKey = "";

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

async function funnel(): Promise<{ billingStatus: BillingStatus; funnel: AccountFunnel }> {
  const account = (await cp((i) => i.listAccountResources(TEST_ACCOUNT_ID))).account!;
  return { billingStatus: account.billingStatus, funnel: account.funnel };
}

function at(ms: number): void {
  vi.setSystemTime(ms);
}

function billingOn(): void {
  (env as { CONNECT_POLICY_DEFAULT?: string }).CONNECT_POLICY_DEFAULT = "closed";
}

async function postMetaWebhook(field: string, value: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: TEST_WABA_ID, changes: [{ field, value: { metadata: { phone_number_id: "PNID1" }, ...value } }] }],
  });
  const response = await exports.default.fetch("http://example.com/webhooks/meta", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
    body,
  });
  expect(response.status).toBe(200);
}

const inboundMessage = () =>
  postMetaWebhook("messages", {
    contacts: [{ wa_id: "34600000001", profile: { name: "Ana" } }],
    messages: [{ from: "34600000001", id: `wamid.IN${Date.now()}`, timestamp: "1700000000", type: "text", text: { body: "hola" } }],
  });

const status = (id: string, value: string) =>
  postMetaWebhook("messages", { statuses: [{ id, status: value, timestamp: "1700000001", recipient_id: "34600000001" }] });

const setTarget = () => gatewayStub().saveConfig({ SUBSCRIBER_WEBHOOK_URL: SUBSCRIBER_URL, SUBSCRIBER_SECRET });

const sendText = () =>
  exports.default.fetch(`http://example.com/v1/wabas/${TEST_WABA_ID}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "34600000001", type: "text", text: { body: "hi" } }),
  });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(T0);
  subscriberStatus = 200;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === SUBSCRIBER_URL) return new Response("ok", { status: subscriberStatus });
    if (url.includes("/messages")) return new Response(JSON.stringify({ messages: [{ id: "wamid.SENT" }] }), { status: 200 });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  apiKey = (await bootstrapAccount()).apiKey;
  await holdAlarms();
});

afterEach(async () => {
  delete (env as { CONNECT_POLICY_DEFAULT?: string }).CONNECT_POLICY_DEFAULT;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await reset();
});

describe("connectedAt", () => {
  it("is the first number's registration, and a later one does not move it", async () => {
    expect((await funnel()).funnel.connectedAt).toBe(T0);
    at(T0 + DAY);
    await bootstrapAccount();
    expect((await funnel()).funnel.connectedAt).toBe(T0);
  });

  it("stays off for an account that connected before the funnel, even after it reconnects", async () => {
    await cp(async (i) => {
      i.sql.exec("UPDATE accounts SET connected_at = 0");
      i.sql.exec("DELETE FROM phones");
      await i.registerWaba({ accountId: TEST_ACCOUNT_ID, wabaId: TEST_WABA_ID, metaAccessToken: "t", provisioningStatus: "active", phones: [{ phoneNumberId: "PNID1" }] });
    });
    expect((await funnel()).funnel).toMatchObject({ connectedAt: null, pausesAt: null });
  });
});

describe("activation", () => {
  it("is the first forward the target answers with a 2xx", async () => {
    await setTarget();
    subscriberStatus = 500;
    await inboundMessage();
    await runAlarm();
    expect((await funnel()).funnel.activatedAt).toBeNull();

    subscriberStatus = 200;
    at(T0 + HOUR);
    await inboundMessage();
    await runAlarm();
    expect((await funnel()).funnel.activatedAt).toBe(T0 + HOUR);

    at(T0 + 2 * HOUR);
    await inboundMessage();
    await runAlarm();
    expect((await funnel()).funnel.activatedAt).toBe(T0 + HOUR);
  });

  it("is an own send Meta delivered, even when the status overtook the send", async () => {
    await status("wamid.SENT", "delivered");
    at(T0 + HOUR);
    expect((await sendText()).status).toBe(200);
    await runAlarm();
    expect((await funnel()).funnel.activatedAt).toBe(T0 + HOUR);
  });

  it("is not a send only accepted, nor a delivered status for a message Eccos did not send", async () => {
    expect((await sendText()).status).toBe(200);
    await status("wamid.SENT", "sent");
    await status("wamid.FROM_THE_APP", "delivered");
    await runAlarm();
    expect((await funnel()).funnel.activatedAt).toBeNull();

    at(T0 + HOUR);
    await status("wamid.SENT", "delivered");
    await runAlarm();
    expect((await funnel()).funnel.activatedAt).toBe(T0 + HOUR);
  });

  it("is never imported coexistence history", async () => {
    await setTarget();
    const history = {
      object: "whatsapp_business_account",
      entry: [{ id: TEST_WABA_ID, changes: [{ field: "history", value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "34600000000", phone_number_id: "PNID1" },
        history: [{ metadata: { phase: 0, chunk_order: 0, progress: 100 }, threads: [{ id: "34600000001", messages: [
          { from: "34600000000", id: "wamid.H1", timestamp: "1700000000", type: "text", text: { body: "old" }, history_context: { status: "DELIVERED" } },
        ] }] }],
      } }] }],
    };
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => i.captureSyncPayload(["history"], JSON.stringify(history)));
    await runAlarm();
    await runAlarm();
    expect((await funnel()).funnel.activatedAt).toBeNull();
  });

  it("is not recorded for a legacy account", async () => {
    await cp((i) => i.sql.exec("UPDATE accounts SET connected_at = 0"));
    await setTarget();
    await inboundMessage();
    await runAlarm();
    expect((await funnel()).funnel.activatedAt).toBeNull();
  });
});

describe("timers", () => {
  beforeEach(billingOn);

  const timers = (now: number) => cp((i) => i.runFunnelTimers(now));

  it("pause an activated setup account 72h after it activated", async () => {
    await cp((i) => i.recordActivation(TEST_WABA_ID, T0 + HOUR, "webhook_2xx"));
    const deadline = T0 + HOUR + 72 * HOUR;
    expect((await funnel()).funnel).toMatchObject({ activatedAt: T0 + HOUR, pausesAt: deadline, pauseReason: "window_ended" });

    await timers(deadline - 1);
    expect((await funnel()).billingStatus).toBe("setup");
    await timers(deadline);
    expect(await funnel()).toMatchObject({ billingStatus: "paused", funnel: { pausesAt: null, pauseReason: "window_ended" } });
    expect((await sendText()).status).toBe(402);
  });

  it("flag the day-12 warning and pause a never-activated account on day 14", async () => {
    expect((await funnel()).funnel).toMatchObject({ pausesAt: T0 + 14 * DAY, pauseReason: "never_activated", warningDueAt: null });
    await timers(T0 + 12 * DAY - 1);
    expect((await funnel()).funnel.warningDueAt).toBeNull();
    await timers(T0 + 12 * DAY);
    expect(await funnel()).toMatchObject({ billingStatus: "setup", funnel: { warningDueAt: T0 + 12 * DAY } });
    await timers(T0 + 13 * DAY);
    expect((await funnel()).funnel.warningDueAt).toBe(T0 + 12 * DAY);
    await timers(T0 + 14 * DAY);
    expect(await funnel()).toMatchObject({ billingStatus: "paused", funnel: { pauseReason: "never_activated" } });
  });

  it("run from the worker's cron", async () => {
    at(T0 + 14 * DAY);
    await worker.scheduled!(createScheduledController({ scheduledTime: new Date(T0 + 14 * DAY) }), env, createExecutionContext());
    expect((await funnel()).billingStatus).toBe("paused");
  });

  it.each(["active", "past_due", "cancelled", "open", "closed"] as const)("never touch %s", async (billingStatus) => {
    await cp((i) => i.setAccountBilling(TEST_ACCOUNT_ID, { billingStatus }));
    await timers(T0 + 30 * DAY);
    expect(await funnel()).toMatchObject({ billingStatus, funnel: { pausesAt: null, warningDueAt: null } });
  });

  it("let a payment before the deadline win", async () => {
    await cp((i) => i.recordActivation(TEST_WABA_ID, T0, "outbound_delivered"));
    await cp((i) => i.setAccountBilling(TEST_ACCOUNT_ID, { billingStatus: "active", subscriptionId: "sub_1" }));
    await timers(T0 + 100 * HOUR);
    expect((await funnel()).billingStatus).toBe("active");
  });

  it("log activated, paused and paid as audit lines", async () => {
    const info = vi.spyOn(console, "info");
    await cp((i) => i.recordActivation(TEST_WABA_ID, T0, "webhook_2xx"));
    await timers(T0 + 72 * HOUR);
    await cp((i) => i.setAccountBilling(TEST_ACCOUNT_ID, { billingStatus: "active", subscriptionId: "sub_1" }));
    const lines = info.mock.calls.map(([line]) => JSON.parse(String(line))).filter((line) => line.area === "audit");
    expect(lines.map((line) => line.action)).toEqual(["funnel_activated", "funnel_paused", "funnel_paid"]);
    expect(lines[0]).toMatchObject({ accountId: TEST_ACCOUNT_ID, resource: { trigger: "webhook_2xx" } });
  });

  it("let a payment after the pause reopen sends", async () => {
    await timers(T0 + 14 * DAY);
    await cp((i) => i.setAccountBilling(TEST_ACCOUNT_ID, { billingStatus: "active", subscriptionId: "sub_1" }));
    expect((await sendText()).status).toBe(200);
  });

  it("never start for a legacy account", async () => {
    for (const legacy of [0, null]) {
      await cp((i) => i.sql.exec("UPDATE accounts SET connected_at = ?", legacy));
      await timers(T0 + 60 * DAY);
      expect(await funnel()).toMatchObject({ billingStatus: "setup", funnel: { connectedAt: null, pausesAt: null } });
    }
  });
});

describe("billing off", () => {
  it("no timer ever pauses", async () => {
    await cp((i) => i.recordActivation(TEST_WABA_ID, T0, "webhook_2xx"));
    expect(await cp((i) => i.runFunnelTimers(T0 + 60 * DAY))).toEqual({ paused: 0, warned: 0 });
    expect(await funnel()).toMatchObject({ billingStatus: "open", funnel: { activatedAt: T0, pausesAt: null } });
  });
});
