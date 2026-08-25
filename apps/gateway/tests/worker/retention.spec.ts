import { runInDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { REDACTED_PAYLOAD, resolveRetentionDays, type EccosGateway } from "../../src/gateway";
import { singletonStub } from "./helpers";

afterEach(async () => {
  await reset();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const SAMPLE_PAYLOAD = JSON.stringify({
  events: [{ type: "reply", from: "34600000000", messageId: "wamid.R", text: "hello", at: 1_700_000_000_000 }],
});

function insertDelivery(
  instance: EccosGateway,
  opts: { ageDays: number; status: string; lastError?: string | null; payload?: string },
): number {
  const ts = Date.now() - opts.ageDays * DAY_MS;
  const rows = instance.sql
    .exec(
      `INSERT INTO deliveries (payload, status, attempts, last_error, next_attempt_at, created_at)
       VALUES (?, ?, 3, ?, ?, ?) RETURNING id`,
      opts.payload ?? SAMPLE_PAYLOAD,
      opts.status,
      opts.lastError ?? null,
      // Far in the future so the alarm's pending drain never picks these rows up.
      Date.now() + 3_600_000,
      ts,
    )
    .toArray();
  return rows[0]!.id as number;
}

describe("split retention", () => {
  it("redacts terminal delivery payloads past the content window (30 days)", async () => {
    let redactedId = 0;
    let failedId = 0;
    let freshId = 0;
    let pendingId = 0;
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      redactedId = insertDelivery(i, { ageDays: 31, status: "delivered" });
      failedId = insertDelivery(i, { ageDays: 31, status: "failed", lastError: "boom" });
      freshId = insertDelivery(i, { ageDays: 5, status: "delivered" });
      pendingId = insertDelivery(i, { ageDays: 40, status: "pending" });
      await i.alarm();

      expect(i.getDelivery(redactedId)?.payload).toBe(REDACTED_PAYLOAD);
      expect(i.getDelivery(failedId)?.payload).toBe(REDACTED_PAYLOAD);
      // Fresh terminal rows and pending rows (any age) keep their payload.
      expect(i.getDelivery(freshId)?.payload).toBe(SAMPLE_PAYLOAD);
      expect(i.getDelivery(pendingId)?.payload).toBe(SAMPLE_PAYLOAD);
    });
  });

  it("keeps all metadata on a redacted row — only payload is emptied", async () => {
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      const id = insertDelivery(i, { ageDays: 31, status: "failed", lastError: "subscriber non-2xx" });
      const before = i.getDelivery(id)!;
      await i.alarm();
      const after = i.getDelivery(id)!;
      expect(after.payload).toBe(REDACTED_PAYLOAD);
      expect(after).toMatchObject({
        id: before.id,
        status: "failed",
        attempts: before.attempts,
        last_error: "subscriber non-2xx",
        next_attempt_at: before.next_attempt_at,
        created_at: before.created_at,
      });
    });
  });

  it("deletes terminal deliveries past the delivery window (90 days)", async () => {
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      const gone1 = insertDelivery(i, { ageDays: 91, status: "delivered" });
      const gone2 = insertDelivery(i, { ageDays: 95, status: "failed", lastError: "boom" });
      const keptRedacted = insertDelivery(i, { ageDays: 89, status: "delivered" });
      await i.alarm();

      expect(i.getDelivery(gone1)).toBeNull();
      expect(i.getDelivery(gone2)).toBeNull();
      // Inside the delivery window but past the content window: row survives, redacted.
      const kept = i.getDelivery(keptRedacted);
      expect(kept).not.toBeNull();
      expect(kept!.payload).toBe(REDACTED_PAYLOAD);
    });
  });

  it("prunes inbound_events and outbound_messages past the content window", async () => {
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      const old = Date.now() - 31 * DAY_MS;
      const fresh = Date.now() - 1 * DAY_MS;
      i.sql.exec(
        `INSERT INTO inbound_events (type, transport_message_id, message_id, payload, received_at)
         VALUES ('reply', NULL, 'wamid.OLD', '{}', ?), ('reply', NULL, 'wamid.NEW', '{}', ?)`,
        old,
        fresh,
      );
      i.sql.exec(
        `INSERT INTO outbound_messages (transport_message_id, recipient, request, status, error, created_at)
         VALUES ('wamid.O1', '34600000000', '{}', 'sent', NULL, ?), ('wamid.O2', '34600000000', '{}', 'sent', NULL, ?)`,
        old,
        fresh,
      );
      await i.alarm();

      const inbound = i.sql.exec("SELECT message_id FROM inbound_events").toArray();
      expect(inbound.map((r) => r.message_id)).toEqual(["wamid.NEW"]);
      const outbound = i.sql.exec("SELECT transport_message_id FROM outbound_messages").toArray();
      expect(outbound.map((r) => r.transport_message_id)).toEqual(["wamid.O2"]);
    });
  });

  it("refuses to retry/replay a redacted delivery", async () => {
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      const id = insertDelivery(i, { ageDays: 31, status: "delivered" });
      await i.alarm();
      expect(i.getDelivery(id)?.payload).toBe(REDACTED_PAYLOAD);
      expect(i.retryDelivery(id)).toEqual({ ok: false, previousStatus: "delivered" });
      // Still not pending afterwards.
      expect(i.getDelivery(id)?.status).toBe("delivered");
    });
  });
});

