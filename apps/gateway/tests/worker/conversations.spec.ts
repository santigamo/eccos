import { env, exports } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { TEST_ACCOUNT_ID, TEST_WABA_ID, bootstrapAccount, gatewayStub } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;
const WA = "34600000001";
const OTHER = "34600000002";
const THIRD = "34600000003";
const FOURTH = "34600000004";
const PHONE_NUMBER_ID = "PNID1";
// A Brazilian-style number as typed, and the form Meta answers with (ninth digit dropped).
const TYPED = "5511900000001";
const META_ID = "551100000001";

let API_KEY = "ek-test";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

beforeEach(async () => {
  const boot = await bootstrapAccount();
  API_KEY = boot.apiKey;
});

function textSend(to: string, body: string): string {
  return JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } });
}

describe("conversation store: live feed", () => {
  it("stores an exchange in order with direction and status per message", async () => {
    // Sends are stamped by Eccos' clock, not Meta's, so the timeline is built
    // around "now": the customer wrote a minute before the send, staff and the
    // customer act a minute after it.
    const now = Date.now();
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([{ type: "reply", from: WA, messageId: "wamid.IN1", text: "hola", at: now - 60_000 }]);
      i.logOutbound("wamid.OUT1", WA, textSend(WA, "hello"), "sent", null, PHONE_NUMBER_ID);
      i.ingest([{ type: "delivered", transportMessageId: "wamid.OUT1", at: now + 1_000 }]);
      i.ingest([{ type: "read", transportMessageId: "wamid.OUT1", at: now + 2_000 }]);
      i.ingest([
        {
          type: "message_echo",
          to: WA,
          messageId: "wamid.ECHO1",
          at: now + 60_000,
          messageType: "image",
          media: { id: "MEDIA1", mimeType: "image/jpeg", caption: "look" },
        },
      ]);
      i.ingest([
        {
          type: "message",
          from: WA,
          messageId: "wamid.REACT1",
          at: now + 120_000,
          messageType: "reaction",
          reaction: { messageId: "wamid.OUT1", emoji: "👍" },
        },
      ]);

      // The number is read in its formatted form: the gateway normalizes it.
      const messages = i.getConversation({ waId: "+34 600-000-001" }).items;
      expect(messages.map((m) => [m.id, m.direction, m.status, m.type, m.text])).toEqual([
        ["wamid.IN1", "in", null, "text", "hola"],
        ["wamid.OUT1", "out", "read", "text", "hello"],
        ["wamid.ECHO1", "echo", "sent", "image", "look"],
        ["wamid.REACT1", "in", null, "reaction", null],
      ]);
      expect(messages[1]).toMatchObject({ origin: "live", phoneNumberId: PHONE_NUMBER_ID, waId: WA });
      expect(JSON.parse(messages[2]!.content!)).toMatchObject({ media: { id: "MEDIA1", mimeType: "image/jpeg" } });
      expect(messages[3]!.targetId).toBe("wamid.OUT1");
      expect(messages[3]!.content).toContain('"emoji":"👍"');
    });
  });

  it("labels an outbound template by its name and media by its caption", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const template = JSON.stringify({
        type: "template",
        to: WA,
        template: { name: "order_update", language: { code: "es" } },
      });
      const image = JSON.stringify({ type: "image", to: WA, image: { link: "https://cdn.test/a.jpg", caption: "Factura" } });
      i.logOutbound("wamid.TPL1", WA, template, "sent", null);
      i.logOutbound("wamid.IMG1", WA, image, "sent", null);
      i.logOutbound("wamid.FAIL1", WA, textSend(WA, "never sent"), "failed", "{}");

      const messages = i.getConversation({ waId: WA }).items;
      expect(messages.map((m) => [m.id, m.type, m.text])).toEqual([
        ["wamid.TPL1", "template", "template:order_update"],
        ["wamid.IMG1", "image", "Factura"],
      ]);
    });
  });

  it("ignores a duplicate webhook: one message, one contact", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const reply = { type: "reply" as const, from: WA, messageId: "wamid.DUP1", text: "once", at: 1000 };
      i.ingest([reply]);
      i.ingest([reply]);
      expect(i.getConversation({ waId: WA }).items).toHaveLength(1);
      expect(i.listConversations().items).toEqual([
        {
          waId: WA,
          name: null,
          messageCount: 1,
          lastMessage: { type: "text", text: "once", direction: "in", at: 1000 },
        },
      ]);
    });
  });

  it("never downgrades a status and keeps failed terminal", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.logOutbound("wamid.READ1", WA, textSend(WA, "a"), "sent", null);
      i.ingest([{ type: "read", transportMessageId: "wamid.READ1", at: 2000 }]);
      i.ingest([{ type: "delivered", transportMessageId: "wamid.READ1", at: 1500 }]);
      i.ingest([{ type: "failed", transportMessageId: "wamid.READ1", at: 2500, errorCode: "131047" }]);

      i.logOutbound("wamid.FAIL2", WA, textSend(WA, "b"), "sent", null);
      i.ingest([{ type: "failed", transportMessageId: "wamid.FAIL2", at: 3000, errorCode: "131047" }]);
      i.ingest([{ type: "delivered", transportMessageId: "wamid.FAIL2", at: 3100 }]);
      i.ingest([{ type: "read", transportMessageId: "wamid.FAIL2", at: 3200 }]);

      const byId = Object.fromEntries(i.getConversation({ waId: WA }).items.map((m) => [m.id, m]));
      expect(byId["wamid.READ1"]).toMatchObject({ status: "read", error: null });
      expect(byId["wamid.FAIL2"]).toMatchObject({ status: "failed", error: "131047" });
    });
  });

  it("applies a status that overtook its own send's log", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([{ type: "delivered", transportMessageId: "wamid.EARLY1", at: 1000 }]);
      i.logOutbound("wamid.EARLY1", WA, textSend(WA, "early"), "sent", null);
      expect(i.getConversation({ waId: WA }).items[0]).toMatchObject({ id: "wamid.EARLY1", status: "delivered" });
    });
  });
});

