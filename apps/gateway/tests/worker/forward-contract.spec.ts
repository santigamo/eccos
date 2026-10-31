import { env, exports } from "cloudflare:workers";
import { runInDurableObject, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signPayload } from "@eccos/core/signature";
import { EccosGateway } from "../../src/gateway";
import { bootstrapAccount, gatewayStub, holdAlarms, runAlarm, SUBSCRIBER_SECRET, SUBSCRIBER_URL, TEST_WABA_ID } from "./helpers";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

let forwardedBodies: string[] = [];

beforeEach(async () => {
  forwardedBodies = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) !== SUBSCRIBER_URL) return new Response("not found", { status: 404 });
    const body = String(init?.body);
    expect(new Headers(init?.headers).get("x-eccos-signature")).toBe(await signPayload(body, SUBSCRIBER_SECRET));
    forwardedBodies.push(body);
    return new Response("ok", { status: 200 });
  });
  await bootstrapAccount();
  await holdAlarms();
  await gatewayStub().saveConfig({ SUBSCRIBER_WEBHOOK_URL: SUBSCRIBER_URL, SUBSCRIBER_SECRET: SUBSCRIBER_SECRET });
});

async function postMetaWebhook(value: Record<string, unknown>) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: TEST_WABA_ID, changes: [{ field: "messages", value: { metadata: { phone_number_id: "PNID1" }, ...value } }] }],
  });
  const response = await exports.default.fetch("http://example.com/webhooks/meta", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
    body,
  });
  expect(response.status).toBe(200);
}

/** Drains the delivery queue and returns every event the subscriber received, signature-checked. */
async function forwardedEvents(): Promise<Record<string, unknown>[]> {
  await runAlarm();
  return forwardedBodies.flatMap((body) => JSON.parse(body).events);
}

describe("forwarded event contract", () => {
  it("forwards a sent status, and a late sent never moves a read message back", async () => {
    await gatewayStub().logOutbound("wamid.OUT", "34600000000", '{"to":"34600000000","type":"text"}', "sent", null, "PNID1");

    await postMetaWebhook({ statuses: [{ id: "wamid.OUT", status: "read", timestamp: "1700000002", recipient_id: "34600000000" }] });
    await postMetaWebhook({ statuses: [{ id: "wamid.OUT", status: "sent", timestamp: "1700000001", recipient_id: "34600000000" }] });

    const events = await forwardedEvents();
    expect(events.map((ev) => ev.type).sort()).toEqual(["read", "sent"]);
    expect(events.find((ev) => ev.type === "sent")).toMatchObject({ transportMessageId: "wamid.OUT", phoneNumberId: "PNID1" });

    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      const row = instance.sql.exec("SELECT status FROM messages WHERE id = 'wamid.OUT'").toArray()[0];
      expect(row?.status).toBe("read");
    });
  });

  it("forwards the payload of template quick replies and interactive replies", async () => {
    await postMetaWebhook({
      contacts: [{ wa_id: "34600000000", profile: { name: "Ana" } }],
      messages: [
        { from: "34600000000", id: "wamid.BTN", timestamp: "1700000000", type: "button", button: { text: "Stop promotions", payload: "STOP_PROMO" } },
        { from: "34600000000", id: "wamid.BR", timestamp: "1700000000", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "poll_yes", title: "Yes" } } },
        { from: "34600000000", id: "wamid.LR", timestamp: "1700000000", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "lang_nl", title: "Nederlands" } } },
        { from: "34600000000", id: "wamid.TXT", timestamp: "1700000000", type: "text", text: { body: "STOP" } },
      ],
    });

    const events = await forwardedEvents();
    const byId = Object.fromEntries(events.map((ev) => [ev.messageId, ev]));
    expect(byId["wamid.BTN"]).toMatchObject({ type: "reply", text: "Stop promotions", payload: "STOP_PROMO", profileName: "Ana" });
    expect(byId["wamid.BR"]).toMatchObject({ type: "reply", text: "Yes", payload: "poll_yes" });
    expect(byId["wamid.LR"]).toMatchObject({ type: "reply", text: "Nederlands", payload: "lang_nl" });
    expect(byId["wamid.TXT"]).toEqual({ type: "reply", from: "34600000000", messageId: "wamid.TXT", text: "STOP", at: 1_700_000_000_000, phoneNumberId: "PNID1", profileName: "Ana" });
  });
});

describe("business-scoped user ids (BSUID)", () => {
  it("forwards and stores a message from a username user Meta sends without a phone number", async () => {
    await postMetaWebhook({
      messaging_product: "whatsapp",
      contacts: [{ profile: { name: "Ana", username: "@ana" }, user_id: "US.13491208655302741918" }],
      messages: [{ from_user_id: "US.13491208655302741918", id: "wamid.BSUID", timestamp: "1700000000", type: "text", text: { body: "hola" } }],
    });

    const [event] = await forwardedEvents();
    expect(event).toEqual({
      type: "reply",
      from: "US.13491208655302741918",
      fromUserId: "US.13491208655302741918",
      messageId: "wamid.BSUID",
      text: "hola",
      at: 1_700_000_000_000,
      phoneNumberId: "PNID1",
      profileName: "Ana",
    });
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      const row = instance.sql.exec("SELECT wa_id FROM messages WHERE id = 'wamid.BSUID'").toArray()[0];
      expect(row?.wa_id).toBe("US.13491208655302741918");
    });
  });

  it("logs the WABA, keys and missing fields of a message that yields no event, never its values", async () => {
    const log = vi.spyOn(console, "log");
    await postMetaWebhook({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.NOFROM", timestamp: "1700000000", type: "text", text: { body: "secret text" } }],
    });

    const line = log.mock.calls.map(([arg]) => JSON.parse(String(arg))).find((entry) => entry.event === "webhook_ignored");
    expect(line).toMatchObject({ reason: "no_events", wabaIds: TEST_WABA_ID });
    expect(line.shape).toContain("dropped:text:missing=from;keys=id+text+timestamp+type");
    expect(JSON.stringify(line)).not.toContain("secret text");
  });
});

describe("webhook ingest failure", () => {
  it("answers 503 so Meta retries, and the retry is stored once", async () => {
    const value = { metadata: { phone_number_id: "PNID1" }, messages: [{ from: "34600000000", id: "wamid.RETRY", timestamp: "1700000000", type: "text", text: { body: "hola" } }] };
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: TEST_WABA_ID, changes: [{ field: "messages", value }] }] });
    const post = async () =>
      exports.default.fetch("http://example.com/webhooks/meta", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
        body,
      });

    const ingest = vi.spyOn(EccosGateway.prototype, "ingest").mockImplementationOnce(() => {
      throw new Error("Durable Object storage operation exceeded timeout which caused object to be reset.");
    });
    expect((await post()).status).toBe(503);
    ingest.mockRestore();

    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      expect(instance.sql.exec("SELECT COUNT(*) AS c FROM inbound_events").toArray()[0]!.c).toBe(1);
    });
  });
});
