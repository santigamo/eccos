import { env, exports } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signPayload } from "@eccos/core/signature";
import type { AccountFunnel, BillingStatus } from "@eccos/gateway-contract";
import type { FunnelMailInput } from "@eccos/gateway-contract/funnel-mail";
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

describe("funnel emails", () => {
  const ORG = "org_funnel";
  let mail: ReturnType<typeof vi.fn>;
  let mailFails = false;

  beforeEach(async () => {
    mailFails = false;
    mail = vi.fn(async (_input: FunnelMailInput) => {
      if (mailFails) throw new Error("console down");
      return { status: "sent", recipients: 1 };
    });
    (env as { FUNNEL_MAIL?: unknown }).FUNNEL_MAIL = { sendFunnelEmail: mail };
    await cp((i) =>
      i.sql.exec(
        "INSERT INTO organization_accounts (organization_id, account_id, status, created_at) VALUES (?, ?, 'active', ?)",
        ORG,
        TEST_ACCOUNT_ID,
        T0,
      ),
    );
  });

  afterEach(() => {
    delete (env as { FUNNEL_MAIL?: unknown }).FUNNEL_MAIL;
  });

  const tick = async (now: number) => {
    at(now);
    await worker.scheduled!(createScheduledController({ scheduledTime: new Date(now) }), env, createExecutionContext());
  };
  const kinds = () => mail.mock.calls.map(([input]) => (input as FunnelMailInput).kind);
  const ids = { organizationId: ORG, accountId: TEST_ACCOUNT_ID };

  it("sends activated at activation, window_ending at 48h and paused at 72h, each once", async () => {
    billingOn();
    await cp((i) => i.recordActivation(TEST_WABA_ID, T0 + HOUR, "webhook_2xx"));
    expect(mail.mock.calls).toEqual([
      [{ kind: "activated", ...ids, activatedAt: T0 + HOUR, via: "webhook", windowEndsAt: T0 + 73 * HOUR }],
    ]);

    await tick(T0 + 49 * HOUR - 1);
    expect(kinds()).toEqual(["activated"]);
    await tick(T0 + 49 * HOUR);
    await tick(T0 + 50 * HOUR);
    expect(mail.mock.calls[1]).toEqual([{ kind: "window_ending", ...ids, windowEndsAt: T0 + 73 * HOUR }]);

    await tick(T0 + 73 * HOUR);
    await tick(T0 + 74 * HOUR);
    expect(mail.mock.calls[2]).toEqual([{ kind: "paused", ...ids, pausedAt: T0 + 73 * HOUR, reason: "window_ended" }]);
    expect(kinds()).toEqual(["activated", "window_ending", "paused"]);
  });

  it("says via outbound for a delivered own send", async () => {
    billingOn();
    await cp((i) => i.recordActivation(TEST_WABA_ID, T0, "outbound_delivered"));
    expect(mail.mock.calls[0]?.[0]).toMatchObject({ kind: "activated", via: "outbound" });
  });

  it("sends the day-12 warning and the day-14 pause to a never-activated account", async () => {
    billingOn();
    await tick(T0 + 12 * DAY);
    await tick(T0 + 13 * DAY);
    expect(mail.mock.calls).toEqual([
      [{ kind: "never_activated_warning", ...ids, connectedAt: T0, pausesAt: T0 + 14 * DAY }],
    ]);
    await tick(T0 + 14 * DAY);
    expect(mail.mock.calls[1]).toEqual([{ kind: "paused", ...ids, pausedAt: T0 + 14 * DAY, reason: "never_activated" }]);
  });

  it("retries a failed email on the next tick, without holding the timers, and stops once acknowledged", async () => {
    billingOn();
    mailFails = true;
    await cp((i) => i.recordActivation(TEST_WABA_ID, T0, "webhook_2xx"));
    expect((await funnel()).funnel.activatedAt).toBe(T0);

    await tick(T0 + 72 * HOUR);
    expect((await funnel()).billingStatus).toBe("paused");
    expect(kinds()).toEqual(["activated", "activated", "paused"]);

    mailFails = false;
    await tick(T0 + 72 * HOUR + 5 * 60_000);
    await tick(T0 + 72 * HOUR + 10 * 60_000);
    expect(kinds()).toEqual(["activated", "activated", "paused", "activated", "paused"]);
  });

  it("sends nothing to a legacy account", async () => {
    billingOn();
    for (const legacy of [0, null]) {
      await cp((i) => i.sql.exec("UPDATE accounts SET connected_at = ?, activated_at = NULL", legacy));
      await cp((i) => i.recordActivation(TEST_WABA_ID, T0, "webhook_2xx"));
      await tick(T0 + 60 * DAY);
    }
    expect(mail).not.toHaveBeenCalled();
  });

  it("sends nothing with billing off", async () => {
    await cp((i) => i.recordActivation(TEST_WABA_ID, T0, "webhook_2xx"));
    await tick(T0 + 60 * DAY);
    expect(mail).not.toHaveBeenCalled();
  });

  it("sends nothing and fails nothing without the binding", async () => {
    billingOn();
    delete (env as { FUNNEL_MAIL?: unknown }).FUNNEL_MAIL;
    await cp((i) => i.recordActivation(TEST_WABA_ID, T0, "webhook_2xx"));
    await tick(T0 + 72 * HOUR);
    expect((await funnel()).billingStatus).toBe("paused");
    expect(await cp((i) => i.sendFunnelMail())).toEqual({ sent: 0, failed: 0 });
  });
});