describe("conversation store: reads", () => {
  it("lists conversations newest first, with names and counts, paged by cursor", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([
        { type: "reply", from: WA, messageId: "wamid.A1", text: "a1", at: 1000 },
        { type: "reply", from: WA, messageId: "wamid.A2", text: "a2", at: 5000 },
        { type: "reply", from: OTHER, messageId: "wamid.B1", text: "b1", at: 2000 },
        { type: "reply", from: OTHER, messageId: "wamid.B2", text: "b2", at: 3000 },
        { type: "reply", from: THIRD, messageId: "wamid.C1", text: "c1", at: 1500 },
      ]);
      i.sql.exec(`UPDATE contacts SET name = 'Alice', source = 'history' WHERE wa_id = ?`, WA);

      const all = i.listConversations().items;
      expect(all.map((c) => [c.waId, c.name, c.messageCount, c.lastMessage.at])).toEqual([
        [WA, "Alice", 2, 5000],
        [OTHER, null, 2, 3000],
        [THIRD, null, 1, 1500],
      ]);

      const firstPage = i.listConversations({ limit: 2 });
      expect(firstPage.items.map((c) => c.waId)).toEqual([WA, OTHER]);
      expect(firstPage.nextCursor).not.toBeNull();
      const nextPage = i.listConversations({ limit: 2, cursor: firstPage.nextCursor! });
      expect(nextPage.items.map((c) => c.waId)).toEqual([THIRD]);
      expect(nextPage.nextCursor).toBeNull();
    });
  });

  it("pages a conversation backwards, oldest first within each page", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest(
        [1, 2, 3, 4, 5].map((n) => ({ type: "reply" as const, from: WA, messageId: `wamid.P${n}`, text: `${n}`, at: n * 1000 })),
      );
      const newest = i.getConversation({ waId: WA, limit: 2 });
      expect(newest.items.map((m) => m.id)).toEqual(["wamid.P4", "wamid.P5"]);
      const older = i.getConversation({ waId: WA, limit: 2, cursor: newest.nextCursor! });
      expect(older.items.map((m) => m.id)).toEqual(["wamid.P2", "wamid.P3"]);
      const oldest = i.getConversation({ waId: WA, limit: 2, cursor: older.nextCursor! });
      expect(oldest.items.map((m) => m.id)).toEqual(["wamid.P1"]);
      expect(oldest.nextCursor).toBeNull();
    });
  });

  it("pages messages that share a timestamp without skipping or repeating any", async () => {
    // Meta stamps whole seconds, so bursts tie. With limit 2 the page boundary
    // falls inside the tie at 2000: a `before`-only cursor would drop one of B and C.
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([
        { type: "reply", from: WA, messageId: "wamid.A", text: "a", at: 1000 },
        { type: "reply", from: WA, messageId: "wamid.B", text: "b", at: 2000 },
        { type: "reply", from: WA, messageId: "wamid.C", text: "c", at: 2000 },
        { type: "reply", from: WA, messageId: "wamid.D", text: "d", at: 2000 },
        { type: "reply", from: WA, messageId: "wamid.E", text: "e", at: 3000 },
      ]);

      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = i.getConversation({ waId: WA, limit: 2, cursor });
        pages.push(page.items.map((m) => m.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(pages).toEqual([["wamid.D", "wamid.E"], ["wamid.B", "wamid.C"], ["wamid.A"]]);
    });
  });

  it("pages conversations whose latest messages share a timestamp", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([
        { type: "reply", from: OTHER, messageId: "wamid.T1", text: "t1", at: 1000 },
        { type: "reply", from: THIRD, messageId: "wamid.T2", text: "t2", at: 1000 },
        { type: "reply", from: FOURTH, messageId: "wamid.T3", text: "t3", at: 1000 },
        { type: "reply", from: WA, messageId: "wamid.T4", text: "t4", at: 2000 },
      ]);

      const first = i.listConversations({ limit: 2 });
      expect(first.items.map((c) => c.waId)).toEqual([WA, FOURTH]);
      const second = i.listConversations({ limit: 2, cursor: first.nextCursor! });
      expect(second.items.map((c) => c.waId)).toEqual([THIRD, OTHER]);
      expect(second.nextCursor).toBeNull();
    });
  });

  it("rejects a cursor it did not issue", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([{ type: "reply", from: WA, messageId: "wamid.BAD", text: "x", at: 1000 }]);
      expect(() => i.getConversation({ waId: WA, cursor: btoa("nope") })).toThrow(/invalid cursor/);
      expect(() => i.listConversations({ cursor: "%%%" })).toThrow();
    });
  });

  it("returns the store through exportData with messages and contacts", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([{ type: "reply", from: WA, messageId: "wamid.E1", text: "export me", at: 1000 }]);
      const exported = i.exportData();
      expect(exported.messages.map((m) => m.id)).toEqual(["wamid.E1"]);
      expect(exported.contacts).toEqual([{ waId: WA, name: null, source: "live", updatedAt: expect.any(Number) }]);
    });
  });
});

