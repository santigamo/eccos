import { DurableObject } from "cloudflare:workers";
import { signPayload } from "@eccos/core/signature";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import type {
  DeliveryRecord,
  EraseByPhoneResult,
  ErasureCounts,
  GatewayExport,
  InboundRow,
  OperatorCounts,
  OutboundRow,
  SetSubscriberConfigInput,
  SubscriberConfig,
} from "@eccos/gateway-contract";
import { isPublicConfigKey } from "./private-config-keys";

interface Env {
  FORWARD_MAX_ATTEMPTS: string;
  /** Content retention window (days): past it, `inbound_events` and `outbound_messages`
   * rows are deleted, terminal `deliveries` rows keep only metadata (payload redacted),
   * and `pending` `deliveries` rows — including events held for want of a forwarding
   * target — are deleted outright.
   * Optional wrangler var; default 30, clamped to [7, 90]. */
  CONTENT_RETENTION_DAYS?: string;
  /** Delivery-audit retention window (days): past it, terminal `deliveries` rows are
   * deleted entirely. Optional wrangler var; default 90. */
  DELIVERY_RETENTION_DAYS?: string;
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

const FORWARD_FETCH_TIMEOUT_MS = 5_000;
const ALARM_BATCH = 40;
const ALARM_MAX_CONCURRENCY = 6;
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

function parseIpv4Address(hostname: string): number[] | null {
  const octets = hostname.split(".");
  if (octets.length !== 4 || !octets.every((part) => /^\d+$/.test(part))) return null;
  const parsed = octets.map(Number);
  return parsed.every((part) => part >= 0 && part <= 255) ? parsed : null;
}

function parseIpv6Address(hostname: string): number[] | null {
  if (!hostname.includes(":")) return null;
  let value = hostname;
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    if (separator < 0) return null;
    const ipv4 = parseIpv4Address(value.slice(separator + 1));
    if (!ipv4) return null;
    const a = ipv4[0];
    const b = ipv4[1];
    const c = ipv4[2];
    const d = ipv4[3];
    if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
    const high = (a << 8) | b;
    const low = (c << 8) | d;
    value = `${value.slice(0, separator + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const sections = value.split("::");
  if (sections.length > 2) return null;
  const parseSection = (section: string): number[] | null => {
    if (!section) return [];
    const parts = section.split(":");
    if (!parts.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  };
  const left = parseSection(sections[0] ?? "");
  const right = parseSection(sections.length === 2 ? sections[1] ?? "" : "");
  if (!left || !right) return null;
  if (sections.length === 1) return left.length === 8 ? left : null;
  if (left.length + right.length >= 8) return null;
  return [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right];
}

function isPrivateIpv4Address(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === undefined || b === undefined) return false;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && b >= 18 && b <= 19) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateSubscriberHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "local" ||
    hostname.endsWith(".local")
  ) {
    return true;
  }

  if (/^\d+$/.test(hostname.replaceAll(".", ""))) return true;

  const ipv4 = parseIpv4Address(hostname);
  if (ipv4) return isPrivateIpv4Address(ipv4);

  const ipv6 = parseIpv6Address(hostname);
  if (!ipv6) return false;
  const first = ipv6[0] ?? 0;
  const high = ipv6[6] ?? 0;
  const low = ipv6[7] ?? 0;
  const embeddedIpv4 = [high >> 8, high & 0xff, low >> 8, low & 0xff];
  const isMapped = ipv6.slice(0, 5).every((part) => part === 0) && ipv6[5] === 0xffff;
  const isIpv4Compatible = ipv6.slice(0, 6).every((part) => part === 0);
  return (
    (isMapped || isIpv4Compatible) && isPrivateIpv4Address(embeddedIpv4)
  ) || (
    ipv6.every((part) => part === 0) ||
    (ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00
  );
}

export function validateSubscriberUrl(rawUrl: string): string {
  const value = rawUrl.trim();
  if (!value) throw new Error("invalid subscriber URL: must not be empty");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid subscriber URL: must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("invalid subscriber URL: must use https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("invalid subscriber URL: credentials are not allowed");
  }
  if (isPrivateSubscriberHostname(parsed.hostname)) {
    throw new Error("invalid subscriber URL: private hosts are not allowed");
  }
  return value;
}

/**
 * Config-table keys that are secrets/raw credentials and must never leave the
 * DO — filtered out of `exportData()` (and mirrored by the RPC layer's own
 * filter). Anything else in the `config` table is considered safe connection
 * metadata (WABA/phone ids, callback URL, display phone, connected-at).
 */
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
 */
export function resolveRetentionDays(env: {
  CONTENT_RETENTION_DAYS?: string;
  DELIVERY_RETENTION_DAYS?: string;
}): { contentDays: number; deliveryDays: number } {
  const positive = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const contentRaw = positive(env.CONTENT_RETENTION_DAYS) ?? DEFAULT_CONTENT_RETENTION_DAYS;
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
        phone_number_id TEXT,
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
        phone_number_id      TEXT,
        request              TEXT NOT NULL,
        status               TEXT NOT NULL,
        error                TEXT,
        created_at           INTEGER NOT NULL
      );`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS deliveries (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number_id TEXT,
        payload         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        next_attempt_at INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        finished_at     INTEGER
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
      // Additive migration for objects created before a column existed. `type`
      // matters: SQLite applies column affinity on write, so an epoch-ms
      // timestamp landing in a TEXT column would come back out as a string and
      // every reader would have to guess. Timestamps declare INTEGER.
      const ensureColumn = (table: string, column: string, type = "TEXT"): void => {
        const columns = this.sql.exec(`PRAGMA table_info(${table})`).toArray();
        if (!columns.some((row) => row.name === column)) {
          this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        }
      };
      ensureColumn("inbound_events", "phone_number_id");
      ensureColumn("outbound_messages", "phone_number_id");
      ensureColumn("deliveries", "phone_number_id");
      // When a delivery reached its terminal state (`delivered` or `failed`).
      // `created_at` alone can only say when the batch was ENQUEUED, so "last
      // delivery 15 days ago" was, until now, a sentence the gateway could not
      // honestly say — least of all about a row that spent five retries getting
      // there. Rows that predate this column stay NULL and MUST be read as "not
      // finished", never backfilled from `created_at`: that would invent a
      // completion moment out of an arrival moment, which is the exact lie the
      // column exists to stop. NULL is also the live meaning — queued, held for
      // want of a forwarding target, or waiting between retries.
      ensureColumn("deliveries", "finished_at", "INTEGER");
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
        const phoneNumberId = ev.phoneNumberId?.trim() || null;
        const insertedRows = this.sql
          .exec(
            `INSERT OR IGNORE INTO inbound_events
               (type, transport_message_id, message_id, phone_number_id, payload, received_at)
             VALUES (?, ?, ?, ?, ?, ?)
             RETURNING id`,
            ev.type,
            tmid,
            mid,
            phoneNumberId,
            JSON.stringify(ev),
            now,
          )
          .toArray();
        if (insertedRows.length > 0) inserted++;
      }
      if (inserted > 0) {
        const phoneIds = new Set(events.map((event) => event.phoneNumberId?.trim() || null));
        const phoneNumberId = phoneIds.size === 1 ? [...phoneIds][0] ?? null : null;
        this.sql.exec(
          `INSERT INTO deliveries (phone_number_id, payload, status, attempts, next_attempt_at, created_at)
           VALUES (?, ?, 'pending', 0, ?, ?)`,
          phoneNumberId,
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
    phoneNumberId?: string | null,
  ): void {
    this.sql.exec(
      `INSERT INTO outbound_messages
         (transport_message_id, recipient, phone_number_id, request, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      transportMessageId,
      recipient,
      phoneNumberId?.trim() || null,
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

  /** Operator-visible forwarding target: DO config only (per-WABA runtime state).
   * Never exposes the secret — `hasSecret` is the only trace it leaves. */
  getSubscriberConfig(): SubscriberConfig {
    const url = this.getConfigValue("SUBSCRIBER_WEBHOOK_URL") ?? null;
    const hasSecret = Boolean(this.getConfigValue("SUBSCRIBER_SECRET"));
    return { url, hasSecret, lastForward: this.lastForward() };
  }

  /**
   * The newest delivery row, which is the whole answer to "is my receiver
   * getting events?". It rides `getSubscriberConfig` instead of owning an RPC
   * method: `id` is the INTEGER PRIMARY KEY, so `ORDER BY id DESC LIMIT 1` is a
   * one-row seek down the rowid index, and paying a second round-trip over the
   * service binding for it would cost far more than the query does.
   */
  private lastForward(): SubscriberConfig["lastForward"] {
    const row = this.sql
      .exec(
        `SELECT status, attempts, last_error, created_at, finished_at
         FROM deliveries ORDER BY id DESC LIMIT 1`,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      status: row.status as string,
      attempts: Number(row.attempts ?? 0),
      createdAt: Number(row.created_at),
      // NULL stays null: see the `finished_at` migration comment — an unfinished
      // row must never borrow `created_at` as its completion moment.
      finishedAt: row.finished_at == null ? null : Number(row.finished_at),
      lastError: (row.last_error as string | null) ?? null,
    };
  }

  /**
   * Write the forwarding target. Each field says one thing and only one thing
   * (see `SetSubscriberConfigInput`): a `null` `url` REMOVES the target, a
   * `null` `secret` REMOVES the secret, an absent `secret` keeps the stored one.
   * An empty-string secret is refused rather than quietly read as "keep" —
   * clearing has its own spelling now, so the ambiguity has no reason to exist.
   */
  setSubscriberConfig(input: SetSubscriberConfigInput): void {
    const url = input.url === null ? null : validateSubscriberUrl(input.url);
    const secret = input.secret;
    if (typeof secret === "string" && secret.trim() === "") {
      throw new Error("invalid subscriber secret: pass null to clear it, never an empty string");
    }
    this.ctx.storage.transactionSync(() => {
      const put = (key: string, value: string): void => {
        this.sql.exec(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`, key, value);
      };
      const drop = (key: string): void => {
        this.sql.exec(`DELETE FROM config WHERE key = ?`, key);
      };
      if (url === null) drop("SUBSCRIBER_WEBHOOK_URL");
      else put("SUBSCRIBER_WEBHOOK_URL", url);
      if (secret === null) drop("SUBSCRIBER_SECRET");
      else if (secret !== undefined) put("SUBSCRIBER_SECRET", secret);
    });
    // A target now exists, so release whatever the drain was holding for want of
    // one (see `alarm()`). Without this the backlog would sit until the next
    // ingest happened to set an alarm, i.e. until the next inbound message.
    if (url !== null) this.ctx.storage.setAlarm(Date.now());
  }

  // --- Operator API (read models + retry trigger; consumed via GatewayRPC) ---

  listInbound(opts: { limit?: number; before?: number } = {}): InboundRow[] {
    return this.sql
      .exec(
        `SELECT id, type, transport_message_id, message_id, phone_number_id, payload, received_at
         FROM inbound_events WHERE id < ? ORDER BY id DESC LIMIT ?`,
        opts.before ?? Number.MAX_SAFE_INTEGER,
        clampPage(opts.limit),
      )
      .toArray() as unknown as InboundRow[];
  }

  listOutbound(opts: { limit?: number; before?: number } = {}): OutboundRow[] {
    return this.sql
      .exec(
        `SELECT id, transport_message_id, recipient, phone_number_id, request, status, error, created_at
         FROM outbound_messages WHERE id < ? ORDER BY id DESC LIMIT ?`,
        opts.before ?? Number.MAX_SAFE_INTEGER,
        clampPage(opts.limit),
      )
      .toArray() as unknown as OutboundRow[];
  }

  listDeliveries(opts: { status?: string; limit?: number; before?: number } = {}): DeliveryRecord[] {
    const before = opts.before ?? Number.MAX_SAFE_INTEGER;
    const limit = clampPage(opts.limit);
    const cols = "id, phone_number_id, status, attempts, last_error, next_attempt_at, created_at, finished_at, payload";
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

  private listAllInbound(): InboundRow[] {
    return this.sql
      .exec(
        `SELECT id, type, transport_message_id, message_id, phone_number_id, payload, received_at
         FROM inbound_events ORDER BY id DESC`,
      )
      .toArray() as unknown as InboundRow[];
  }

  private listAllOutbound(): OutboundRow[] {
    return this.sql
      .exec(
        `SELECT id, transport_message_id, recipient, phone_number_id, request, status, error, created_at
         FROM outbound_messages ORDER BY id DESC`,
      )
      .toArray() as unknown as OutboundRow[];
  }

  private listAllDeliveries(): DeliveryRecord[] {
    return this.sql
      .exec(
        `SELECT id, phone_number_id, status, attempts, last_error, next_attempt_at, created_at, finished_at, payload
         FROM deliveries ORDER BY id DESC`,
      )
      .toArray() as unknown as DeliveryRecord[];
  }

  getDelivery(id: number): DeliveryRecord | null {
    const rows = this.sql
      .exec(
        `SELECT id, phone_number_id, status, attempts, last_error, next_attempt_at, created_at, finished_at, payload
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

  /**
   * Tenant-scoped data-plane export: every stored inbound event, outbound
   * message, and delivery (existing row shapes, newest first), plus the
    * non-secret connection metadata/config (secrets and internal keys are
    * filtered — see isPublicConfigKey). Deterministic and JSON-serializable:
   * fixed key order, tables ordered inbound → outbound → deliveries → config,
   * rows ordered by id within each table, and no runtime values (timestamps,
   * ids) beyond what is already stored. Single snapshot: no limit/pagination —
   * a tenants' full retained history at single-tenant v1 volumes.
   */
  exportData(): GatewayExport {
    return {
      inbound: this.listAllInbound(),
      outbound: this.listAllOutbound(),
      deliveries: this.listAllDeliveries(),
      config: Object.fromEntries(
        Object.entries(this.getAllConfig()).filter(([key]) => isPublicConfigKey(key)),
      ),
    };
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
    // `finished_at` goes back to NULL with the rest of the terminal state: the
    // row is queued again, and a pending row that claims a completion moment
    // would be lying to every reader of that column.
    this.sql.exec(
      "UPDATE deliveries SET status='pending', attempts=0, last_error=NULL, finished_at=NULL, next_attempt_at=? WHERE id=?",
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
          const keptPhoneIds = new Set(
            kept.flatMap((event) => {
              if (!event || typeof event !== "object") return [];
              const phoneNumberId = (event as Record<string, unknown>).phoneNumberId;
              return typeof phoneNumberId === "string" && phoneNumberId.trim() !== "" ? [phoneNumberId] : [];
            }),
          );
          const phoneNumberId = keptPhoneIds.size === 1 ? [...keptPhoneIds][0] ?? null : null;
          this.sql.exec(
            `UPDATE deliveries SET phone_number_id = ?, payload = ? WHERE id = ?`,
            phoneNumberId,
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

    /**
     * The drain is HELD while no forwarding target is configured.
     *
     * `pending` covers two situations and only one of them is a fault: "the
     * subscriber has not answered yet" and "there is no subscriber". Draining
     * the second spends the row's six attempts against a destination that does
     * not exist, writes "no subscriber URL configured" into `last_error` each
     * time, and parks it in `failed` — which `healthFromCounts` (rpc.ts) reads
     * as `unhealthy`. A customer who received one event before configuring a
     * target therefore saw a permanently red gateway for having done nothing
     * wrong, and the console could not honestly call that setup step skippable.
     *
     * Held means held: no attempt, no `attempts++`, no `last_error`, and no
     * delivery reschedule below — the rows are already due, so rescheduling
     * against `next_attempt_at` would spin the alarm against itself. What the
     * held branch DOES re-arm is the slow retention tick; see it below.
     * `setSubscriberConfig` sets the alarm that releases the backlog the moment
     * a target exists.
     *
     * Held is not forever. A held row is still content, so it ages out with
     * `CONTENT_RETENTION_DAYS` like everything else (`pruneExpired` deletes it,
     * and says there why deletion rather than redaction). The hold buys an
     * operator the retention window to name a receiver — not an unbounded
     * archive that would quietly outlive the privacy promise in docs/privacy.md.
     *
     * The wait stays visible. Past ten held rows `healthFromCounts` reads
     * `degraded`, which is the honest word for it: events are queued for a
     * destination the operator has not named yet — the gateway is neither
     * broken nor fine, and nothing is being spent. That is not special-cased.
     *
     * Nothing else is held. A configured target that refuses keeps failing,
     * keeps incrementing, and keeps turning the gateway `unhealthy`, because
     * that is a real fault and blunting it would be worse than the bug this
     * fixes.
     */
    const hasTarget = Boolean(this.getConfigValue("SUBSCRIBER_WEBHOOK_URL"));

    // alarm() may fire more than once; the drain is idempotent because it only
    // processes status='pending' rows, transitions them by id, and forwardOne()
    // sends x-idempotency-key for subscriber-side dedupe.
    const rows = hasTarget
      ? (this.sql
          .exec(
            `SELECT id, payload, attempts, next_attempt_at FROM deliveries
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY id LIMIT ?`,
            now,
            ALARM_BATCH,
          )
          .toArray() as unknown as DeliveryRow[])
      : [];

    let workerError: unknown;
    let hasWorkerError = false;
    try {
      await runBoundedPool(rows, ALARM_MAX_CONCURRENCY, (row) =>
        this.processDelivery(row, maxAttempts),
      );
    } catch (error) {
      workerError = error;
      hasWorkerError = true;
    }

    // Split retention (docs/data-lifecycle.md):
    //  - content window: message content is removed everywhere — inbound/outbound
    //    rows are deleted, terminal deliveries keep only operational metadata
    //    (payload redacted in place; id/status/attempts/last_error/timestamps survive),
    //    and rows still `pending` are deleted outright (see pruneExpired).
    //  - delivery window: the redacted audit rows themselves are deleted.
    let nextSweepAt = Number(this.getConfigValue(LAST_SWEEP_KEY) ?? 0) + SWEEP_INTERVAL_MS;
    if (now >= nextSweepAt) {
      this.pruneExpired(now, contentDays, deliveryDays);
      this.saveConfig({ [LAST_SWEEP_KEY]: String(now) });
      nextSweepAt = now + SWEEP_INTERVAL_MS;
    }

    // Only reschedule against `next_attempt_at` when there is somewhere to send.
    // Held rows are due now, so an unconditional reschedule would set an alarm
    // in the past and re-enter this method forever without ever forwarding.
    if (hasTarget) {
      const nextRows = this.sql
        .exec(`SELECT MIN(next_attempt_at) AS next FROM deliveries WHERE status='pending'`)
        .toArray();
      const nextRow = nextRows[0];
      const next = nextRow ? (nextRow.next as number | null) : null;
      if (next != null) this.ctx.storage.setAlarm(next);
    } else if (this.hasPendingDeliveries()) {
      /**
       * Held, but not forgotten: a slow tick so RETENTION still runs.
       *
       * The sweep above only happens when an alarm fires, and on a target-less
       * WABA the only thing that fires an alarm is a fresh ingest. A customer
       * who received a burst of events and then went quiet before naming a
       * receiver would keep those held payloads — message bodies and contact
       * phone numbers — past the content window for as long as nobody messaged
       * them again. That is the same leak `pruneExpired` closes, arriving by a
       * different door, and it is why this branch exists at all.
       *
       * One alarm per sweep interval, and ONLY while something is actually
       * held. Re-arming with an empty queue would keep an idle Durable Object
       * waking up forever for nothing; re-arming at `next_attempt_at` would set
       * an alarm in the past and spin. `nextSweepAt` is always in the future
       * here — either the sweep just ran (now + interval) or it was skipped
       * because its due time has not arrived.
       */
      this.ctx.storage.setAlarm(nextSweepAt);
    }
    if (hasWorkerError) throw workerError;
  }

  /** Cheap existence check — `LIMIT 1`, not a COUNT: the hold only needs to know
   * whether anything is waiting, and a target-less WABA can hold a lot of rows. */
  private hasPendingDeliveries(): boolean {
    return this.sql.exec(`SELECT 1 FROM deliveries WHERE status='pending' LIMIT 1`).toArray().length > 0;
  }

  /** Applies both retention windows — content (delete/redact by kind of row) and
   * delivery-audit. Called at most once an hour from alarm(); exposed so tests
   * can drive it directly instead of racing the throttle. */
  pruneExpired(now: number, contentDays: number, deliveryDays: number): void {
    const contentCutoff = now - contentDays * DAY_MS;
    const deliveryCutoff = now - deliveryDays * DAY_MS;
    this.sql.exec(
      `UPDATE deliveries SET payload = ? WHERE status IN ('delivered','failed') AND created_at < ? AND payload != ?`,
      REDACTED_PAYLOAD,
      contentCutoff,
      REDACTED_PAYLOAD,
    );
    // A `pending` row past the content window is DELETED, not redacted.
    //
    // Redaction is right for a terminal row: the forward already happened, so
    // what survives is audit evidence about a delivery that took place. A
    // pending row has not been forwarded yet, and the drain does not consult
    // retention — so a redacted pending row would still go out the moment a
    // target is configured, and would arrive at the subscriber as a batch with
    // an empty body. The receiver cannot tell that from a real event, so it
    // would be worse than never sending it: the content is gone either way, and
    // one of the two options also injects a lie into the customer's system.
    //
    // This rule is new because `pending` is new as a long-lived state. Before
    // alarm() started HOLDING the drain while no forwarding target exists,
    // every row reached `delivered` or `failed` within about an hour, so
    // "pending rows are never touched by age" cost nothing. With the hold, a
    // target-less WABA would otherwise keep full event payloads — message
    // bodies and contact phone numbers — indefinitely, breaking the retention
    // promise in docs/privacy.md for exactly the customer the hold was built
    // for. The window is the CONTENT window, deliberately: this is a content
    // deletion, not an audit-trail expiry.
    this.sql.exec(`DELETE FROM deliveries WHERE status = 'pending' AND created_at < ?`, contentCutoff);
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
   *
   * The missing-URL branch is now a narrow race guard rather than the ordinary
   * unconfigured path: `alarm()` holds the drain when no target is set, so this
   * can only be reached if the target is removed between that check and this
   * fetch. It stays because the row must still say why it did not go out.
   */
  private async forwardOne(payload: string): Promise<ForwardOutcome> {
    const rawUrl = this.getConfigValue("SUBSCRIBER_WEBHOOK_URL");
    const secret = this.getConfigValue("SUBSCRIBER_SECRET");
    if (!rawUrl) return { ok: false, reason: "no subscriber URL configured" };
    let url: string;
    try {
      url = validateSubscriberUrl(rawUrl);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
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
      redirect: "error",
      signal: AbortSignal.timeout(FORWARD_FETCH_TIMEOUT_MS),
    });
    const ok = res.ok;
    if (res.body) await res.body.cancel().catch(() => undefined);
    return ok ? { ok: true } : { ok: false, reason: `subscriber returned ${res.status}` };
  }

  private async processDelivery(row: DeliveryRow, maxAttempts: number): Promise<void> {
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
    // `finished_at` is written on BOTH terminal transitions and on neither retry:
    // a row that is going to be tried again has not finished, and stamping it
    // would make "last delivery" mean "last attempt".
    if (ok) {
      this.sql.exec(
        `UPDATE deliveries SET status='delivered', attempts=?, last_error=NULL, finished_at=? WHERE id=?`,
        attempts,
        Date.now(),
        row.id,
      );
    } else if (attempts >= maxAttempts) {
      this.sql.exec(
        `UPDATE deliveries SET status='failed', attempts=?, last_error=?, finished_at=? WHERE id=?`,
        attempts,
        error,
        Date.now(),
        row.id,
      );
    } else {
      this.sql.exec(
        `UPDATE deliveries SET attempts=?, last_error=?, next_attempt_at=? WHERE id=?`,
        attempts,
        error,
        Date.now() + withJitter(backoffMs(attempts)),
        row.id,
      );
    }
  }
}

export function backoffMs(attempts: number): number {
  return Math.min(5_000 * 5 ** (attempts - 1), 3_600_000);
}

export async function runBoundedPool<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const errors: unknown[] = [];
  const queue = items.map((item) => ({ item }));
  const worker = async (): Promise<void> => {
    while (true) {
      const next = queue.shift();
      if (!next) return;
      try {
        await work(next.item);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(Math.max(0, Math.floor(concurrency)), items.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  const workerResults = await Promise.allSettled(workers);
  const workerFailure = workerResults.find((result) => result.status === "rejected");
  if (workerFailure?.status === "rejected") throw workerFailure.reason;
  if (errors.length > 0) throw errors[0];
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