describe("early access end", () => {
  const ENDS = T0 + 14 * DAY;

  beforeEach(async () => {
    billingOn();
    await cp((i) => i.sql.exec("UPDATE accounts SET connected_at = 0"));
    await cp((i) => i.setAccountBilling(TEST_ACCOUNT_ID, { billingStatus: "open" }));
    await cp((i) => i.setEarlyAccessEnd(TEST_ACCOUNT_ID, ENDS));
  });

  const schedule = () => cp((i) => i.sql.exec("SELECT early_access_ends_at AS at FROM accounts").one().at);

  it("shows the date and pauses the account on it, once", async () => {
    expect(await funnel()).toMatchObject({ billingStatus: "open", funnel: { pausesAt: ENDS, pauseReason: "early_access_ended" } });
    await cp((i) => i.runFunnelTimers(ENDS - 1));
    expect((await funnel()).billingStatus).toBe("open");
    expect(await cp((i) => i.runFunnelTimers(ENDS))).toEqual({ paused: 1, warned: 0 });
    expect(await funnel()).toMatchObject({ billingStatus: "paused", funnel: { pausesAt: null, pauseReason: "early_access_ended" } });
    expect(await schedule()).toBeNull();
    expect((await sendText()).status).toBe(402);
  });

  it("lets a subscription before the date win", async () => {
    await cp((i) => i.setAccountBilling(TEST_ACCOUNT_ID, { billingStatus: "active", subscriptionId: "sub_1" }));
    expect((await funnel()).funnel.pausesAt).toBeNull();
    await cp((i) => i.runFunnelTimers(ENDS));
    expect((await funnel()).billingStatus).toBe("active");
    expect(await schedule()).toBeNull();
  });

  it("does nothing once cleared", async () => {
    expect(await cp((i) => i.setEarlyAccessEnd(TEST_ACCOUNT_ID, null))).toBeNull();
    expect((await funnel()).funnel.pausesAt).toBeNull();
    await cp((i) => i.runFunnelTimers(ENDS + DAY));
    expect((await funnel()).billingStatus).toBe("open");
  });

  it("sends no funnel email", async () => {
    const mail = vi.fn(async () => ({ status: "sent", recipients: 1 }));
    (env as { FUNNEL_MAIL?: unknown }).FUNNEL_MAIL = { sendFunnelEmail: mail };
    await cp((i) =>
      i.sql.exec("INSERT INTO organization_accounts (organization_id, account_id, status, created_at) VALUES ('org_e', ?, 'active', 0)", TEST_ACCOUNT_ID),
    );
    at(ENDS);
    await worker.scheduled!(createScheduledController({ scheduledTime: new Date(ENDS) }), env, createExecutionContext());
    expect((await funnel()).billingStatus).toBe("paused");
    expect(mail).not.toHaveBeenCalled();
    delete (env as { FUNNEL_MAIL?: unknown }).FUNNEL_MAIL;
  });

  it("refuses a bad date and is reachable over the operator RPC", async () => {
    await expect(cp((i) => i.setEarlyAccessEnd(TEST_ACCOUNT_ID, -1))).rejects.toThrow(/invalid endsAt/);
    const rpc = (env as unknown as { GATEWAY_RPC: { setEarlyAccessEnd(a: string, e: number | null): Promise<number | null> } }).GATEWAY_RPC;
    expect(await rpc.setEarlyAccessEnd(TEST_ACCOUNT_ID, ENDS + DAY)).toBe(ENDS + DAY);
    expect(await schedule()).toBe(ENDS + DAY);
  });
});