describe("conversation store: backfill", () => {
  it("rebuilds the store from pre-existing rows, and rerunning adds nothing", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.sql.exec("DELETE FROM messages");
      i.sql.exec("DELETE FROM contacts");
      i.sql.exec(
        `INSERT INTO inbound_events (type, transport_message_id, message_id, payload, received_at) VALUES (?, NULL, ?, ?, ?)`,
        "reply",
        "wamid.L1",
        JSON.stringify({ type: "reply", from: WA, messageId: "wamid.L1", text: "old", at: 100 }),
        100,
      );
      i.sql.exec(
        `INSERT INTO outbound_messages (transport_message_id, recipient, phone_number_id, request, status, error, created_at)
         VALUES (?, ?, ?, ?, 'sent', NULL, ?)`,
        "wamid.LO1",
        WA,
        PHONE_NUMBER_ID,
        textSend(WA, "old reply"),
        200,
      );
      i.sql.exec(
        `INSERT INTO inbound_events (type, transport_message_id, payload, received_at) VALUES (?, ?, ?, ?)`,
        "delivered",
        "wamid.LO1",
        JSON.stringify({ type: "delivered", transportMessageId: "wamid.LO1", at: 300 }),
        300,
      );

      i.backfillConversations();
      i.backfillConversations();

      const messages = i.getConversation({ waId: WA }).items;
      expect(messages.map((m) => [m.id, m.direction, m.status, m.text])).toEqual([
        ["wamid.L1", "in", null, "old"],
        ["wamid.LO1", "out", "delivered", "old reply"],
      ]);
      expect(i.listConversations().items[0]).toMatchObject({ waId: WA, messageCount: 2 });
    });
  });
});

