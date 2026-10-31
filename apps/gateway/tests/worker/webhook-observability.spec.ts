/**
 * eccos-rud2.1: every webhook and forward leaves one attributable log line, with
 * business-side ids and counts only, and a registered WABA losing messages alerts.
 */
import { env, exports } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signPayload } from "@eccos/core/signature";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount, gatewayStub, holdAlarms, runAlarm, SUBSCRIBER_URL, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

let log: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await bootstrapAccount();
  await holdAlarms();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function lines(event: string): Record<string, unknown>[] {
  return log.mock.calls
    .map(([arg]) => (typeof arg === "string" && arg.startsWith("{") ? JSON.parse(arg) : null))
    .filter((line) => line?.event === event);
}

async function post(entries: Array<{ id: string; changes: unknown[] }>) {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: entries });
  const response = await exports.default.fetch("http://example.com/webhooks/meta", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
    body,
  });
  expect(response.status).toBe(200);
}

function messages(phoneNumberId: string, value: Record<string, unknown>) {
  return [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, ...value } }];
}

const TEXT = { from: "34600000000", id: "wamid.T", timestamp: "1700000000", type: "text", text: { body: "secret text" } };

describe("webhook log lines", () => {
  it("attributes an ingested webhook to its WABA and phone, with counts by type", async () => {
    await post([
      {
        id: TEST_WABA_ID,
        changes: messages("PNID1", {
          messages: [TEXT, { from: "34600000000", id: "wamid.L", timestamp: "1700000000", type: "location", location: { latitude: 1, longitude: 2 } }],
          statuses: [{ id: "wamid.O", status: "read", timestamp: "1700000000", recipient_id: "34600000000" }],
        }),
      },
    ]);

    expect(lines("webhook_ingested")).toEqual([
      expect.objectContaining({
        wabaId: TEST_WABA_ID,
        phoneNumberId: "PNID1",
        eventCount: 3,
        received: 3,
        n_reply: 1,
        n_message_location: 1,
        n_status_read: 1,
      }),
    ]);
    expect(lines("ingested")[0]).toMatchObject({ area: "ingest", wabaId: TEST_WABA_ID, eventCount: 3, inserted: 3 });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret text|34600000000/);
  });

  it("says why each batch is ignored", async () => {
    await post([
      { id: "999", changes: messages("PNX", { messages: [TEXT] }) },
      { id: TEST_WABA_ID, changes: messages("PNID_OTHER", { messages: [TEXT] }) },
    ]);
    const reasons = lines("webhook_ignored").map(({ reason, wabaId, phoneNumberId, eventCount }) => ({ reason, wabaId, phoneNumberId, eventCount }));
    expect(reasons).toEqual([
      { reason: "unknown_waba", wabaId: "999", phoneNumberId: "PNX", eventCount: 1 },
      { reason: "phone_not_registered", wabaId: TEST_WABA_ID, phoneNumberId: "PNID_OTHER", eventCount: 1 },
    ]);
  });

  it("logs a webhook that parses to no event as no_events, with its WABA ids", async () => {
    await post([{ id: TEST_WABA_ID, changes: [{ field: "account_update", value: { event: "VERIFIED_ACCOUNT" } }] }]);
    expect(lines("webhook_ignored")).toEqual([
      expect.objectContaining({ reason: "no_events", wabaIds: TEST_WABA_ID, shape: "account_update:event" }),
    ]);
  });

  it("logs dropped messages by field and type, and alerts once per window for an active WABA", async () => {
    const dropped = { id: "wamid.D", timestamp: "1700000000", type: "text", text: { body: "secret text" } };
    await post([{ id: TEST_WABA_ID, changes: messages("PNID1", { messages: [TEXT, dropped, { ...dropped, id: "wamid.D2", type: "reaction" }] }) }]);

    expect(lines("webhook_dropped")).toEqual([
      expect.objectContaining({ wabaId: TEST_WABA_ID, dropped: 2, missing: "from", types: "reaction+text", keys: "id+text+timestamp+type" }),
    ]);
    expect(lines("webhook_ingested")[0]).toMatchObject({ eventCount: 1 });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret text");
    // The alert ran off the response path; its window is now open, so the next drop is held.
    await vi.waitFor(() =>
      runInDurableObject(gatewayStub(), (i: EccosGateway) => {
        expect(i.sql.exec("SELECT value FROM ops_state WHERE key = 'drop_alert_at'").toArray()).toHaveLength(1);
      }),
    );
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      expect(i.recordOpsAlert("drop", Date.now(), 3)).toEqual({ send: false, count: 3 });
    });
  });

  it("does not alert for a WABA it does not serve", async () => {
    await post([{ id: "999", changes: messages("PNX", { messages: [{ id: "wamid.D", timestamp: "1700000000", type: "text" }] }) }]);
    expect(lines("webhook_dropped")[0]).toMatchObject({ wabaId: "999", missing: "from" });
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      expect(i.sql.exec("SELECT value FROM ops_state WHERE key = 'drop_alert_at'").toArray()).toHaveLength(0);
    });
  });
});

describe("forward log lines", () => {
  it("logs a successful forward with its WABA, status and timings", async () => {
    await gatewayStub().saveConfig({ SUBSCRIBER_WEBHOOK_URL: SUBSCRIBER_URL });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    await gatewayStub().ingest([{ type: "reply", from: "34600000000", messageId: "wamid.F", text: "hello", at: 1, phoneNumberId: "PNID1" }]);
    await runAlarm();

    const [line] = lines("delivered");
    expect(line).toMatchObject({ area: "forward", wabaId: TEST_WABA_ID, phoneNumberId: "PNID1", deliveryId: 1, attempt: 1, httpStatus: 200 });
    expect(line!.durationMs).toBeTypeOf("number");
    expect(line!.lagMs).toBeTypeOf("number");
  });
});

describe("RPC log lines", () => {
  it("names the account and WABA a console call acts on", async () => {
    await new GatewayRPC(createExecutionContext(), env).getConfig(TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(lines("rpc_scope")).toEqual([expect.objectContaining({ accountId: TEST_ACCOUNT_ID, wabaId: TEST_WABA_ID })]);
  });
});
