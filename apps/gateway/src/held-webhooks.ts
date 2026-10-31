import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import type { HeldWebhookRow } from "@eccos/gateway-contract";
import { getGatewayStubForWaba } from "./gateway-stub";

/**
 * Webhook batches of a registered WABA that is still `pending` (first provisioning or a
 * re-run Embedded Signup). Meta does not resend a webhook answered 200, so they wait here
 * until the WABA is active again, bounded by event count and age.
 */
export const HELD_MAX_EVENTS = 5000;
export const HELD_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export const HELD_WEBHOOKS_TABLE = `CREATE TABLE IF NOT EXISTS held_webhooks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number_id TEXT,
  events          TEXT NOT NULL,
  event_count     INTEGER NOT NULL,
  held_at         INTEGER NOT NULL
);`;

export interface HeldBatch {
  id: number;
  phoneNumberId: string | null;
  events: WhatsAppCallbackEvent[];
}

export function heldEventCount(sql: SqlStorage): number {
  return Number(sql.exec("SELECT COALESCE(SUM(event_count), 0) AS n FROM held_webhooks").one().n);
}

/** Stores the batch unless it would push the hold past HELD_MAX_EVENTS. */
export function holdBatch(
  sql: SqlStorage,
  phoneNumberId: string | null,
  events: WhatsAppCallbackEvent[],
  now: number,
): { held: boolean; heldEvents: number } {
  const heldEvents = heldEventCount(sql);
  if (heldEvents + events.length > HELD_MAX_EVENTS) return { held: false, heldEvents };
  sql.exec(
    "INSERT INTO held_webhooks (phone_number_id, events, event_count, held_at) VALUES (?, ?, ?, ?)",
    phoneNumberId,
    JSON.stringify(events),
    events.length,
    now,
  );
  return { held: true, heldEvents: heldEvents + events.length };
}

export function heldBatches(sql: SqlStorage): HeldBatch[] {
  return sql
    .exec("SELECT id, phone_number_id, events FROM held_webhooks ORDER BY id")
    .toArray()
    .map((row) => ({
      id: Number(row.id),
      phoneNumberId: (row.phone_number_id as string | null) ?? null,
      events: JSON.parse(row.events as string) as WhatsAppCallbackEvent[],
    }));
}

export function heldRows(sql: SqlStorage): HeldWebhookRow[] {
  return sql
    .exec("SELECT id, phone_number_id, events, event_count, held_at FROM held_webhooks ORDER BY id")
    .toArray() as unknown as HeldWebhookRow[];
}

export function hasHeld(sql: SqlStorage): boolean {
  return sql.exec("SELECT 1 FROM held_webhooks LIMIT 1").toArray().length > 0;
}

/** Deletes batches older than HELD_MAX_AGE_MS; returns how many events were dropped. */
export function expireHeld(sql: SqlStorage, now: number): number {
  const rows = sql
    .exec("DELETE FROM held_webhooks WHERE held_at < ? RETURNING event_count", now - HELD_MAX_AGE_MS)
    .toArray();
  return rows.reduce((sum, row) => sum + Number(row.event_count), 0);
}

/** Rewrites a held batch with the events kept, deleting it when none are. */
export function replaceHeld(sql: SqlStorage, id: number, events: WhatsAppCallbackEvent[]): void {
  if (events.length === 0) sql.exec("DELETE FROM held_webhooks WHERE id = ?", id);
  else sql.exec("UPDATE held_webhooks SET events = ?, event_count = ? WHERE id = ?", JSON.stringify(events), events.length, id);
}

/** Releases the WABA's held batches. A failure leaves them held, for the next webhook's
 * ingest (`heldPending`) to retry, or for the sweep to expire. */
export async function releaseHeldBatches(env: Env, wabaId: string, phoneNumberIds: string[]): Promise<void> {
  try {
    await getGatewayStubForWaba(env, wabaId).releaseHeld(phoneNumberIds);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        area: "ingest",
        event: "held_release_failed",
        wabaId,
        errorType: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
}
