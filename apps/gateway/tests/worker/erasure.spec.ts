import { env, exports } from "cloudflare:workers";
import { runInDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { REDACTED_PAYLOAD, normalizePhoneNumber, type EccosGateway } from "../../src/gateway";
import { singletonStub } from "./helpers";

afterEach(async () => {
  await reset();
});

const PHONE_A = "34600000001"; // the erased data subject
const PHONE_B = "34600000002"; // unrelated contact that must survive intact

const replyA = { type: "reply", from: PHONE_A, messageId: "wamid.A1", text: "hi from A", at: 1 };
const replyB = { type: "reply", from: PHONE_B, messageId: "wamid.B1", text: "hi from B", at: 2 };
const echoA = { type: "echo", to: PHONE_A, messageId: "wamid.AECHO", text: "staff reply to A", at: 3 };
const statusOutA = { type: "delivered", transportMessageId: "wamid.OUTA", at: 4 };
const statusOutB = { type: "delivered", transportMessageId: "wamid.OUTB", at: 5 };

/**
 * Seeds both phones across the three tables:
 *  - inbound: reply A, reply B, echo A, delivered status for wamid.OUTA (sent to A),
 *    delivered status for wamid.OUTB (sent to B)
 *  - outbound: one API send to A (formatted number) + one to B
 *  - deliveries: a pending mixed batch (A+B), a pending A-only batch, a delivered
 *    status batch (A+B), and a delivered A-only batch
 */
function seed(i: EccosGateway) {
  const now = Date.now();
  const future = now + 3_600_000; // keep pending rows out of the alarm drain
  const insertInbound = (ev: Record<string, unknown>, tmid: string | null, mid: string | null) =>
    i.sql.exec(
      `INSERT INTO inbound_events (type, transport_message_id, message_id, payload, received_at)
       VALUES (?, ?, ?, ?, ?)`,
      ev.type as string,
      tmid,
      mid,
      JSON.stringify(ev),
      now,
    );
  insertInbound(replyA, null, "wamid.A1");
  insertInbound(replyB, null, "wamid.B1");
  insertInbound(echoA, null, "wamid.AECHO");
  insertInbound(statusOutA, "wamid.OUTA", null);
  insertInbound(statusOutB, "wamid.OUTB", null);

  i.logOutbound("wamid.OUTA", "+34 600-000-001", JSON.stringify({ to: "+34 600-000-001", text: "for A" }), "sent", null);
  i.logOutbound("wamid.OUTB", PHONE_B, JSON.stringify({ to: PHONE_B, text: "for B" }), "sent", null);

  const insertDelivery = (status: string, events: unknown[]) =>
    i.sql
      .exec(
        `INSERT INTO deliveries (payload, status, attempts, last_error, next_attempt_at, created_at)
         VALUES (?, ?, 1, NULL, ?, ?) RETURNING id`,
        JSON.stringify({ events }),
        status,
        future,
        now,
      )
      .toArray()[0]!.id as number;
  return {
    mixedPending: insertDelivery("pending", [replyA, replyB]),
    aOnlyPending: insertDelivery("pending", [echoA]),
    statusDelivered: insertDelivery("delivered", [statusOutA, statusOutB]),
    aOnlyDelivered: insertDelivery("delivered", [replyA]),
  };
}

describe("EccosGateway.eraseByPhone", () => {
  it("erases every trace of the phone across the three tables and reports counts", async () => {
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      const ids = seed(i);
      // The formatted input must normalize to the stored digits.
      const result = i.eraseByPhone("+34 600 000 001");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.phone).toBe(PHONE_A);
      expect(result.counts).toEqual({
        // reply A + echo A (direct) + status wamid.OUTA (linked via outbound wamid)
        inboundEventsDeleted: 3,
        outboundMessagesDeleted: 1,
        // mixed pending rewritten + status batch rewritten + A-only delivered redacted
        deliveriesRedacted: 3,
        // A-only pending batch had nothing left to forward
        deliveriesDeleted: 1,
      });

      // inbound: only B rows survive.
      const inbound = i.sql.exec("SELECT payload FROM inbound_events ORDER BY id").toArray();
      expect(inbound).toHaveLength(2);
      expect(inbound.map((r) => JSON.parse(r.payload as string))).toEqual([replyB, statusOutB]);

      // outbound: only B's send survives.
      const outbound = i.sql.exec("SELECT recipient FROM outbound_messages").toArray();
      expect(outbound.map((r) => r.recipient)).toEqual([PHONE_B]);

      // mixed pending batch: rewritten to keep only B's event, still pending.
      const mixed = i.getDelivery(ids.mixedPending)!;
      expect(mixed.status).toBe("pending");
      expect(JSON.parse(mixed.payload)).toEqual({ events: [replyB] });

      // A-only pending batch: deleted outright.
      expect(i.getDelivery(ids.aOnlyPending)).toBeNull();

      // status batch: rewritten to keep only the wamid.OUTB status.
      expect(JSON.parse(i.getDelivery(ids.statusDelivered)!.payload)).toEqual({ events: [statusOutB] });

      // A-only terminal batch: redacted in place, metadata kept.
      const redacted = i.getDelivery(ids.aOnlyDelivered)!;
      expect(redacted.payload).toBe(REDACTED_PAYLOAD);
      expect(redacted.status).toBe("delivered");
    });
  });

  it("is idempotent — a second erasure affects nothing", async () => {
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      seed(i);
      i.eraseByPhone(PHONE_A);
      const second = i.eraseByPhone(PHONE_A);
      expect(second).toEqual({
        ok: true,
        phone: PHONE_A,
        counts: {
          inboundEventsDeleted: 0,
          outboundMessagesDeleted: 0,
          deliveriesRedacted: 0,
          deliveriesDeleted: 0,
        },
      });
    });
  });

  it("does not match numbers that merely contain the digits as a substring", async () => {
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      // A longer number containing PHONE_A's digits, and a message text quoting them.
      i.logOutbound("wamid.LONG", `9${PHONE_A}9`, "{}", "sent", null);
      i.sql.exec(
        `INSERT INTO inbound_events (type, transport_message_id, message_id, payload, received_at)
         VALUES ('reply', NULL, 'wamid.TEXT', ?, ?)`,
        JSON.stringify({ type: "reply", from: PHONE_B, messageId: "wamid.TEXT", text: `call ${PHONE_A}`, at: 9 }),
        Date.now(),
      );
      const result = i.eraseByPhone(PHONE_A);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.counts.outboundMessagesDeleted).toBe(0);
      expect(result.counts.inboundEventsDeleted).toBe(0);
    });
  });

  it("rejects inputs with fewer than 5 digits", async () => {
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      const result = i.eraseByPhone("+3-4");
      expect(result).toEqual({ ok: false, error: "invalid phone number: expected at least 5 digits" });
    });
  });
});

