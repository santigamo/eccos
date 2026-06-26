import { DurableObject } from "cloudflare:workers";
import { signPayload } from "../src/core/signature";
import type { WhatsAppCallbackEvent } from "../src/core/types";

interface Env {
  SUBSCRIBER_WEBHOOK_URL?: string;
  SUBSCRIBER_SECRET?: string;
  FORWARD_MAX_ATTEMPTS: string;
}

interface DeliveryRow {
  id: number;
  payload: string;
  attempts: number;
  next_attempt_at: number;
}

const FORWARD_FETCH_TIMEOUT_MS = 15_000;
const ALARM_BATCH = 40;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class EccosGateway extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS inbound_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        type        TEXT NOT NULL,
        transport_message_id TEXT,
        message_id  TEXT,
        payload     TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );`);
      this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_status
        ON inbound_events (transport_message_id, type)
        WHERE transport_message_id IS NOT NULL;`);
      this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_message
        ON inbound_events (message_id)
        WHERE message_id IS NOT NULL;`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS outbound_messages (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        transport_message_id TEXT,
        recipient            TEXT NOT NULL,
        request              TEXT NOT NULL,
        status               TEXT NOT NULL,
        error                TEXT,
        created_at           INTEGER NOT NULL
      );`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS deliveries (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        payload         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        next_attempt_at INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
      );`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_deliveries_pending
        ON deliveries (status, next_attempt_at);`);
    });
  }

  ingest(events: WhatsAppCallbackEvent[]): { received: number } {
    if (events.length === 0) return { received: 0 };
    const now = Date.now();
    let inserted = 0;
    this.ctx.storage.transactionSync(() => {
      for (const ev of events) {
        const tmid = "transportMessageId" in ev ? ev.transportMessageId : null;
        const mid = "messageId" in ev ? ev.messageId : null;
        const insertedRows = this.sql
          .exec(
            `INSERT OR IGNORE INTO inbound_events
               (type, transport_message_id, message_id, payload, received_at)
             VALUES (?, ?, ?, ?, ?)
             RETURNING id`,
            ev.type,
            tmid,
            mid,
            JSON.stringify(ev),
            now,
          )
          .toArray();
        if (insertedRows.length > 0) inserted++;
      }
      if (inserted > 0) {
        this.sql.exec(
          `INSERT INTO deliveries (payload, status, attempts, next_attempt_at, created_at)
           VALUES (?, 'pending', 0, ?, ?)`,
          JSON.stringify({ events }),
          now,
          now,
        );
      }
    });
    if (inserted > 0) this.ctx.storage.setAlarm(now);
    return { received: events.length };
  }

  logOutbound(
    transportMessageId: string | null,
    recipient: string,
    requestJson: string,
    status: "sent" | "failed",
    errorJson: string | null,
  ): void {
    this.sql.exec(
      `INSERT INTO outbound_messages
         (transport_message_id, recipient, request, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      transportMessageId,
      recipient,
      requestJson,
      status,
      errorJson,
      Date.now(),
    );
  }

  saveConfig(entries: Record<string, string>): void {
    this.ctx.storage.transactionSync(() => {
      for (const [k, v] of Object.entries(entries)) {
        this.sql.exec(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`, k, v);
      }
    });
  }

  getConfigValue(key: string): string | null {
    const rows = this.sql.exec(`SELECT value FROM config WHERE key = ?`, key).toArray();
    const row = rows[0];
    return row ? (row.value as string) : null;
  }

  snapshot(): {
    outbound: unknown[];
    inbound: unknown[];
    deliveries: unknown[];
  } {
    return {
      outbound: this.sql
        .exec(
          `SELECT transport_message_id, recipient, status, error, created_at
         FROM outbound_messages ORDER BY id DESC LIMIT 50`,
        )
        .toArray(),
      inbound: this.sql
        .exec(
          `SELECT type, payload, received_at
         FROM inbound_events ORDER BY id DESC LIMIT 50`,
        )
        .toArray(),
      deliveries: this.sql
        .exec(
          `SELECT id, status, attempts, last_error, next_attempt_at, created_at
         FROM deliveries WHERE status IN ('pending','failed')
         ORDER BY id DESC LIMIT 50`,
        )
        .toArray(),
    };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const maxAttempts = Number(this.env.FORWARD_MAX_ATTEMPTS) || 6;

    const rows = this.sql
      .exec(
        `SELECT id, payload, attempts, next_attempt_at FROM deliveries
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY id LIMIT ?`,
        now,
        ALARM_BATCH,
      )
      .toArray() as unknown as DeliveryRow[];

    for (const row of rows) {
      let ok = false;
      let error: string | null = null;
      try {
        ok = await this.forwardOne(row.payload);
        if (!ok) error = "subscriber non-2xx or no URL";
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const attempts = row.attempts + 1;
      if (ok) {
        this.sql.exec(
          `UPDATE deliveries SET status='delivered', attempts=?, last_error=NULL WHERE id=?`,
          attempts,
          row.id,
        );
      } else if (attempts >= maxAttempts) {
        this.sql.exec(`UPDATE deliveries SET status='failed', attempts=?, last_error=? WHERE id=?`, attempts, error, row.id);
      } else {
        this.sql.exec(`UPDATE deliveries SET attempts=?, last_error=?, next_attempt_at=? WHERE id=?`, attempts, error, now + backoffMs(attempts), row.id);
      }
    }

    this.sql.exec(`DELETE FROM deliveries WHERE status IN ('delivered','failed') AND created_at < ?`, now - RETENTION_MS);
    this.sql.exec(`DELETE FROM inbound_events  WHERE received_at < ?`, now - RETENTION_MS);
    this.sql.exec(`DELETE FROM outbound_messages WHERE created_at < ?`, now - RETENTION_MS);

    const nextRows = this.sql
      .exec(`SELECT MIN(next_attempt_at) AS next FROM deliveries WHERE status='pending'`)
      .toArray();
    const nextRow = nextRows[0];
    const next = nextRow ? (nextRow.next as number | null) : null;
    if (next != null) this.ctx.storage.setAlarm(next);
  }

  private async forwardOne(payload: string): Promise<boolean> {
    const url = this.env.SUBSCRIBER_WEBHOOK_URL;
    if (!url) return false;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.env.SUBSCRIBER_SECRET) {
      headers["x-eccos-signature"] = await signPayload(payload, this.env.SUBSCRIBER_SECRET);
    }
    let firstType = "events";
    try {
      firstType = JSON.parse(payload).events?.[0]?.type ?? "events";
    } catch {
      /* noop */
    }
    headers["x-webhook-event"] = firstType;
    headers["x-idempotency-key"] = await sha256Hex(payload);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(FORWARD_FETCH_TIMEOUT_MS),
    });
    return res.ok;
  }
}

export function backoffMs(attempts: number): number {
  return Math.min(5_000 * 5 ** (attempts - 1), 3_600_000);
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
