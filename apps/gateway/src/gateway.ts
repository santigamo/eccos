import { DurableObject } from "cloudflare:workers";
import { signPayload } from "@eccos/core/signature";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import type {
  DeliveryRecord,
  EraseByPhoneResult,
  ErasureCounts,
  InboundRow,
  OperatorCounts,
  OutboundRow,
  SetSubscriberConfigInput,
  SubscriberConfig,
} from "@eccos/gateway-contract";

interface Env {
  SUBSCRIBER_WEBHOOK_URL?: string;
  SUBSCRIBER_SECRET?: string;
  FORWARD_MAX_ATTEMPTS: string;
  /** Content retention window (days): past it, `inbound_events` and `outbound_messages`
   * rows are deleted and terminal `deliveries` rows keep only metadata (payload redacted).
   * Optional wrangler var; default 30, clamped to [7, 90]. */
  CONTENT_RETENTION_DAYS?: string;
  /** Delivery-audit retention window (days): past it, terminal `deliveries` rows are
   * deleted entirely. Optional wrangler var; default 90. */
  DELIVERY_RETENTION_DAYS?: string;
  /** @deprecated Legacy single retention window. Honored as a fallback for
   * `CONTENT_RETENTION_DAYS` when that var is unset, so existing deployments keep
   * their configured content window. Migrate to the split vars above. */
  RETENTION_DAYS?: string;
}

interface DeliveryRow {
  id: number;
  payload: string;
  attempts: number;
  next_attempt_at: number;
}

/** Result of one forward attempt. The failure branch carries why, so the reason
 * can be stored in `deliveries.last_error` and read back by an operator. */
type ForwardOutcome = { ok: true } | { ok: false; reason: string };

const FORWARD_FETCH_TIMEOUT_MS = 15_000;
const ALARM_BATCH = 40;
const DEFAULT_CONTENT_RETENTION_DAYS = 30;
const MIN_CONTENT_RETENTION_DAYS = 7;
const MAX_CONTENT_RETENTION_DAYS = 90;
const DEFAULT_DELIVERY_RETENTION_DAYS = 90;
const OPERATOR_MAX_PAGE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Retention only needs to run periodically, not on every alarm. alarm() fires
 * once per ingest, so sweeping there ran thousands of scans a day to delete the
 * same zero rows. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const LAST_SWEEP_KEY = "__last_sweep_at__";

/**
 * Sentinel written to `deliveries.payload` when message content is redacted
 * (content retention expiry, or GDPR erasure of a batch whose events were all
 * removed). The column stays `TEXT NOT NULL`; a real payload is always a
 * non-empty JSON object string, so the empty string is unambiguous.
 */
export const REDACTED_PAYLOAD = "";

/**
 * Split retention windows, resolved from env with destructive-operation guards:
 * a non-numeric or non-positive value falls back to the default instead of
 * feeding a DELETE window, and the content window is clamped to [7, 90] days.
 * The deprecated `RETENTION_DAYS` is honored as the content window when
 * `CONTENT_RETENTION_DAYS` is unset (backwards compatibility for existing
 * deployments), still subject to the same clamp.
 */