describe("conversation store: send under Meta's wa_id", () => {
  it("files a send under the wa_id Meta answered with, beside the customer's inbound", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([{ type: "reply", from: META_ID, messageId: "wamid.BR_IN", text: "oi", at: 1000 }]);
      i.logOutbound("wamid.BR_OUT", TYPED, textSend(TYPED, "ola"), "sent", null, PHONE_NUMBER_ID, META_ID);

      expect(i.getConversation({ waId: META_ID }).items.map((m) => [m.id, m.direction])).toEqual([
        ["wamid.BR_IN", "in"],
        ["wamid.BR_OUT", "out"],
      ]);
      expect(i.getConversation({ waId: TYPED }).items).toEqual([]);
      expect(i.listConversations().items.map((c) => [c.waId, c.messageCount])).toEqual([[META_ID, 2]]);
      // The send log keeps the recipient as the caller typed it.
      expect(i.sql.exec(`SELECT recipient FROM outbound_messages`).toArray()).toEqual([{ recipient: TYPED }]);
    });
  });

  it("falls back to the typed recipient when Meta omits the wa_id", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.logOutbound("wamid.NOWA", TYPED, textSend(TYPED, "hola"), "sent", null, PHONE_NUMBER_ID);
      expect(i.getConversation({ waId: TYPED }).items.map((m) => m.id)).toEqual(["wamid.NOWA"]);
    });
  });

  it("the console send files under the wa_id Meta answered with", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: TYPED, wa_id: META_ID }], messages: [{ id: "wamid.CON1" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await new GatewayRPC(createExecutionContext(), env).sendTemplateTest(
      { wabaId: TEST_WABA_ID, phoneNumberId: PHONE_NUMBER_ID, to: TYPED, templateName: "hello_world", languageCode: "en_US" },
      TEST_ACCOUNT_ID,
    );
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      expect(i.getConversation({ waId: META_ID }).items.map((m) => m.id)).toEqual(["wamid.CON1"]);
    });
  });

  it("the public send route files under the wa_id Meta answered with and keeps its response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: TYPED, wa_id: META_ID }], messages: [{ id: "wamid.API1" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const res = await exports.default.fetch(`http://example.com/v1/wabas/${TEST_WABA_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ to: TYPED, type: "text", text: { body: "hola" } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messages: [{ id: "wamid.API1" }] });
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      expect(i.getConversation({ waId: META_ID }).items.map((m) => m.id)).toEqual(["wamid.API1"]);
    });
  });
});

describe("conversation store: guarded replay", () => {
  it("a bad stored payload is skipped by the backfill instead of failing it", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.sql.exec("DELETE FROM messages");
      i.sql.exec("DELETE FROM contacts");
      i.sql.exec(
        `INSERT INTO inbound_events (type, transport_message_id, message_id, payload, received_at) VALUES ('reply', NULL, 'wamid.BAD1', 'not json', 100)`,
      );
      i.sql.exec(
        `INSERT INTO inbound_events (type, transport_message_id, message_id, payload, received_at) VALUES ('reply', NULL, 'wamid.GOOD1', ?, 200)`,
        JSON.stringify({ type: "reply", from: WA, messageId: "wamid.GOOD1", text: "fine", at: 200 }),
      );

      expect(() => i.backfillConversations()).not.toThrow();
      expect(i.getConversation({ waId: WA }).items.map((m) => m.id)).toEqual(["wamid.GOOD1"]);
    });
  });

  it("a bad stored status payload cannot roll back a real send's log", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.sql.exec(
        `INSERT INTO inbound_events (type, transport_message_id, payload, received_at) VALUES ('delivered', 'wamid.BADSTATUS', 'not json', 100)`,
      );
      i.logOutbound("wamid.BADSTATUS", WA, textSend(WA, "still logged"), "sent", null, PHONE_NUMBER_ID);

      expect(i.sql.exec(`SELECT COUNT(*) AS c FROM outbound_messages WHERE transport_message_id = 'wamid.BADSTATUS'`).toArray()[0]?.c).toBe(1);
      expect(i.getConversation({ waId: WA }).items.map((m) => [m.id, m.text])).toEqual([["wamid.BADSTATUS", "still logged"]]);
    });
  });
});