describe("resolveRetentionDays", () => {
  it("defaults to 30 content / 90 delivery days", () => {
    expect(resolveRetentionDays({})).toEqual({ contentDays: 30, deliveryDays: 90 });
  });

  it("clamps the content window to [7, 90]", () => {
    expect(resolveRetentionDays({ CONTENT_RETENTION_DAYS: "3" }).contentDays).toBe(7);
    expect(resolveRetentionDays({ CONTENT_RETENTION_DAYS: "7" }).contentDays).toBe(7);
    expect(resolveRetentionDays({ CONTENT_RETENTION_DAYS: "45" }).contentDays).toBe(45);
    expect(resolveRetentionDays({ CONTENT_RETENTION_DAYS: "90" }).contentDays).toBe(90);
    expect(resolveRetentionDays({ CONTENT_RETENTION_DAYS: "365" }).contentDays).toBe(90);
  });

  it("falls back to the deprecated RETENTION_DAYS for the content window, clamped too", () => {
    expect(resolveRetentionDays({ RETENTION_DAYS: "14" }).contentDays).toBe(14);
    expect(resolveRetentionDays({ RETENTION_DAYS: "3" }).contentDays).toBe(7);
    expect(resolveRetentionDays({ RETENTION_DAYS: "365" }).contentDays).toBe(90);
    expect(resolveRetentionDays({ CONTENT_RETENTION_DAYS: "60", RETENTION_DAYS: "10" }).contentDays).toBe(60);
  });

  it("guards destructive windows against invalid values", () => {
    expect(resolveRetentionDays({ CONTENT_RETENTION_DAYS: "banana" }).contentDays).toBe(30);
    expect(resolveRetentionDays({ CONTENT_RETENTION_DAYS: "-5" }).contentDays).toBe(30);
    expect(resolveRetentionDays({ CONTENT_RETENTION_DAYS: "" }).contentDays).toBe(30);
    expect(resolveRetentionDays({ DELIVERY_RETENTION_DAYS: "0" }).deliveryDays).toBe(90);
    expect(resolveRetentionDays({ DELIVERY_RETENTION_DAYS: "abc" }).deliveryDays).toBe(90);
  });

  it("honors a custom delivery window", () => {
    expect(resolveRetentionDays({ DELIVERY_RETENTION_DAYS: "30" }).deliveryDays).toBe(30);
    expect(resolveRetentionDays({ DELIVERY_RETENTION_DAYS: "180" }).deliveryDays).toBe(180);
  });
});