describe("normalizePhoneNumber", () => {
  it("strips every non-digit and requires at least 5 digits", () => {
    expect(normalizePhoneNumber("+34 600-000-001")).toBe("34600000001");
    expect(normalizePhoneNumber("34600000001")).toBe("34600000001");
    expect(normalizePhoneNumber("+1 (555) 010-9999")).toBe("15550109999");
    expect(normalizePhoneNumber("1234")).toBeNull();
    expect(normalizePhoneNumber("")).toBeNull();
  });
});

describe("POST /v1/privacy/erasure", () => {
  const url = "http://example.com/v1/privacy/erasure";
  const authed = (body: unknown) =>
    exports.default.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ECCOS_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  it("requires the API key (same gate as the rest of /v1)", async () => {
    const res = await exports.default.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: PHONE_A }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects bodies without a phone string", async () => {
    for (const body of [{}, { phone: 42 }, { phone: "" }]) {
      const res = await authed(body);
      expect(res.status).toBe(400);
    }
  });

  it("rejects a phone with fewer than 5 digits", async () => {
    const res = await authed({ phone: "12" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid phone number: expected at least 5 digits" });
  });

  it("erases and returns the per-table counts", async () => {
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      seed(i);
    });
    const res = await authed({ phone: "+34 600 000 001" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      phone: PHONE_A,
      counts: {
        inboundEventsDeleted: 3,
        outboundMessagesDeleted: 1,
        deliveriesRedacted: 3,
        deliveriesDeleted: 1,
      },
    });
  });
});