export function resolveRetentionDays(env: {
  CONTENT_RETENTION_DAYS?: string;
  DELIVERY_RETENTION_DAYS?: string;
  RETENTION_DAYS?: string;
}): { contentDays: number; deliveryDays: number } {
  const positive = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const contentRaw =
    positive(env.CONTENT_RETENTION_DAYS) ?? positive(env.RETENTION_DAYS) ?? DEFAULT_CONTENT_RETENTION_DAYS;
  const contentDays = Math.min(Math.max(contentRaw, MIN_CONTENT_RETENTION_DAYS), MAX_CONTENT_RETENTION_DAYS);
  const deliveryDays = Math.max(
    contentDays,
    positive(env.DELIVERY_RETENTION_DAYS) ?? DEFAULT_DELIVERY_RETENTION_DAYS,
  );
  return { contentDays, deliveryDays };
}

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
      // Retention sweeps filter on these timestamps. Without an index each sweep
      // is a full table scan, and Cloudflare bills rows *scanned* as rows read —
      // so an unindexed sweep turns into a cost that grows with stored history.
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_deliveries_created
        ON deliveries (created_at);`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_inbound_received
        ON inbound_events (received_at);`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_outbound_created
        ON outbound_messages (created_at);`);
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

  /** Operator-visible forwarding target: DO config first, env fallback. Never exposes the secret. */
  getSubscriberConfig(): SubscriberConfig {
    const url = this.getConfigValue("SUBSCRIBER_WEBHOOK_URL") ?? this.env.SUBSCRIBER_WEBHOOK_URL ?? null;
    const hasSecret = Boolean(this.getConfigValue("SUBSCRIBER_SECRET") ?? this.env.SUBSCRIBER_SECRET);
    return { url, hasSecret };
  }

  /** Rotate the forwarding target. Only overwrites the secret when a non-empty one is provided. */
  setSubscriberConfig(input: SetSubscriberConfigInput): void {
    this.saveConfig({ SUBSCRIBER_WEBHOOK_URL: input.url });
    if (typeof input.secret === "string" && input.secret.length > 0) {
      this.saveConfig({ SUBSCRIBER_SECRET: input.secret });
    }
  }

  // --- Operator API (read models + retry trigger; consumed via GatewayRPC) ---

  listInbound(opts: { limit?: number; before?: number } = {}): InboundRow[] {
    return this.sql
      .exec(
        `SELECT id, type, transport_message_id, message_id, payload, received_at
         FROM inbound_events WHERE id < ? ORDER BY id DESC LIMIT ?`,
        opts.before ?? Number.MAX_SAFE_INTEGER,
        clampPage(opts.limit),
      )
      .toArray() as unknown as InboundRow[];
  }

  listOutbound(opts: { limit?: number; before?: number } = {}): OutboundRow[] {
    return this.sql
      .exec(
        `SELECT id, transport_message_id, recipient, request, status, error, created_at
         FROM outbound_messages WHERE id < ? ORDER BY id DESC LIMIT ?`,
        opts.before ?? Number.MAX_SAFE_INTEGER,
        clampPage(opts.limit),
      )
      .toArray() as unknown as OutboundRow[];
  }

  listDeliveries(opts: { status?: string; limit?: number; before?: number } = {}): DeliveryRecord[] {
    const before = opts.before ?? Number.MAX_SAFE_INTEGER;
    const limit = clampPage(opts.limit);
    const cols = "id, status, attempts, last_error, next_attempt_at, created_at, payload";
    if (opts.status) {
      return this.sql
        .exec(
          `SELECT ${cols} FROM deliveries WHERE status = ? AND id < ? ORDER BY id DESC LIMIT ?`,
          opts.status,
          before,
          limit,
        )
        .toArray() as unknown as DeliveryRecord[];
    }
    return this.sql
      .exec(`SELECT ${cols} FROM deliveries WHERE id < ? ORDER BY id DESC LIMIT ?`, before, limit)
      .toArray() as unknown as DeliveryRecord[];
  }

  getDelivery(id: number): DeliveryRecord | null {
    const rows = this.sql
      .exec(
        `SELECT id, status, attempts, last_error, next_attempt_at, created_at, payload
         FROM deliveries WHERE id = ?`,
        id,
      )
      .toArray() as unknown as DeliveryRecord[];
    return rows[0] ?? null;
  }

  getAllConfig(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.sql.exec("SELECT key, value FROM config").toArray()) {
      out[row.key as string] = row.value as string;
    }
    return out;
  }

  getCounts(): OperatorCounts {
    const inboundRow = this.sql.exec("SELECT COUNT(*) AS c FROM inbound_events").toArray()[0];
    const byStatus = (table: "outbound_messages" | "deliveries"): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const row of this.sql.exec(`SELECT status, COUNT(*) AS c FROM ${table} GROUP BY status`).toArray()) {
        out[row.status as string] = Number(row.c);
      }
      return out;
    };
    return {
      inbound: Number(inboundRow?.c ?? 0),
      outbound: byStatus("outbound_messages"),
      deliveries: byStatus("deliveries"),
    };
  }

  /** Re-enqueue a delivery — retry a failed one or replay a delivered one.
   * Redacted rows (payload emptied by content retention or erasure) are metadata-only
   * and cannot be replayed. */
  retryDelivery(id: number): { ok: boolean; previousStatus: string | null } {
    const row = this.sql.exec("SELECT status, payload FROM deliveries WHERE id = ?", id).toArray()[0];
    if (!row) return { ok: false, previousStatus: null };
    if ((row.payload as string) === REDACTED_PAYLOAD) {
      return { ok: false, previousStatus: row.status as string };
    }
    const now = Date.now();
    this.sql.exec(
      "UPDATE deliveries SET status='pending', attempts=0, last_error=NULL, next_attempt_at=? WHERE id=?",
      now,
      id,
    );
    this.ctx.storage.setAlarm(now);
    return { ok: true, previousStatus: row.status as string };
  }

  /**
   * Right-to-erasure (GDPR Art. 17): removes every trace of a phone number from
   * the three data tables, within whatever is still inside the retention window.
   *
   * Matching strategy (`docs/privacy.md` §"Erasure"):
   *  - the input and every stored number are normalized to digits-only, then
   *    compared for exact equality — pass the full international number;
   *  - `outbound_messages` rows are matched on `recipient` and deleted; their
   *    `transport_message_id`s (wamids) are collected first;
   *  - `inbound_events` rows are matched on the normalized `from`/`to` inside the
   *    event JSON (reply/echo) and deleted; their `messageId`s join the wamid set,
   *    and status rows (`delivered`/`read`/`failed` — which carry only a wamid, no
   *    phone) are deleted via that set;
   *  - `deliveries` batches are rewritten without the matching events; a batch
   *    left empty is redacted in place when terminal (metadata survives as
   *    erasure/audit evidence) or deleted when still pending (nothing left to
   *    forward).
   *
   * Returns per-table counts so the operator can evidence the erasure.
   */
  eraseByPhone(phone: string): EraseByPhoneResult {
    const digits = normalizePhoneNumber(phone);
    if (!digits) {
      return { ok: false, error: "invalid phone number: expected at least 5 digits" };
    }
    const counts: ErasureCounts = {
      inboundEventsDeleted: 0,
      outboundMessagesDeleted: 0,
      deliveriesRedacted: 0,
      deliveriesDeleted: 0,
    };
    this.ctx.storage.transactionSync(() => {
      // 1. Outbound messages to that number: collect wamids, then delete the rows.
      //    `recipient` is caller-supplied and may be formatted ("+34 600-00-00-00"),
      //    so no SQL prefilter is safe here — every row is normalized in JS. Fine at
      //    single-tenant volumes bounded by the retention window.
      const wamids = new Set<string>();
      const outboundIds: number[] = [];
      for (const row of this.sql
        .exec(`SELECT id, recipient, transport_message_id FROM outbound_messages`)
        .toArray()) {
        if (normalizePhoneNumber(row.recipient as string) !== digits) continue;
        outboundIds.push(row.id as number);
        if (row.transport_message_id) wamids.add(row.transport_message_id as string);
      }

      // 2. Inbound events whose normalized event JSON references the number
      //    (`from` on replies, `to` on echoes). Meta always emits these digits-only,
      //    so LIKE on the contiguous digit run is a safe prefilter; the exact
      //    normalized comparison in JS then rules out substring false positives.
      //    Their message ids join the wamid set so related status events are
      //    erased too.
      const inboundIds = new Set<number>();
      for (const row of this.sql
        .exec(`SELECT id, payload FROM inbound_events WHERE payload LIKE ?`, `%${digits}%`)
        .toArray()) {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(row.payload as string) as Record<string, unknown>;
        } catch {
          continue;
        }
        const evPhone = typeof ev.from === "string" ? ev.from : typeof ev.to === "string" ? ev.to : null;
        if (evPhone === null || normalizePhoneNumber(evPhone) !== digits) continue;
        inboundIds.add(row.id as number);
        if (typeof ev.messageId === "string") wamids.add(ev.messageId);
      }
      for (const id of inboundIds) {
        this.sql.exec(`DELETE FROM inbound_events WHERE id = ?`, id);
        counts.inboundEventsDeleted++;
      }

      // 3. Status events (delivered/read/failed) carry only a wamid — link them
      //    through the wamids collected above.
      for (const wamid of wamids) {
        const deleted = this.sql
          .exec(`DELETE FROM inbound_events WHERE transport_message_id = ? OR message_id = ? RETURNING id`, wamid, wamid)
          .toArray();
        counts.inboundEventsDeleted += deleted.length;
      }

      for (const id of outboundIds) {
        this.sql.exec(`DELETE FROM outbound_messages WHERE id = ?`, id);
        counts.outboundMessagesDeleted++;
      }

      // 4. Delivery batches may mix events for several numbers: rewrite each
      //    affected batch keeping the unrelated events.
      for (const row of this.sql
        .exec(`SELECT id, status, payload FROM deliveries WHERE payload != ?`, REDACTED_PAYLOAD)
        .toArray()) {
        let batch: { events?: unknown };
        try {
          batch = JSON.parse(row.payload as string) as { events?: unknown };
        } catch {
          continue;
        }
        if (!Array.isArray(batch.events)) continue;
        const kept = batch.events.filter((ev) => !erasureTargetsEvent(ev, digits, wamids));
        if (kept.length === batch.events.length) continue;
        if (kept.length > 0) {
          this.sql.exec(
            `UPDATE deliveries SET payload = ? WHERE id = ?`,
            JSON.stringify({ ...batch, events: kept }),
            row.id,
          );
          counts.deliveriesRedacted++;
        } else if (row.status === "pending") {
          this.sql.exec(`DELETE FROM deliveries WHERE id = ?`, row.id);
          counts.deliveriesDeleted++;
        } else {
          this.sql.exec(`UPDATE deliveries SET payload = ? WHERE id = ?`, REDACTED_PAYLOAD, row.id);
          counts.deliveriesRedacted++;
        }
      }
    });
    return { ok: true, phone: digits, counts };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const maxAttempts = Number(this.env.FORWARD_MAX_ATTEMPTS) || 6;
    // Guarded + clamped (not just `||`) because misconfigured values here feed
    // destructive DELETE/UPDATE windows, unlike maxAttempts above.
    const { contentDays, deliveryDays } = resolveRetentionDays(this.env);

    // alarm() may fire more than once; the drain is idempotent because it only
    // processes status='pending' rows, transitions them by id, and forwardOne()
    // sends x-idempotency-key for subscriber-side dedupe.
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
        const outcome = await this.forwardOne(row.payload);
        ok = outcome.ok;
        if (!outcome.ok) error = outcome.reason;
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
        this.sql.exec(
          `UPDATE deliveries SET attempts=?, last_error=?, next_attempt_at=? WHERE id=?`,
          attempts,
          error,
          now + withJitter(backoffMs(attempts)),
          row.id,
        );
      }
    }

    // Split retention (docs/data-lifecycle.md):
    //  - content window: message content is removed everywhere — inbound/outbound
    //    rows are deleted and terminal deliveries keep only operational metadata
    //    (payload redacted in place; id/status/attempts/last_error/timestamps survive).
    //  - delivery window: the redacted audit rows themselves are deleted.
    // Rows still `pending` are never touched by age.
    const lastSweep = Number(this.getConfigValue(LAST_SWEEP_KEY) ?? 0);
    if (now - lastSweep >= SWEEP_INTERVAL_MS) {
      this.pruneExpired(now, contentDays, deliveryDays);
      this.saveConfig({ [LAST_SWEEP_KEY]: String(now) });
    }

    const nextRows = this.sql
      .exec(`SELECT MIN(next_attempt_at) AS next FROM deliveries WHERE status='pending'`)
      .toArray();
    const nextRow = nextRows[0];
    const next = nextRow ? (nextRow.next as number | null) : null;
    if (next != null) this.ctx.storage.setAlarm(next);
  }

  /** Applies both retention windows. Called at most once an hour from alarm();
   * exposed so tests can drive it directly instead of racing the throttle. */
  pruneExpired(now: number, contentDays: number, deliveryDays: number): void {
    const contentCutoff = now - contentDays * DAY_MS;
    const deliveryCutoff = now - deliveryDays * DAY_MS;
    this.sql.exec(
      `UPDATE deliveries SET payload = ? WHERE status IN ('delivered','failed') AND created_at < ? AND payload != ?`,
      REDACTED_PAYLOAD,
      contentCutoff,
      REDACTED_PAYLOAD,
    );
    this.sql.exec(`DELETE FROM inbound_events  WHERE received_at < ?`, contentCutoff);
    this.sql.exec(`DELETE FROM outbound_messages WHERE created_at < ?`, contentCutoff);
    this.sql.exec(`DELETE FROM deliveries WHERE status IN ('delivered','failed') AND created_at < ?`, deliveryCutoff);
  }

  /**
   * Forwards one delivery. Returns the reason on failure rather than a bare
   * boolean: "no subscriber URL configured" and "subscriber returned 502" are
   * opposite diagnoses (missing config vs a destination that rejects), and
   * collapsing them into one string means the delivery queue cannot tell an
   * operator which one happened.
   */
  private async forwardOne(payload: string): Promise<ForwardOutcome> {
    const url = this.getConfigValue("SUBSCRIBER_WEBHOOK_URL") ?? this.env.SUBSCRIBER_WEBHOOK_URL;
    const secret = this.getConfigValue("SUBSCRIBER_SECRET") ?? this.env.SUBSCRIBER_SECRET;
    if (!url) return { ok: false, reason: "no subscriber URL configured" };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret) {
      headers["x-eccos-signature"] = await signPayload(payload, secret);
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
    return res.ok ? { ok: true } : { ok: false, reason: `subscriber returned ${res.status}` };
  }
}

export function backoffMs(attempts: number): number {
  return Math.min(5_000 * 5 ** (attempts - 1), 3_600_000);
}

/**
 * Applies bounded ("equal") jitter of +/-10% to a backoff duration so that many
 * deliveries that fail around the same time don't all retry at the exact same
 * instant (thundering herd). `backoffMs` itself stays deterministic (it's asserted
 * with exact values in tests); only the scheduled `next_attempt_at` gets jittered.
 */
export function withJitter(ms: number, random: () => number = Math.random): number {
  const spread = ms * 0.1;
  return Math.round(ms - spread + random() * spread * 2);
}

/**
 * Normalizes a phone number for erasure matching: strips every non-digit
 * character (`+34 600-00-00-00` → `34600000000`). Returns null when fewer than
   * 5 digits remain (same minimum as the send API).
 */
export function normalizePhoneNumber(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  return digits.length >= 5 ? digits : null;
}

/** True when a normalized event in a delivery batch belongs to the erased number,
 * either directly (`from`/`to`) or through a collected message id (statuses). */
function erasureTargetsEvent(ev: unknown, digits: string, wamids: Set<string>): boolean {
  if (!ev || typeof ev !== "object") return false;
  const e = ev as Record<string, unknown>;
  for (const key of ["from", "to"] as const) {
    if (typeof e[key] === "string" && normalizePhoneNumber(e[key] as string) === digits) return true;
  }
  for (const key of ["transportMessageId", "messageId"] as const) {
    if (typeof e[key] === "string" && wamids.has(e[key] as string)) return true;
  }
  return false;
}

function clampPage(limit?: number): number {
  const v = Math.floor(Number(limit));
  if (!Number.isFinite(v) || v <= 0) return 50;
  return Math.min(v, OPERATOR_MAX_PAGE);
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