describe("conversation store: erasure and retention", () => {
  it("eraseByPhone removes that number's messages and contact and nothing else", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([
        { type: "reply", from: WA, messageId: "wamid.W1", text: "mine", at: 1000 },
        { type: "reply", from: OTHER, messageId: "wamid.O1", text: "theirs", at: 2000 },
      ]);
      i.logOutbound("wamid.WO1", WA, textSend(WA, "to mine"), "sent", null);

      const result = await i.eraseByPhone(WA);
      expect(result).toMatchObject({ ok: true, counts: { messagesDeleted: 2, contactsDeleted: 1 } });
      expect(i.getConversation({ waId: WA }).items).toEqual([]);
      expect(i.listConversations().items.map((c) => c.waId)).toEqual([OTHER]);
      expect(i.exportData().contacts.map((c) => c.waId)).toEqual([OTHER]);
    });
  });

  it("eraseByPhone by the typed number also removes a send filed under Meta's wa_id", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.logOutbound("wamid.ERA1", TYPED, textSend(TYPED, "gone"), "sent", null, PHONE_NUMBER_ID, META_ID);

      const result = await i.eraseByPhone(TYPED);
      expect(result).toMatchObject({ ok: true, counts: { messagesDeleted: 1, contactsDeleted: 1 } });
      expect(i.getConversation({ waId: META_ID }).items).toEqual([]);
      expect(i.exportData().contacts).toEqual([]);
    });
  });

  it("pruneExpired leaves messages and contacts in place", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([{ type: "reply", from: WA, messageId: "wamid.R1", text: "kept", at: 1000 }]);
      i.logOutbound("wamid.RO1", WA, textSend(WA, "kept too"), "sent", null);

      i.pruneExpired(Date.now() + 365 * DAY_MS, 7, 90);

      // The content tables are swept, the conversation store is not.
      expect(i.sql.exec("SELECT COUNT(*) AS c FROM inbound_events").toArray()[0]?.c).toBe(0);
      expect(i.getConversation({ waId: WA }).items).toHaveLength(2);
      expect(i.exportData().contacts).toHaveLength(1);
    });
  });
});

describe("conversation store: RPC scoping", () => {
  it("reads through the account that owns the WABA and rejects a foreign account", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([{ type: "reply", from: WA, messageId: "wamid.RPC1", text: "via rpc", at: 1000 }]);
    });
    const rpc = new GatewayRPC(createExecutionContext(), env);

    const conversations = await rpc.listConversations({ wabaId: TEST_WABA_ID }, TEST_ACCOUNT_ID);
    expect(conversations.items.map((c) => c.waId)).toEqual([WA]);
    const messages = await rpc.getConversation({ wabaId: TEST_WABA_ID, waId: WA }, TEST_ACCOUNT_ID);
    expect(messages.items.map((m) => m.id)).toEqual(["wamid.RPC1"]);

    await expect(rpc.listConversations({ wabaId: TEST_WABA_ID }, "foreign-account")).rejects.toThrow(/not owned/);
    await expect(rpc.getConversation({ wabaId: TEST_WABA_ID, waId: WA }, "foreign-account")).rejects.toThrow(
      /not owned/,
    );
  });
});
