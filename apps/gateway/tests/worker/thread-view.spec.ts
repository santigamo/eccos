import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { TEST_ACCOUNT_ID, TEST_WABA_ID, bootstrapAccount, gatewayStub } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;
const WA = "34600000001";
const OTHER = "34600000002";

afterEach(async () => {
  await reset();
});

beforeEach(async () => {
  await bootstrapAccount();
});

interface Seed {
  id: string;
  waId?: string;
  direction?: "in" | "out" | "echo";
  type?: string;
  at: number;
  phone?: string | null;
}

function seed(i: EccosGateway, m: Seed): void {
  i.sql.exec(
    `INSERT INTO messages (id, wa_id, direction, origin, type, text, content, at, status, phone_number_id, created_at)
     VALUES (?, ?, ?, 'live', ?, ?, NULL, ?, NULL, ?, ?)`,
    m.id,
    m.waId ?? WA,
    m.direction ?? "in",
    m.type ?? "text",
    m.id,
    m.at,
    m.phone === undefined ? "PN1" : m.phone,
    m.at,
  );
}

function contact(i: EccosGateway, waId: string, name: string | null, source = "live"): void {
  i.sql.exec(`INSERT OR REPLACE INTO contacts (wa_id, name, source, updated_at) VALUES (?, ?, ?, 1)`, waId, name, source);
}

describe("getThreadView", () => {
  it("returns the contact's name however many conversations are newer", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const now = Date.now();
      contact(i, WA, "Ana");
      seed(i, { id: "old", at: now - 10 * DAY_MS });
      // More conversations than any list page holds, all newer than WA's.
      for (let n = 0; n < 130; n++) {
        const waId = `3470000${String(n).padStart(4, "0")}`;
        seed(i, { id: `n${n}`, waId, at: now - n * 1000 });
      }
      const view = i.getThreadView({ waId: WA });
      expect(view.contactName).toBe("Ana");
      expect(i.getThreadView({ waId: OTHER }).contactName).toBeNull();
    });
  });

  it("finds the newest inbound outside the first message page and keeps the page itself unchanged", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const now = Date.now();
      seed(i, { id: "in-a", at: now - 3 * DAY_MS, phone: "PN-A" });
      // 60 staff messages on another number bury it past a 50-message page.
      for (let n = 0; n < 60; n++) seed(i, { id: `out${n}`, direction: "out", at: now - 2 * DAY_MS + n, phone: "PN-B" });
      const view = i.getThreadView({ waId: WA, limit: 50 });
      expect(view.page.items).toHaveLength(50);
      expect(view.page).toEqual(i.getConversation({ waId: WA, limit: 50 }));
      expect(view.reply).toEqual({ phoneNumberId: "PN-A", lastInboundAt: now - 3 * DAY_MS });
      // The reply is thread-wide: an older page asks the same question.
      const older = i.getThreadView({ waId: WA, limit: 50, cursor: view.page.nextCursor! });
      expect(older.reply).toEqual(view.reply);
    });
  });

  it("has no window and uses the newest number when the customer never wrote", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const now = Date.now();
      seed(i, { id: "o1", direction: "out", at: now - 2000, phone: "PN-A" });
      seed(i, { id: "o2", direction: "echo", at: now - 1000, phone: "PN-B" });
      seed(i, { id: "o3", direction: "out", at: now, phone: null });
      expect(i.getThreadView({ waId: WA }).reply).toEqual({ phoneNumberId: "PN-B", lastInboundAt: null });
      expect(i.getThreadView({ waId: OTHER }).reply).toEqual({ phoneNumberId: null, lastInboundAt: null });
    });
  });

  it("does not let a system notice open the window or name the number", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const now = Date.now();
      seed(i, { id: "text", at: now - 3000, phone: "PN-A" });
      seed(i, { id: "sys", type: "system", at: now - 1000, phone: "PN-B" });
      expect(i.getThreadView({ waId: WA }).reply).toEqual({ phoneNumberId: "PN-A", lastInboundAt: now - 3000 });

      seed(i, { id: "sys-only", type: "system", waId: OTHER, at: now, phone: "PN-B" });
      expect(i.getThreadView({ waId: OTHER }).reply).toEqual({ phoneNumberId: "PN-B", lastInboundAt: null });
    });
  });

  it("falls back to the page's newest number when the newest inbound names none", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const now = Date.now();
      seed(i, { id: "in", at: now - 2000, phone: null });
      seed(i, { id: "out", direction: "out", at: now - 1000, phone: "PN-B" });
      expect(i.getThreadView({ waId: WA }).reply).toEqual({ phoneNumberId: "PN-B", lastInboundAt: null });
    });
  });

  it("breaks equal timestamps by insertion order, newest row first", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const at = Date.now() - 1000;
      seed(i, { id: "first", at, phone: "PN-A" });
      seed(i, { id: "second", at, phone: "PN-B" });
      expect(i.getThreadView({ waId: WA }).reply).toEqual({ phoneNumberId: "PN-B", lastInboundAt: at });
    });
  });

  it("normalizes a formatted number", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      contact(i, WA, "Ana");
      seed(i, { id: "in", at: 5000 });
      const view = i.getThreadView({ waId: "+34 600-000-001" });
      expect(view.contactName).toBe("Ana");
      expect(view.reply.lastInboundAt).toBe(5000);
    });
  });

  it("sees only what retention left: an expired inbound opens no window and the contact stays with a message left", async () => {
    await new GatewayRPC(createExecutionContext(), env).setConversationRetention(TEST_ACCOUNT_ID, 30);
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const now = Date.now();
      contact(i, WA, "Ana");
      seed(i, { id: "expired", at: now - 40 * DAY_MS, phone: "PN-A" });
      seed(i, { id: "kept-out", direction: "out", at: now - DAY_MS, phone: "PN-B" });
      expect(i.getThreadView({ waId: WA }).reply.lastInboundAt).toBe(now - 40 * DAY_MS);

      await i.pruneConversations(now);
      const view = i.getThreadView({ waId: WA });
      expect(view.reply).toEqual({ phoneNumberId: "PN-B", lastInboundAt: null });
      expect(view.page.items.map((m) => m.id)).toEqual(["kept-out"]);
      expect(view.contactName).toBe("Ana");
    });
  });

  it("uses the partial inbound index for the newest-inbound lookup", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const plan = i.sql
        .exec(
          `EXPLAIN QUERY PLAN SELECT at, phone_number_id FROM messages
           WHERE wa_id = ? AND direction = 'in' AND type <> 'system' ORDER BY at DESC, rowid DESC LIMIT 1`,
          WA,
        )
        .toArray()
        .map((row) => String(row.detail))
        .join(" ");
      expect(plan).toContain("idx_messages_wa_inbound");
    });
  });
});
