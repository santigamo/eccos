import type { Database } from "bun:sqlite";
import type { Config } from "../config";
import { signPayload } from "../core/signature";
import type { WhatsAppCallbackEvent } from "../core/types";

interface DeliveryRow {
  id: number;
  payload: string;
  status: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: number;
  created_at: number;
}

function firstEventType(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { events?: Array<{ type?: string }> };
    return parsed.events?.[0]?.type ?? "events";
  } catch {
    return "events";
  }
}

export function enqueueDelivery(db: Database, events: WhatsAppCallbackEvent[]): void {
  if (events.length === 0) return;
  const payload = JSON.stringify({ events });
  const now = Date.now();
  db.query(
    `INSERT INTO deliveries (payload, status, attempts, next_attempt_at, created_at)
     VALUES (?, 'pending', 0, ?, ?)`,
  ).run(payload, now, now);
}

async function attemptDelivery(
  cfg: Config,
  row: DeliveryRow,
): Promise<{ ok: boolean; error?: string }> {
  if (!cfg.SUBSCRIBER_WEBHOOK_URL) {
    return { ok: false, error: "SUBSCRIBER_WEBHOOK_URL not configured" };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.SUBSCRIBER_SECRET) {
    headers["x-eccos-signature"] = await signPayload(row.payload, cfg.SUBSCRIBER_SECRET);
  }
  headers["x-webhook-event"] = firstEventType(row.payload);
  headers["x-idempotency-key"] = String(row.id);

  try {
    const res = await fetch(cfg.SUBSCRIBER_WEBHOOK_URL, {
      method: "POST",
      headers,
      body: row.payload,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function backoffMs(attempts: number): number {
  return Math.min(5_000 * 5 ** (attempts - 1), 3_600_000);
}

export async function processPending(db: Database, cfg: Config): Promise<void> {
  const now = Date.now();
  const rows = db
    .query(
      `SELECT * FROM deliveries
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY id LIMIT 50`,
    )
    .all(now) as DeliveryRow[];

  for (const row of rows) {
    const result = await attemptDelivery(cfg, row);
    const attempts = row.attempts + 1;

    if (result.ok) {
      db.query(`UPDATE deliveries SET status = 'delivered', attempts = ?, last_error = NULL WHERE id = ?`).run(
        attempts,
        row.id,
      );
    } else if (attempts >= cfg.FORWARD_MAX_ATTEMPTS) {
      db.query(`UPDATE deliveries SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`).run(
        attempts,
        result.error ?? null,
        row.id,
      );
    } else {
      db.query(
        `UPDATE deliveries SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`,
      ).run(attempts, result.error ?? null, now + backoffMs(attempts), row.id);
    }
  }
}

export function startDeliveryLoop(db: Database, cfg: Config): ReturnType<typeof setInterval> {
  return setInterval(() => {
    processPending(db, cfg).catch((error) => {
      console.error("[eccos] delivery loop error:", error);
    });
  }, 5_000);
}
