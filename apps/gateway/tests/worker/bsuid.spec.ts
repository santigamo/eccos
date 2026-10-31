import { env, exports } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount, gatewayStub, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

/** Sending to and erasing customers Meta names by business-scoped user id (BSUID). */

const BSUID = "US.13491208655302741918";
const OTHER = "34600000002";
let apiKey = "";

beforeEach(async () => {
  apiKey = (await bootstrapAccount()).apiKey;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function rpc() {
  return new GatewayRPC(createExecutionContext(), env);
}

/** Meta's answer to a BSUID send: the contact comes back as `user_id`, not `wa_id`. */
function mockBsuidSend() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ contacts: [{ input: BSUID, user_id: BSUID }], messages: [{ id: "wamid.B" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

function postMessage(body: unknown) {
  return exports.default.fetch(`http://example.com/v1/wabas/${TEST_WABA_ID}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("sending to a BSUID", () => {
  it("the RPC text send addresses Meta's recipient and files the send under the BSUID", async () => {
    const fetchSpy = mockBsuidSend();
    const result = await rpc().sendText(
      { wabaId: TEST_WABA_ID, phoneNumberId: "PNID1", to: BSUID, text: "hi" },
      TEST_ACCOUNT_ID,
    );
    expect(result).toEqual({ ok: true, messageId: "wamid.B" });
    const sent = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body));
    expect(sent.recipient).toBe(BSUID);
    expect(sent).not.toHaveProperty("to");

    const thread = await rpc().getConversation({ wabaId: TEST_WABA_ID, waId: BSUID }, TEST_ACCOUNT_ID);
    expect(thread.items.map((m) => m.id)).toEqual(["wamid.B"]);
  });

  it("the RPC template send accepts a BSUID and still refuses anything else", async () => {
    const fetchSpy = mockBsuidSend();
    const send = (to: string) =>
      rpc().sendTemplateTest(
        { wabaId: TEST_WABA_ID, phoneNumberId: "PNID1", to, templateName: "hello_world", languageCode: "en_US" },
        TEST_ACCOUNT_ID,
      );
    expect(await send(BSUID)).toEqual({ ok: true, messageId: "wamid.B" });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)).recipient).toBe(BSUID);
    await expect(send("US-1349")).rejects.toThrow("to must be 5-15 digits or a BSUID");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("the public send route sends a BSUID as recipient", async () => {
    const fetchSpy = mockBsuidSend();
    const res = await postMessage({ to: BSUID, type: "text", text: { body: "hi" } });
    expect(res.status).toBe(200);
    const sent = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body));
    expect(sent).toMatchObject({ messaging_product: "whatsapp", recipient: BSUID, type: "text" });
    expect(sent).not.toHaveProperty("to");
  });

  it("the public send route accepts Meta's recipient when to is absent, and to wins when both are sent", async () => {
    const fetchSpy = mockBsuidSend();
    expect((await postMessage({ recipient: BSUID, type: "text", text: { body: "hi" } })).status).toBe(200);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body))).toMatchObject({ recipient: BSUID });
    const thread = await rpc().getConversation({ wabaId: TEST_WABA_ID, waId: BSUID }, TEST_ACCOUNT_ID);
    expect(thread.items.map((m) => m.id)).toEqual(["wamid.B"]);

    expect((await postMessage({ recipient: "34600000001", type: "text", text: { body: "hi" } })).status).toBe(400);
    expect((await postMessage({ to: "hello", recipient: BSUID, type: "text", text: { body: "hi" } })).status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("the public send route refuses a to that is neither a phone number nor a BSUID", async () => {
    const fetchSpy = mockBsuidSend();
    for (const to of ["hello", "us.1349", "US.", "1234", "+34 600 000 000 000 000", 34600000000]) {
      const res = await postMessage({ to, type: "text", text: { body: "hi" } });
      expect(res.status, String(to)).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        error: "invalid to: expected a phone number (5-15 digits) or a BSUID",
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await postMessage({ to: "+34 600-000-001", type: "text", text: { body: "hi" } })).status).toBe(200);
  });
});

describe("erasing a BSUID customer", () => {
  it("removes their events, sends, deliveries and conversation, and keeps everyone else", async () => {
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      i.ingest([
        { type: "reply", from: BSUID, fromUserId: BSUID, messageId: "wamid.IN", text: "hi", at: 1 },
        { type: "reply", from: OTHER, messageId: "wamid.OTHER", text: "hey", at: 2 },
      ]);
      i.logOutbound("wamid.OUT", BSUID, JSON.stringify({ to: BSUID, type: "text", text: { body: "yo" } }), "sent", null, "PNID1", BSUID);
      i.ingest([{ type: "delivered", transportMessageId: "wamid.OUT", at: 3 }]);
    });

    const result = await runInDurableObject(gatewayStub(), (i: EccosGateway) => i.eraseByPhone(` ${BSUID} `));
    expect(result).toMatchObject({
      ok: true,
      phone: BSUID,
      counts: { inboundEventsDeleted: 2, outboundMessagesDeleted: 1, messagesDeleted: 2, contactsDeleted: 1 },
    });

    const left = await runInDurableObject(gatewayStub(), (i: EccosGateway) => ({
      inbound: i.sql.exec(`SELECT message_id FROM inbound_events`).toArray(),
      messages: i.sql.exec(`SELECT wa_id FROM messages`).toArray(),
      deliveries: i.sql.exec(`SELECT payload FROM deliveries`).toArray().map((r) => String(r.payload)),
      erased: i.sql.exec(`SELECT digits FROM erased_numbers`).toArray(),
    }));
    expect(left.inbound).toEqual([{ message_id: "wamid.OTHER" }]);
    expect(left.messages).toEqual([{ wa_id: OTHER }]);
    expect(left.deliveries.some((p) => p.includes(BSUID))).toBe(false);
    expect(left.erased).toEqual([{ digits: BSUID }]);
  });

  it("the HTTP erasure route accepts a BSUID", async () => {
    const res = await exports.default.fetch(`http://example.com/v1/wabas/${TEST_WABA_ID}/privacy/erasure`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ phone: BSUID }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, phone: BSUID });
  });
});

describe("one customer, one conversation (phone and BSUID)", () => {
  const PHONE = "34600000001";
  const withPhone = { type: "reply", from: PHONE, fromUserId: BSUID, messageId: "wamid.P", text: "hi", at: 1_000 };
  const bsuidOnly = { type: "reply", from: BSUID, fromUserId: BSUID, messageId: "wamid.U", text: "again", at: 2_000 };

  async function store() {
    return runInDurableObject(gatewayStub(), (i: EccosGateway) => ({
      messages: i.sql.exec(`SELECT id, wa_id FROM messages ORDER BY at`).toArray(),
      contacts: i.sql.exec(`SELECT wa_id, name FROM contacts`).toArray(),
      pairs: i.sql.exec(`SELECT user_id, wa_id FROM customer_ids`).toArray(),
    }));
  }

  it("files a later BSUID-only message under the phone the BSUID is known to belong to", async () => {
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      i.ingest([withPhone as never]);
      i.ingest([bsuidOnly as never]);
    });
    expect(await store()).toEqual({
      messages: [
        { id: "wamid.P", wa_id: PHONE },
        { id: "wamid.U", wa_id: PHONE },
      ],
      contacts: [{ wa_id: PHONE, name: null }],
      pairs: [{ user_id: BSUID, wa_id: PHONE }],
    });
    const thread = await rpc().getConversation({ wabaId: TEST_WABA_ID, waId: BSUID }, TEST_ACCOUNT_ID);
    expect(thread.items.map((m) => m.id)).toEqual(["wamid.P", "wamid.U"]);
  });

  it("merges a conversation stored under the BSUID once the phone is learned", async () => {
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      i.ingest([{ ...bsuidOnly, profileName: "Ana" } as never]);
      i.ingest([withPhone as never]);
    });
    expect(await store()).toEqual({
      messages: [
        { id: "wamid.P", wa_id: PHONE },
        { id: "wamid.U", wa_id: PHONE },
      ],
      contacts: [{ wa_id: PHONE, name: "Ana" }],
      pairs: [{ user_id: BSUID, wa_id: PHONE }],
    });
  });

  it("learns the pairs retained events already name when an existing store first gets the table", async () => {
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      i.ingest([bsuidOnly as never]);
      // An event stored before the pair table existed: in inbound_events, never paired.
      i.sql.exec(
        `INSERT INTO inbound_events (type, message_id, payload, received_at) VALUES ('reply', 'wamid.P', ?, 0)`,
        JSON.stringify(withPhone),
      );
      i.sql.exec(`DELETE FROM customer_ids`);
      i.backfillCustomerIds();
    });
    expect((await store()).messages).toEqual([{ id: "wamid.U", wa_id: PHONE }]);
  });

  it("erasing the phone erases the BSUID-only events too, and forgets the pair", async () => {
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      i.ingest([withPhone as never]);
      i.ingest([bsuidOnly as never]);
    });
    const result = await runInDurableObject(gatewayStub(), (i: EccosGateway) => i.eraseByPhone(PHONE));
    expect(result).toMatchObject({ ok: true, counts: { inboundEventsDeleted: 2, messagesDeleted: 2, contactsDeleted: 1 } });
    expect(await store()).toEqual({ messages: [], contacts: [], pairs: [] });
    const erased = await runInDurableObject(gatewayStub(), (i: EccosGateway) =>
      i.sql.exec(`SELECT digits FROM erased_numbers ORDER BY digits`).toArray(),
    );
    expect(erased).toEqual([{ digits: PHONE }, { digits: BSUID }]);
  });

  it("erasing the BSUID erases the phone's conversation too", async () => {
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => i.ingest([withPhone as never]));
    const result = await runInDurableObject(gatewayStub(), (i: EccosGateway) => i.eraseByPhone(BSUID));
    expect(result).toMatchObject({ ok: true, counts: { inboundEventsDeleted: 1, messagesDeleted: 1 } });
    expect(await store()).toEqual({ messages: [], contacts: [], pairs: [] });
  });
});
