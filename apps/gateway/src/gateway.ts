import { DurableObject } from "cloudflare:workers";
import { signPayload } from "@eccos/core/signature";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import type {
  ContactRecord,
  ConversationSummary,
  CursorPage,
  DeliveryRecord,
  EraseByPhoneResult,
  ErasureCounts,
  GatewayExport,
  InboundRow,
  MessageDirection,
  MessageOrigin,
  MessageRecord,
  MessageStatus,
  OperatorCounts,
  OutboundRow,
  OutboundTrailEvent,
  SetSubscriberConfigInput,
  SubscriberConfig,
  ThreadView,
} from "@eccos/gateway-contract";
import {
  type NewMessage,
  type Position,
  decodeCursor,
  encodeCursor,
  messageFromEvent,
  messageFromOutbound,
  statusFromEvent,
  waIdOf,
} from "./conversations";
import type { EccosControlPlane } from "./control-plane";
import { getControlPlaneStub } from "./control-plane-stub";
import { type HistoryMessage, type SyncItem, mapSyncItem, syncItems } from "./history";
import {
  downloadMetaMedia,
  isChecksumMismatch,
  MediaPermanentError,
  MediaTokenError,
} from "./media-download";
import { deleteMediaObjects } from "./media-store";
import { SMB_APP_DATA_HISTORY_SHARING_OFF_CODE } from "./meta/smb-app-data";
import { type OpsAlertEnv, sendOpsAlert } from "./ops-alert";
import { isPublicConfigKey } from "./private-config-keys";

/** OpsAlertEnv: the three optional Telegram HQ secrets (src/ops-alert.ts). */
interface Env extends OpsAlertEnv {
  FORWARD_MAX_ATTEMPTS: string;
  /** WhatsApp media bytes, under `waba/<wabaId>/media/` (src/media-store.ts). */
  MEDIA: R2Bucket;
  META_GRAPH_VERSION?: string;
  /** Content retention window (days): past it, `inbound_events` and `outbound_messages`
   * rows are deleted, terminal `deliveries` rows keep only metadata (payload redacted),
   * and `pending` `deliveries` rows — including events held for want of a forwarding
   * target — are deleted outright.
   * Optional wrangler var; default 30, clamped to [7, 90]. */
  CONTENT_RETENTION_DAYS?: string;
  /** Delivery-audit retention window (days): past it, terminal `deliveries` rows are
   * deleted entirely. Optional wrangler var; default 90. */
  DELIVERY_RETENTION_DAYS?: string;
  /** Reads the account's conversation retention window on the sweep. */
  CONTROL_PLANE: DurableObjectNamespace<EccosControlPlane>;
  DO_JURISDICTION?: string;
}

interface DeliveryRow {
  id: number;
  payload: string;
  attempts: number;
  next_attempt_at: number;
  phone_number_id: string | null;
  created_at: number;
}

/** Result of one forward attempt. The failure branch carries why, so the reason
 * can be stored in `deliveries.last_error` and read back by an operator. */
type ForwardOutcome = { ok: true; httpStatus: number } | { ok: false; reason: string; httpStatus?: number };

const FORWARD_FETCH_TIMEOUT_MS = 5_000;
/** Sync items (history messages, contacts) applied per alarm wake. Bounds the CPU and
 * memory one invocation spends on a huge history; a backlog keeps the alarm running. */
const SYNC_BATCH_UNITS = 200;
/** A payload above this is parked unread: it cannot be parsed inside one invocation's memory. */
export const SYNC_MAX_BYTES = 20 * 1024 * 1024;
/** Parsed items of a payload up to this size stay in memory between wakes, so it is parsed once. */
const SYNC_CACHE_MAX_BYTES = 4 * 1024 * 1024;
/** Wakes that start a payload and never finish it (aborted or failed) before it is parked. */
export const SYNC_MAX_ATTEMPTS = 5;
/** Next wake while sync work is left, and after a control-plane lookup that failed. */
const SYNC_CONTINUE_MS = 100;
const SYNC_RETRY_MS = 60_000;
/** Set while Meta's history-sharing-off refusal is not yet recorded on the control plane. */
const SHARING_OFF_KEY = "__history_sharing_off__";
const ALARM_BATCH = 40;
const ALARM_MAX_CONCURRENCY = 6;
/** Media downloads per alarm, and how many stream at once: each can move up to 100 MB. */
const MEDIA_BATCH = 5;
const MEDIA_CONCURRENCY = 2;
/** Attempts before a media id is given up. Backoff between them runs 5s, 25s, 2m, 10m. */
const MEDIA_MAX_ATTEMPTS = 5;
/** How long a failed token lookup or R2 purge waits before the alarm tries again. */
const MEDIA_RETRY_MS = 60_000;
const MEDIA_RETRY_MESSAGE = "messages erased, but their media could not be deleted yet; retry the erasure";
const MEDIA_PURGE_BATCH = 100;
const DEFAULT_CONTENT_RETENTION_DAYS = 30;
const MIN_CONTENT_RETENTION_DAYS = 7;
const MAX_CONTENT_RETENTION_DAYS = 90;
const DEFAULT_DELIVERY_RETENTION_DAYS = 90;
const OPERATOR_MAX_PAGE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Well under the 2 MB DO SQLite row limit; history webhooks can be many MB. */
export const SYNC_PART_BYTES = 512 * 1024;
/** At most one failed-delivery alert per Durable Object (one WABA) per window. */
export const OPS_ALERT_INTERVAL_MS = 60 * 60 * 1000;
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
  /** Parsed items of the payload being processed, kept between wakes (see syncItemsOf). */
  private syncCache: { id: number; items: SyncItem[] } | null = null;
  /** Set when a payload or webhook lands while alarm() runs. alarm()'s final setAlarm would
   * overwrite that wake with a later one, so alarm() checks this and wakes again at once. */
  private wakeArrived = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );`);
      // Operator-only bookkeeping (alert throttling). Kept out of `config`,
      // which the console reads back through getConfig.
      this.sql.exec(`CREATE TABLE IF NOT EXISTS ops_state (
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
      // The wamid join: a status event (`delivered`/`read`/`failed`) names the
      // outbound message it is about by `transport_message_id`, and the console
      // resolves that per page. Without an index each page is a full scan of
      // outbound_messages, billed as rows read.
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_outbound_transport
        ON outbound_messages (transport_message_id);`);
      // Kind-filtered event pages (`?kind=reply`) walk id DESC within one type.
      // Leading `type` makes that a range seek instead of a scan-and-discard,
      // which matters precisely on the filter an operator reaches for most: the
      // handful of real replies inside thousands of status callbacks.
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_inbound_type
        ON inbound_events (type, id);`);
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
      // The EVENT→BATCH KEY. Until now the only thing linking an event to the
      // delivery that carried it was that `ingest()` stamped both with the same
      // `now` — a coincidence, not a key: two callbacks landing in the same
      // millisecond produce two batches with identical timestamps, and either
      // side can be pruned independently. So the console could show "this event
      // was forwarded" for no row at all, and the queue could not say which
      // events a failed batch was holding.
      //
      // No foreign key, deliberately: retention deletes deliveries and
      // inbound_events on different windows (docs/data-lifecycle.md), so the
      // pointer is expected to dangle and every reader treats a missing join as
      // "the batch is gone", never as an error. Rows that predate the column
      // stay NULL and are never backfilled — there is no honest value to guess.
      ensureColumn("inbound_events", "delivery_id", "INTEGER");
      // After the column exists, not with the indexes above: a fresh object
      // creates the table without it (the CREATE TABLE stays the historical
      // shape, additive migrations are the only way a column arrives).
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_inbound_delivery
        ON inbound_events (delivery_id);`);
      // Raw coexistence sync webhooks (history, contacts). Meta sends them once
      // per number, so they are kept verbatim for reprocessing and are outside
      // the retention sweep.
      this.sql.exec(`CREATE TABLE IF NOT EXISTS sync_payloads (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        fields      TEXT NOT NULL,
        sha256      TEXT NOT NULL UNIQUE,
        byte_size   INTEGER NOT NULL,
        part_count  INTEGER NOT NULL,
        received_at INTEGER NOT NULL
      );`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS sync_payload_parts (
        payload_id INTEGER NOT NULL,
        ordinal    INTEGER NOT NULL,
        chunk      BLOB NOT NULL,
        PRIMARY KEY (payload_id, ordinal)
      );`);
      // Processing state of each raw payload (processSyncBatch). `cursor` counts the
      // items already applied, so a payload spread over several alarm wakes resumes.
      // A payload captured before these columns existed is NULL here, i.e. pending.
      ensureColumn("sync_payloads", "cursor", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn("sync_payloads", "processed_at", "INTEGER");
      ensureColumn("sync_payloads", "error", "TEXT");
      // Failed or aborted wakes on this payload since it last made progress (processSyncBatch).
      ensureColumn("sync_payloads", "attempts", "INTEGER NOT NULL DEFAULT 0");
      // Numbers erased by eraseByPhone. Raw payloads keep them, so processing consults
      // this table to keep an erased number from coming back on reprocess.
      this.sql.exec(`CREATE TABLE IF NOT EXISTS erased_numbers (
        digits    TEXT PRIMARY KEY,
        erased_at INTEGER NOT NULL
      );`);
      // Outbound history media whose placeholder is not stored yet: a media webhook
      // with no customer number cannot be filed until the placeholder names one.
      this.sql.exec(`CREATE TABLE IF NOT EXISTS history_media (
        id      TEXT PRIMARY KEY,
        at      INTEGER NOT NULL,
        type    TEXT NOT NULL,
        text    TEXT,
        content TEXT
      );`);
      // The conversation store (eccos-yqbz.2). Outside the content sweep on purpose:
      // these rows are the conversations themselves, so per-workspace retention
      // will own their lifetime, not CONTENT_RETENTION_DAYS.
      const hasConversations =
        this.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'`).toArray().length > 0;
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`CREATE TABLE IF NOT EXISTS contacts (
          wa_id      TEXT PRIMARY KEY,
          name       TEXT,
          source     TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
          id              TEXT PRIMARY KEY,
          wa_id           TEXT NOT NULL,
          direction       TEXT NOT NULL,
          origin          TEXT NOT NULL,
          type            TEXT NOT NULL,
          text            TEXT,
          content         TEXT,
          at              INTEGER NOT NULL,
          status          TEXT,
          error           TEXT,
          target_id       TEXT,
          phone_number_id TEXT,
          created_at      INTEGER NOT NULL
        );`);
        this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_messages_wa_at ON messages (wa_id, at);`);
        this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_messages_target ON messages (target_id);`);
        // Partial: the newest window-opening inbound of a thread reads at most one index entry.
        this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_messages_wa_inbound ON messages (wa_id, at)
          WHERE direction = 'in' AND type <> 'system';`);
        // Media bookkeeping (eccos-yqbz.6). One row per media id, in states: `failed`
        // (retried once `next_attempt_at` passes), `stored` (the R2 object exists),
        // `gone` (given up), `erased` (tombstone: the R2 object is due to be deleted).
        this.sql.exec(`CREATE TABLE IF NOT EXISTS media (
          media_id        TEXT PRIMARY KEY,
          state           TEXT NOT NULL,
          attempts        INTEGER NOT NULL DEFAULT 0,
          last_error      TEXT,
          next_attempt_at INTEGER,
          updated_at      INTEGER NOT NULL
        );`);
        this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_media_retry ON media (state, next_attempt_at);`);
        // Partial, on the media id: finding the media messages reads only those rows,
        // not the whole conversation store on every alarm.
        this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_messages_media ON messages (json_extract(content, '$.media.id'))
          WHERE json_extract(content, '$.media.id') IS NOT NULL;`);
        // Same transaction as the CREATE TABLEs: a backfill that fails rolls the
        // tables back too, so the next start retries instead of finding a
        // half-filled store that looks complete.
        if (!hasConversations) this.backfillConversations();
      });
    });
  }

  /** Stores a raw sync webhook body once, keyed by its SHA-256 (a Meta retry
   * of the same body is a duplicate). */
  async captureSyncPayload(
    fields: string[],
    rawBody: string,
  ): Promise<{ duplicate: boolean; bytes: number; parts: number }> {
    const bytes = new TextEncoder().encode(rawBody);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const parts = Math.max(1, Math.ceil(bytes.length / SYNC_PART_BYTES));
    let duplicate = true;
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec(
          `INSERT OR IGNORE INTO sync_payloads (fields, sha256, byte_size, part_count, received_at)
           VALUES (?, ?, ?, ?, ?) RETURNING id`,
          fields.join(","),
          sha256,
          bytes.length,
          parts,
          Date.now(),
        )
        .toArray()[0];
      if (!row) return;
      duplicate = false;
      for (let i = 0; i < parts; i++) {
        const chunk = bytes.slice(i * SYNC_PART_BYTES, (i + 1) * SYNC_PART_BYTES);
        this.sql.exec(
          `INSERT INTO sync_payload_parts (payload_id, ordinal, chunk) VALUES (?, ?, ?)`,
          row.id,
          i,
          chunk.buffer,
        );
      }
    });
    if (!duplicate) this.wakeNow();
    return { duplicate, bytes: bytes.length, parts };
  }

  ingest(events: WhatsAppCallbackEvent[]): { received: number } {
    if (events.length === 0) return { received: 0 };
    const now = Date.now();
    const insertedIds: number[] = [];
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
        const row = insertedRows[0];
        if (row) insertedIds.push(Number(row.id));
        this.writeConversation(ev, now);
      }
      if (insertedIds.length > 0) {
        const phoneIds = new Set(events.map((event) => event.phoneNumberId?.trim() || null));
        const phoneNumberId = phoneIds.size === 1 ? [...phoneIds][0] ?? null : null;
        const batch = this.sql
          .exec(
            `INSERT INTO deliveries (phone_number_id, payload, status, attempts, next_attempt_at, created_at)
             VALUES (?, ?, 'pending', 0, ?, ?)
             RETURNING id`,
            phoneNumberId,
            JSON.stringify({ events }),
            now,
            now,
          )
          .toArray()[0];
        // The link, written in the SAME transaction that created both sides, so
        // an event never exists with a batch it cannot name.
        //
        // A second statement rather than stamping each row at insert time (which
        // would mean inserting the delivery first): the batch is only created
        // when something new arrived, and a delivery inserted up-front and
        // rolled back on an all-duplicate callback would burn an AUTOINCREMENT
        // id. Those ids are now VISIBLE — the console calls a batch `#N` — and a
        // numbering with holes invites an operator to hunt for a delivery that
        // was never a delivery.
        //
        // Only the rows this call inserted are stamped. A duplicate keeps the
        // `delivery_id` of the batch that first carried it, which is the honest
        // answer: that is the batch the subscriber received it in.
        if (batch) {
          const deliveryId = Number(batch.id);
          const placeholders = insertedIds.map(() => "?").join(", ");
          this.sql.exec(
            `UPDATE inbound_events SET delivery_id = ? WHERE id IN (${placeholders})`,
            deliveryId,
            ...insertedIds,
          );
        }
      }
    });
    // Ties this object's id to its WABA in Workers Logs; duplicates are events minus inserted.
    console.log(
      JSON.stringify({
        level: "info",
        area: "ingest",
        event: "ingested",
        wabaId: this.wabaIdForOps(),
        eventCount: events.length,
        inserted: insertedIds.length,
      }),
    );
    if (insertedIds.length > 0) this.wakeNow();
    return { received: events.length };
  }

  /** `waId` is the number Meta answered the send with (`contacts[0].wa_id`). It is the
   * key inbound messages use, so the send lands in the same conversation; the typed
   * `recipient` is the fallback when Meta omits it. */
  logOutbound(
    transportMessageId: string | null,
    recipient: string,
    requestJson: string,
    status: "sent" | "failed",
    errorJson: string | null,
    phoneNumberId?: string | null,
    waId?: string | null,
  ): void {
    const now = Date.now();
    const phoneId = phoneNumberId?.trim() || null;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO outbound_messages
           (transport_message_id, recipient, phone_number_id, request, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        transportMessageId,
        recipient,
        phoneId,
        requestJson,
        status,
        errorJson,
        now,
      );
      if (status !== "sent" || !transportMessageId) return;
      const message = messageFromOutbound({
        id: transportMessageId,
        waId: waId || recipient,
        request: requestJson,
        phoneNumberId: phoneId,
        at: now,
      });
      this.storeMessage(message, now);
      // A status callback can overtake the send's own response. It was stored
      // with no message to move, so replay it now that the message exists.
      for (const row of this.sql.exec(
        `SELECT payload FROM inbound_events WHERE transport_message_id = ? ORDER BY id`,
        transportMessageId,
      )) {
        this.applyStoredEvent(row.payload as string, now);
      }
    });
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

  /**
   * One page of the event log, with both of its joins resolved.
   *
   * The joins are the point. An event alone answers "what arrived"; an operator
   * asks "what did the relay DO with it", and that needs the batch it went out
   * in (`deliveries`, via the `delivery_id` written at ingest) and — for a
   * status callback — the message it is about (`outbound_messages`, via the
   * wamid). Both were reachable in principle and joined nowhere, so the same
   * wamid was printed in full on two pages and was a door on neither.
   *
   * Two statements per page, never per row: the LEFT JOINs ride the page query,
   * and the per-batch event count is one grouped read over the page's batch ids
   * through `idx_inbound_delivery`.
   *
   * `deliveryStatus` filters on the joined table, which drops events with no
   * batch — correct, and deliberate: an event that has no delivery is neither
   * waiting nor forwarded nor failed, so it belongs in none of those views.
   */
  listInbound(
    opts: { limit?: number; before?: number; type?: string; deliveryStatus?: string } = {},
  ): InboundRow[] {
    const where = ["e.id < ?"];
    const params: unknown[] = [opts.before ?? Number.MAX_SAFE_INTEGER];
    if (opts.type) {
      where.push("e.type = ?");
      params.push(opts.type);
    }
    if (opts.deliveryStatus) {
      where.push("d.status = ?");
      params.push(opts.deliveryStatus);
    }
    params.push(clampPage(opts.limit));
    const rows = this.sql
      .exec(
        `SELECT e.id, e.type, e.transport_message_id, e.message_id, e.phone_number_id,
                e.payload, e.received_at, e.delivery_id,
                d.status          AS delivery_status,
                d.attempts        AS delivery_attempts,
                d.created_at      AS delivery_created_at,
                d.finished_at     AS delivery_finished_at,
                d.next_attempt_at AS delivery_next_attempt_at,
                d.last_error      AS delivery_last_error,
                o.id              AS outbound_id,
                o.request         AS outbound_request
         FROM inbound_events e
         LEFT JOIN deliveries d ON d.id = e.delivery_id
         LEFT JOIN outbound_messages o ON o.transport_message_id = e.transport_message_id
         WHERE ${where.join(" AND ")}
         ORDER BY e.id DESC LIMIT ?`,
        ...params,
      )
      .toArray() as unknown as InboundRow[];

    const batchIds = [...new Set(rows.map((row) => row.delivery_id).filter((id): id is number => id != null))];
    if (batchIds.length === 0) return rows;
    const counts = new Map<number, number>();
    for (const row of this.sql
      .exec(
        `SELECT delivery_id, COUNT(*) AS c FROM inbound_events
         WHERE delivery_id IN (${batchIds.map(() => "?").join(", ")})
         GROUP BY delivery_id`,
        ...batchIds,
      )
      .toArray()) {
      counts.set(Number(row.delivery_id), Number(row.c));
    }
    for (const row of rows) {
      row.delivery_event_count = row.delivery_id == null ? null : counts.get(row.delivery_id) ?? null;
    }
    return rows;
  }

  listOutbound(opts: { limit?: number; before?: number; status?: string } = {}): OutboundRow[] {
    const where = ["id < ?"];
    const params: unknown[] = [opts.before ?? Number.MAX_SAFE_INTEGER];
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    params.push(clampPage(opts.limit));
    const rows = this.sql
      .exec(
        `SELECT id, transport_message_id, recipient, phone_number_id, request, status, error, created_at
         FROM outbound_messages WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
        ...params,
      )
      .toArray() as unknown as OutboundRow[];
    return this.withTrails(rows);
  }

  /**
   * One row per customer number: its latest message, its size and its contact
   * name. Newest conversation first. The page cursor is the latest message's
   * `(at, rowid)`, so conversations whose latest messages share a second still
   * page without gaps or repeats.
   *
   * Aggregates over the whole `messages` table, because "latest per number"
   * cannot be answered from an index alone. That is fine at single-WABA volumes;
   * a per-conversation summary table is the fix if it stops being fine.
   */
  listConversations(opts: { limit?: number; cursor?: string } = {}): CursorPage<ConversationSummary> {
    const limit = clampPage(opts.limit);
    const after = decodeCursor(opts.cursor);
    const rows = this.sql
      .exec(
        `SELECT t.wa_id, t.type, t.text, t.direction, t.at, t.seq, t.message_count, c.name
         FROM (
           SELECT wa_id, type, text, direction, at, rowid AS seq,
                  ROW_NUMBER() OVER (PARTITION BY wa_id ORDER BY at DESC, rowid DESC) AS rn,
                  COUNT(*) OVER (PARTITION BY wa_id) AS message_count
           FROM messages
         ) t
         LEFT JOIN contacts c ON c.wa_id = t.wa_id
         WHERE t.rn = 1 AND (t.at < ? OR (t.at = ? AND t.seq < ?))
         ORDER BY t.at DESC, t.seq DESC
         LIMIT ?`,
        after.at,
        after.at,
        after.seq,
        limit + 1,
      )
      .toArray();
    const items = rows.slice(0, limit).map((row) => ({
      waId: row.wa_id as string,
      name: (row.name as string | null) ?? null,
      messageCount: Number(row.message_count),
      lastMessage: {
        type: row.type as string,
        text: (row.text as string | null) ?? null,
        direction: row.direction as MessageDirection,
        at: Number(row.at),
      },
    }));
    return { items, nextCursor: rows.length > limit ? encodeCursor(lastPosition(rows, limit)) : null };
  }

  /** One page of a conversation. The query runs newest-first so the cursor walks
   * backwards; the page is returned oldest-first. `(at, rowid)` orders the page, and
   * the cursor carries both, so messages sharing a second are never skipped. */
  getConversation(opts: { waId: string; limit?: number; cursor?: string }): CursorPage<MessageRecord> {
    const limit = clampPage(opts.limit);
    const after = decodeCursor(opts.cursor);
    const rows = this.sql
      .exec(
        `SELECT rowid AS seq, ${MESSAGE_COLUMNS} FROM messages
         WHERE wa_id = ? AND (at < ? OR (at = ? AND rowid < ?))
         ORDER BY at DESC, rowid DESC LIMIT ?`,
        waIdOf(opts.waId),
        after.at,
        after.at,
        after.seq,
        limit + 1,
      )
      .toArray();
    const items = rows.slice(0, limit).map(toMessageRecord).reverse();
    return { items, nextCursor: rows.length > limit ? encodeCursor(lastPosition(rows, limit)) : null };
  }

  /**
   * Everything the console needs to open a thread, in one local read: a page of
   * messages, the stored contact name, and where a reply goes out from. The reply
   * is thread-wide, whatever page is asked for: the newest customer message that
   * is not a system notice names the number and opens the window. With none, the
   * reply uses the newest number named on the returned page and no window is open.
   */
  getThreadView(opts: { waId: string; limit?: number; cursor?: string }): ThreadView {
    const page = this.getConversation(opts);
    const waId = waIdOf(opts.waId);
    const name = this.sql.exec(`SELECT name FROM contacts WHERE wa_id = ?`, waId).toArray()[0]?.name;
    const inbound = this.sql
      .exec(
        `SELECT at, phone_number_id FROM messages
         WHERE wa_id = ? AND direction = 'in' AND type <> 'system'
         ORDER BY at DESC, rowid DESC LIMIT 1`,
        waId,
      )
      .toArray()[0];
    const newestNumber = [...page.items].reverse().find((m) => m.phoneNumberId)?.phoneNumberId ?? null;
    const inboundNumber = (inbound?.phone_number_id as string | null | undefined) ?? null;
    return {
      page,
      contactName: (name as string | null | undefined) ?? null,
      reply: inbound && inboundNumber
        ? { phoneNumberId: inboundNumber, lastInboundAt: Number(inbound.at) }
        : { phoneNumberId: newestNumber, lastInboundAt: null },
    };
  }

  /**
   * Hangs each message's status callbacks off it — the message's trail.
   *
   * ONE query for the whole page (`transport_message_id IN (…)`), against the
   * existing `uq_inbound_status` index, rather than one per row: a per-row read
   * would turn a 50-row page into 51 statements, and Cloudflare bills rows
   * scanned. A message with no wamid (a refused send) contributes no key and
   * gets the empty array without any read at all.
   */
  private withTrails(rows: OutboundRow[]): OutboundRow[] {
    const wamids = [...new Set(rows.map((row) => row.transport_message_id).filter((id): id is string => !!id))];
    for (const row of rows) row.trail = [];
    if (wamids.length === 0) return rows;
    const byWamid = new Map<string, OutboundTrailEvent[]>();
    for (const event of this.sql
      .exec(
        `SELECT e.transport_message_id, e.type, e.payload, e.received_at,
                d.status AS delivery_status, d.attempts AS delivery_attempts
         FROM inbound_events e
         LEFT JOIN deliveries d ON d.id = e.delivery_id
         WHERE e.transport_message_id IN (${wamids.map(() => "?").join(", ")})
         ORDER BY e.id ASC`,
        ...wamids,
      )
      .toArray()) {
      const wamid = event.transport_message_id as string;
      const list = byWamid.get(wamid) ?? [];
      list.push({
        type: event.type as string,
        // Meta's own `at` when the payload carries one, so the trail can be
        // read against a customer's screenshot; `received_at` is Eccos' clock
        // and only stands in when the payload cannot be parsed.
        ...readEventMoment(event.payload as string, Number(event.received_at)),
        deliveryStatus: (event.delivery_status as string | null) ?? null,
        deliveryAttempts: event.delivery_attempts == null ? null : Number(event.delivery_attempts),
      });
      byWamid.set(wamid, list);
    }
    for (const row of rows) {
      if (row.transport_message_id) row.trail = byWamid.get(row.transport_message_id) ?? [];
    }
    return rows;
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
    // The export is the STORED rows, so `delivery_id` belongs in it (it is a
    // column) and the joins do not (they are derived at read time).
    return this.sql
      .exec(
        `SELECT id, type, transport_message_id, message_id, phone_number_id, payload, received_at, delivery_id
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

  private listAllMessages(): MessageRecord[] {
    return this.sql
      .exec(`SELECT ${MESSAGE_COLUMNS} FROM messages ORDER BY at DESC, rowid DESC`)
      .toArray()
      .map(toMessageRecord);
  }

  private listAllContacts(): ContactRecord[] {
    return this.sql
      .exec(`SELECT wa_id, name, source, updated_at FROM contacts ORDER BY wa_id`)
      .toArray()
      .map((row) => ({
        waId: row.wa_id as string,
        name: (row.name as string | null) ?? null,
        source: row.source as string,
        updatedAt: Number(row.updated_at),
      }));
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
   * message, delivery and conversation message (existing row shapes), contact,
   * plus the non-secret connection metadata/config (secrets and internal keys
   * are filtered — see isPublicConfigKey). JSON-serializable, with a fixed key
   * order: inbound, outbound, deliveries, messages, contacts, config. Inbound,
   * outbound and deliveries are newest first by id; messages newest first by
   * `(at, rowid)`; contacts by `wa_id`. Single snapshot: no limit/pagination —
   * a tenant's full retained history at single-tenant v1 volumes.
   */
  exportData(): GatewayExport {
    return {
      inbound: this.listAllInbound(),
      outbound: this.listAllOutbound(),
      deliveries: this.listAllDeliveries(),
      messages: this.listAllMessages(),
      contacts: this.listAllContacts(),
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
    // Split by kind as well as totalled. The flat count cannot tell a human
    // writing (`reply` / `echo` / `message` / `message_echo`) from Meta
    // reporting on one of our own sends (`delivered` / `read` / `failed`), and
    // every one of those is a row in the same table — so "2 inbound events" read as "two customers wrote in" on a
    // workspace where nobody had. One extra GROUP BY over a table the flat
    // COUNT already scans.
    const inboundByType: Record<string, number> = {};
    for (const row of this.sql.exec("SELECT type, COUNT(*) AS c FROM inbound_events GROUP BY type").toArray()) {
      inboundByType[row.type as string] = Number(row.c);
    }
    return {
      inbound: Number(inboundRow?.c ?? 0),
      inboundByType,
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
   * Re-enqueue every `failed` delivery enqueued inside [from, to] (eccos-r92o):
   * the recovery step after a gateway fault such as eccos-ugb6, where hundreds
   * of rows failed through no fault of the subscriber and the per-row Retry is
   * not a real option.
   *
   * Operator action with an explicit window, never "all": a replayed event can
   * be days old, and only the subscriber can say how late is too late. Each row
   * goes out with the same `x-idempotency-key` it always had, so a subscriber
   * that dedupes on it stays safe. Redacted rows cannot be replayed (see
   * retryDelivery); they are counted and left as they are.
   *
   * Count and update run in one synchronous turn, so the reported number is the
   * number moved. One alarm wake; the drain takes ALARM_BATCH rows at a time.
   */
  retryFailedDeliveries(from: number, to: number): { requeued: number; skippedRedacted: number } {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      throw new Error("invalid retry window: from and to must be epoch ms with from <= to");
    }
    const count = (redacted: boolean): number =>
      Number(
        this.sql
          .exec(
            `SELECT COUNT(*) AS c FROM deliveries
             WHERE status = 'failed' AND created_at BETWEEN ? AND ? AND (payload = ?) = ?`,
            from,
            to,
            REDACTED_PAYLOAD,
            redacted ? 1 : 0,
          )
          .toArray()[0]?.c ?? 0,
      );
    const requeued = count(false);
    const skippedRedacted = count(true);
    if (requeued > 0) {
      const now = Date.now();
      this.sql.exec(
        `UPDATE deliveries
         SET status = 'pending', attempts = 0, last_error = NULL, finished_at = NULL, next_attempt_at = ?
         WHERE status = 'failed' AND created_at BETWEEN ? AND ? AND payload != ?`,
        now,
        from,
        to,
        REDACTED_PAYLOAD,
      );
      this.ctx.storage.setAlarm(now);
    }
    return { requeued, skippedRedacted };
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
   * `messages` and `contacts` are keyed on the normalized `wa_id` directly, so
   * they need no wamid join. Returns per-table counts so the operator can
   * evidence the erasure.
   */
  async eraseByPhone(phone: string): Promise<EraseByPhoneResult> {
    const digits = normalizePhoneNumber(phone);
    if (!digits) {
      return { ok: false, error: "invalid phone number: expected at least 5 digits" };
    }
    const counts: ErasureCounts = {
      inboundEventsDeleted: 0,
      outboundMessagesDeleted: 0,
      deliveriesRedacted: 0,
      deliveriesDeleted: 0,
      messagesDeleted: 0,
      contactsDeleted: 0,
    };
    this.ctx.storage.transactionSync(() => {
      // Recorded first: a reprocess of the raw sync payloads must not bring this number back.
      this.sql.exec(`INSERT OR IGNORE INTO erased_numbers (digits, erased_at) VALUES (?, ?)`, digits, Date.now());

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

      // 5. The conversation store: every message to or from the number, and its contact.
      //    A send is stored under the wa_id Meta answered with, which can differ from
      //    the typed number, so the collected wamids also name those wa_ids.
      const waIds = new Set([digits]);
      for (const wamid of wamids) {
        const row = this.sql.exec(`SELECT wa_id FROM messages WHERE id = ?`, wamid).toArray()[0];
        if (row) waIds.add(row.wa_id as string);
      }
      const placeholders = [...waIds].map(() => "?").join(", ");
      const mediaIds = this.mediaIdsOf(`wa_id IN (${placeholders})`, ...waIds);
      counts.messagesDeleted = this.sql
        .exec(`DELETE FROM messages WHERE wa_id IN (${placeholders}) RETURNING id`, ...waIds)
        .toArray().length;
      counts.contactsDeleted = this.sql
        .exec(`DELETE FROM contacts WHERE wa_id IN (${placeholders}) RETURNING wa_id`, ...waIds)
        .toArray().length;
      this.tombstoneUnreferencedMedia(mediaIds);
    });
    // The R2 objects go in the same request, so a successful erasure has deleted
    // its media. If R2 refuses, the tombstones keep the work queued: the alarm
    // retries it, and an operator's retry of this call finishes it at once.
    if (!(await this.purgeErasedMedia())) {
      this.ctx.storage.setAlarm(Date.now() + MEDIA_RETRY_MS);
      return { ok: false, error: MEDIA_RETRY_MESSAGE, retryable: true };
    }
    return { ok: true, phone: digits, counts };
  }

  /** Arms the alarm for now. Safe to call during alarm(): see `wakeArrived`. */
  private wakeNow(): void {
    this.wakeArrived = true;
    this.ctx.storage.setAlarm(Date.now());
  }

  /** Writes one normalized event into the conversation store. An inbound or echo
   * event adds a message; a status moves the message it names. Runs inside the
   * caller's transaction. */
  private writeConversation(ev: WhatsAppCallbackEvent, now: number): void {
    const message = messageFromEvent(ev);
    if (message) {
      this.storeMessage(message, now, "profileName" in ev ? (ev.profileName ?? null) : null);
      return;
    }
    const update = statusFromEvent(ev);
    if (!update) return;
    // Statuses only move a message forward: sent → delivered → read. `failed` is
    // terminal and only replaces a send Meta had not yet confirmed. A duplicate
    // or an out-of-order callback matches no row and changes nothing.
    this.sql.exec(
      `UPDATE messages SET status = ?, error = COALESCE(?, error)
       WHERE id = ? AND direction != 'in'
         AND (status IS NULL OR status = 'sent' OR (status = 'delivered' AND ? = 'read'))`,
      update.status,
      update.error,
      update.id,
      update.status,
    );
  }

  /** Applies one stored inbound payload to the conversation store. A payload that
   * does not parse or write is skipped, so an old bad row cannot fail a DO start
   * or roll back the send that replays it. */
  private applyStoredEvent(payload: string, at: number): void {
    try {
      this.writeConversation(JSON.parse(payload), at);
    } catch {
      // Skipped, see above.
    }
  }

  /** Inserts a message once (a duplicate webhook or a re-run backfill is ignored)
   * and upserts its contact. A live profile name fills a contact with no name, or
   * replaces an earlier live one; an address-book name (app_state) is never replaced.
   * A live message replaces a history row with the same id (history never replaces a live row). */
  private storeMessage(message: NewMessage, createdAt: number, profileName: string | null = null): void {
    this.sql.exec(
      `INSERT INTO messages
         (id, wa_id, direction, origin, type, text, content, at, status, target_id, phone_number_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         wa_id = excluded.wa_id, direction = excluded.direction, origin = excluded.origin,
         type = excluded.type, text = excluded.text, content = excluded.content, at = excluded.at,
         status = excluded.status, target_id = excluded.target_id, phone_number_id = excluded.phone_number_id
       WHERE messages.origin = 'history'`,
      message.id,
      message.waId,
      message.direction,
      message.origin,
      message.type,
      message.text,
      message.content,
      message.at,
      message.status,
      message.targetId,
      message.phoneNumberId,
      createdAt,
    );
    this.sql.exec(
      `INSERT INTO contacts (wa_id, name, source, updated_at) VALUES (?, ?, 'live', ?)
       ON CONFLICT(wa_id) DO UPDATE SET
         name = CASE WHEN excluded.name IS NOT NULL AND (contacts.name IS NULL OR contacts.source = 'live')
           THEN excluded.name ELSE contacts.name END,
         source = CASE WHEN excluded.name IS NOT NULL AND (contacts.name IS NULL OR contacts.source = 'live')
           THEN 'live' ELSE contacts.source END,
         updated_at = excluded.updated_at`,
      message.waId,
      profileName,
      createdAt,
    );
  }

  /** Builds the conversation store from the rows retention still holds (at most
   * the content window): outbound sends first, then inbound events in arrival
   * order, so every status lands on the message it names. Runs once, when the
   * tables are created; exposed so tests can drive it directly. Rows are streamed,
   * and a row that cannot be applied is skipped, so one bad row never fails a start. */
  backfillConversations(): void {
    for (const row of this.sql.exec(
      `SELECT transport_message_id, recipient, phone_number_id, request, created_at FROM outbound_messages
       WHERE status = 'sent' AND transport_message_id IS NOT NULL ORDER BY id`,
    )) {
      try {
        const createdAt = Number(row.created_at);
        this.storeMessage(
          messageFromOutbound({
            id: row.transport_message_id as string,
            waId: row.recipient as string,
            request: row.request as string,
            phoneNumberId: (row.phone_number_id as string | null) ?? null,
            at: createdAt,
          }),
          createdAt,
        );
      } catch {
        // A row that cannot be stored is skipped, not fatal to the DO start.
      }
    }
    for (const row of this.sql.exec(`SELECT payload, received_at FROM inbound_events ORDER BY id`)) {
      this.applyStoredEvent(row.payload as string, Number(row.received_at));
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.wakeArrived = false;
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
            `SELECT id, payload, attempts, next_attempt_at, phone_number_id, created_at FROM deliveries
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
      await this.pruneConversations(now);
      this.saveConfig({ [LAST_SWEEP_KEY]: String(now) });
      nextSweepAt = now + SWEEP_INTERVAL_MS;
    }

    // One alarm serves delivery, retention, sync and media: arm the earliest of their wakes, so
    // a sync backlog or retry cannot push a due delivery back.
    const wakes: number[] = [];
    // Only reschedule against `next_attempt_at` when there is somewhere to send.
    // Held rows are due now, so an unconditional reschedule would set an alarm
    // in the past and re-enter this method forever without ever forwarding.
    if (hasTarget) {
      const nextRows = this.sql
        .exec(`SELECT MIN(next_attempt_at) AS next FROM deliveries WHERE status='pending'`)
        .toArray();
      const nextRow = nextRows[0];
      const next = nextRow ? (nextRow.next as number | null) : null;
      if (next != null) wakes.push(next);
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
      wakes.push(nextSweepAt);
    }

    // After the delivery wake is known: a slow control-plane call in sync must not hold it back.
    const syncWake = await this.runSyncBatch(now);
    if (syncWake !== null) wakes.push(Date.now() + syncWake);
    // Last, after the sweep, so the media of the messages it just pruned is purged in this same alarm.
    const mediaWakeAt = await this.mediaStep(now);
    if (mediaWakeAt !== null) wakes.push(mediaWakeAt);
    // Work that arrived during this run was armed for now, and the earlier wakes above would overwrite it.
    if (this.wakeArrived) wakes.push(Date.now());
    if (wakes.length > 0) this.ctx.storage.setAlarm(Math.min(...wakes));
    if (hasWorkerError) throw workerError;
  }

  /** processSyncBatch, but never thrown: the delivery re-arm in alarm() must run whatever
   * happens here. The attempt was counted before the failure, so the payload still ends. */
  private async runSyncBatch(now: number): Promise<number | null> {
    try {
      return await this.processSyncBatch(now);
    } catch (error) {
      console.warn(
        JSON.stringify({ level: "warn", area: "history", event: "sync-failed", wabaId: this.wabaIdForOps(), error: String(error).slice(0, 200) }),
      );
      return SYNC_CONTINUE_MS;
    }
  }

  /**
   * Applies the raw sync payloads (history and contacts) to the conversation store,
   * oldest first, at most SYNC_BATCH_UNITS items per call. Each payload records how
   * far it got (`cursor`), so the next wake resumes it. A wake that starts a payload
   * counts an attempt before any work, so a run the runtime aborts still counts; a
   * payload that stops making progress is parked after SYNC_MAX_ATTEMPTS.
   * Returns the delay until the next wake while work is left, or null when none is.
   */
  private async processSyncBatch(now: number): Promise<number | null> {
    const waba = this.wabaIdForOps();
    const refused = this.getConfigValue(SHARING_OFF_KEY) !== null;
    if (!refused && !this.hasPendingSyncPayloads()) return null;
    // Every await comes before the reads below: an erase or reprocess can run during it.
    if (refused && !(await this.recordHistorySharingOff(waba))) return SYNC_RETRY_MS;
    const days = await this.conversationRetentionDays();
    if (days === undefined) return SYNC_RETRY_MS;
    const cutoff = days === null ? null : now - days * DAY_MS;
    const erased = new Set(
      this.sql.exec(`SELECT digits FROM erased_numbers`).toArray().map((row) => row.digits as string),
    );
    let budget = SYNC_BATCH_UNITS;
    for (const row of this.sql
      .exec(`SELECT id, cursor, attempts, byte_size FROM sync_payloads WHERE processed_at IS NULL ORDER BY id`)
      .toArray()) {
      if (budget <= 0) return SYNC_CONTINUE_MS;
      const id = row.id as number;
      const byteSize = Number(row.byte_size);
      if (byteSize > SYNC_MAX_BYTES) {
        this.parkSyncPayload(id, now, `payload too large: ${byteSize} bytes, the limit is ${SYNC_MAX_BYTES}`);
        continue;
      }
      const attempts = Number(row.attempts) + 1;
      if (attempts > SYNC_MAX_ATTEMPTS) {
        this.parkSyncPayload(id, now, `gave up after ${SYNC_MAX_ATTEMPTS} failed runs`);
        continue;
      }
      this.sql.exec(`UPDATE sync_payloads SET attempts = ? WHERE id = ?`, attempts, id);
      let items: SyncItem[];
      try {
        items = this.syncItemsOf(id, byteSize, waba);
      } catch (error) {
        this.parkSyncPayload(id, now, `unreadable payload: ${String(error).slice(0, 200)}`);
        continue;
      }
      const cursor = Number(row.cursor);
      const end = Math.min(items.length, cursor + budget);
      let sharingOff = false;
      this.ctx.storage.transactionSync(() => {
        for (const item of items.slice(cursor, end)) {
          try {
            sharingOff ||= this.applySyncItem(id, item, erased, now, waba, cutoff);
          } catch (error) {
            console.warn(
              JSON.stringify({ level: "warn", area: "history", event: "item-skipped", wabaId: waba, error: String(error).slice(0, 200) }),
            );
          }
        }
        // Progress clears the attempts: only a payload that stops advancing is parked.
        this.sql.exec(
          `UPDATE sync_payloads SET cursor = ?, processed_at = ?, attempts = 0 WHERE id = ?`,
          end,
          end === items.length ? now : null,
          id,
        );
        if (sharingOff) {
          this.sql.exec(`INSERT OR REPLACE INTO config (key, value) VALUES (?, '1')`, SHARING_OFF_KEY);
        }
      });
      if (end === items.length) this.syncCache = null;
      budget -= end - cursor;
      // Nothing after this point reads state an await could have changed: the next wake starts fresh.
      if (sharingOff) return (await this.recordHistorySharingOff(waba)) ? SYNC_CONTINUE_MS : SYNC_RETRY_MS;
      if (end < items.length) return SYNC_CONTINUE_MS;
    }
    return null;
  }

  private hasPendingSyncPayloads(): boolean {
    return this.sql.exec(`SELECT 1 FROM sync_payloads WHERE processed_at IS NULL LIMIT 1`).toArray().length > 0;
  }

  /** Ends a payload that cannot be applied, with the reason kept on the row for the operator. */
  private parkSyncPayload(id: number, now: number, error: string): void {
    this.sql.exec(`UPDATE sync_payloads SET processed_at = ?, error = ? WHERE id = ?`, now, error, id);
    this.syncCache = null;
    console.warn(JSON.stringify({ level: "warn", area: "history", event: "payload-parked", wabaId: this.wabaIdForOps(), payload: id, error }));
  }

  /** The parsed items of a payload. The payload being worked on stays in memory between
   * wakes (up to SYNC_CACHE_MAX_BYTES), so a large history is not parsed again on every wake. */
  private syncItemsOf(id: number, byteSize: number, waba: string): SyncItem[] {
    if (this.syncCache?.id === id) return this.syncCache.items;
    const items = syncItems(JSON.parse(this.syncPayloadBody(id)), waba);
    this.syncCache = byteSize <= SYNC_CACHE_MAX_BYTES ? { id, items } : null;
    return items;
  }

  /** The workspace's retention window in days (null keeps everything). Undefined when the
   * control plane cannot say, which is logged: an unknown window is never guessed. */
  private async conversationRetentionDays(): Promise<number | null | undefined> {
    try {
      return await getControlPlaneStub(this.env).getConversationRetentionDaysForWaba(this.wabaIdForOps());
    } catch (error) {
      console.warn(
        JSON.stringify({ level: "warn", area: "retention", event: "lookup-failed", wabaId: this.wabaIdForOps(), error: String(error).slice(0, 200) }),
      );
      return undefined;
    }
  }

  /** Tells the control plane that Meta refused history sharing. The flag stays set until the
   * call succeeds, so a failed call is retried by the next wake. Returns true once recorded. */
  private async recordHistorySharingOff(waba: string): Promise<boolean> {
    try {
      await getControlPlaneStub(this.env).markHistorySharingOff(waba);
    } catch (error) {
      console.warn(
        JSON.stringify({ level: "warn", area: "history", event: "sharing-off-not-recorded", wabaId: waba, error: String(error).slice(0, 200) }),
      );
      return false;
    }
    this.sql.exec(`DELETE FROM config WHERE key = ?`, SHARING_OFF_KEY);
    return true;
  }

  /** Applies one sync item. Runs inside processSyncBatch's transaction. Returns true for a history-sharing-off refusal. */
  private applySyncItem(
    payloadId: number,
    item: SyncItem,
    erased: Set<string>,
    now: number,
    waba: string,
    cutoff: number | null,
  ): boolean {
    const unit = mapSyncItem(item, waba);
    if (!unit) return false;
    if (unit.kind === "error") {
      this.sql.exec(`UPDATE sync_payloads SET error = ? WHERE id = ?`, `Meta error ${unit.code}`, payloadId);
      console.warn(
        JSON.stringify({
          level: "warn",
          area: "history",
          event: unit.code === SMB_APP_DATA_HISTORY_SHARING_OFF_CODE ? "history-sharing-off" : "history-error",
          wabaId: waba,
          code: unit.code,
        }),
      );
      return unit.code === SMB_APP_DATA_HISTORY_SHARING_OFF_CODE;
    }
    if (unit.kind === "contact") {
      if (erased.has(unit.waId)) return false;
      if (unit.action === "remove") {
        // The contact stays (its messages stay); only the name Meta gave goes.
        this.sql.exec(`UPDATE contacts SET name = NULL, updated_at = ? WHERE wa_id = ?`, now, unit.waId);
        return false;
      }
      this.sql.exec(
        `INSERT INTO contacts (wa_id, name, source, updated_at) VALUES (?, ?, 'app_state', ?)
         ON CONFLICT(wa_id) DO UPDATE SET name = excluded.name, source = 'app_state', updated_at = excluded.updated_at`,
        unit.waId,
        unit.name,
        now,
      );
      return false;
    }
    this.storeHistoryMessage(unit.message, erased, now, cutoff);
    return false;
  }

  /** Stores one history message. A row already stored keeps its content, except that a
   * media placeholder takes the media reference of the message with the same id, so the
   * placeholder and the separate media webhook agree whichever arrives first. A message
   * older than `cutoff` (the workspace window) is not stored. */
  private storeHistoryMessage(message: HistoryMessage, erased: Set<string>, now: number, cutoff: number | null): void {
    if (cutoff !== null && message.at < cutoff) return;
    if (message.waId === null) {
      // A media webhook naming no customer: it completes its placeholder if one is stored,
      // and otherwise waits in history_media for the placeholder to arrive.
      if (message.content === null) return;
      const placeholder = this.sql
        .exec(`SELECT 1 FROM messages WHERE id = ? AND origin = 'history' AND type = 'media_placeholder'`, message.id)
        .toArray().length > 0;
      if (!placeholder) {
        this.sql.exec(
          `INSERT OR REPLACE INTO history_media (id, at, type, text, content) VALUES (?, ?, ?, ?, ?)`,
          message.id,
          message.at,
          message.type,
          message.text,
          message.content,
        );
        return;
      }
      this.sql.exec(
        `UPDATE messages SET type = ?, text = ?, content = ? WHERE id = ? AND origin = 'history' AND type = 'media_placeholder'`,
        message.type,
        message.text,
        message.content,
        message.id,
      );
      return;
    }
    if (erased.has(message.waId)) return;
    let stored = message;
    if (message.type === "media_placeholder") {
      const orphan = this.sql
        .exec(`SELECT type, text, content FROM history_media WHERE id = ?`, message.id)
        .toArray()[0];
      if (orphan) {
        this.sql.exec(`DELETE FROM history_media WHERE id = ?`, message.id);
        stored = {
          ...message,
          type: orphan.type as string,
          text: orphan.text as string | null,
          content: orphan.content as string | null,
        };
      }
    }
    this.sql.exec(
      `INSERT INTO messages
         (id, wa_id, direction, origin, type, text, content, at, status, target_id, phone_number_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET type = excluded.type, text = excluded.text, content = excluded.content
       WHERE messages.origin = 'history' AND messages.type = 'media_placeholder' AND excluded.content IS NOT NULL`,
      stored.id,
      stored.waId,
      stored.direction,
      stored.origin,
      stored.type,
      stored.text,
      stored.content,
      stored.at,
      stored.status,
      stored.targetId,
      stored.phoneNumberId,
      now,
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO contacts (wa_id, name, source, updated_at) VALUES (?, NULL, 'history', ?)`,
      stored.waId,
      now,
    );
  }

  /** The raw body of a sync payload, joined from its parts. */
  private syncPayloadBody(id: number): string {
    const chunks = this.sql
      .exec(`SELECT chunk FROM sync_payload_parts WHERE payload_id = ? ORDER BY ordinal`, id)
      .toArray()
      .map((row) => new Uint8Array(row.chunk as ArrayBuffer));
    const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  /**
   * Rebuilds the history and contact rows from the raw payloads: drops the history
   * messages and app-state names processing wrote, and clears every payload's progress,
   * so the alarm applies them all again. Live rows are untouched, and the rebuild yields
   * what the first pass did. Exposed as a method only; there is no public route.
   */
  reprocessSyncPayloads(): { payloads: number } {
    let payloads = 0;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM messages WHERE origin = 'history'`);
      this.sql.exec(`DELETE FROM history_media`);
      this.sql.exec(`DELETE FROM contacts WHERE source = 'history' AND wa_id NOT IN (SELECT wa_id FROM messages)`);
      this.sql.exec(`UPDATE contacts SET name = NULL WHERE source = 'app_state'`);
      this.sql.exec(`UPDATE sync_payloads SET cursor = 0, processed_at = NULL, error = NULL, attempts = 0`);
      payloads = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM sync_payloads`).one().n);
    });
    this.ctx.storage.setAlarm(Date.now());
    return { payloads };
  }

  /** Whether a media id is settled as stored. The R2 object alone is not enough: an erased id
   * keeps its object until the next purge. */
  isMediaStored(mediaId: string): boolean {
    return this.sql.exec(`SELECT 1 FROM media WHERE media_id = ? AND state = 'stored'`, mediaId).toArray().length > 0;
  }

  /** Cheap existence check — `LIMIT 1`, not a COUNT: the hold only needs to know
   * whether anything is waiting, and a target-less WABA can hold a lot of rows. */
  private hasPendingDeliveries(): boolean {
    return this.sql.exec(`SELECT 1 FROM deliveries WHERE status='pending' LIMIT 1`).toArray().length > 0;
  }

  /**
   * The media half of alarm(). Purges erased objects, then downloads one bounded
   * batch of media that messages reference and that is not yet settled. Nothing
   * here runs in a webhook request: ingest only schedules the alarm.
   *
   * Returns when the alarm must run again, or null when nothing is waiting.
   * Never throws: a media failure must not hold up deliveries or the sweep.
   */
  private async mediaStep(now: number): Promise<number | null> {
    const wakes: number[] = [];
    const due = this.dueMediaIds(now);
    if (due.length > 0) {
      const token = await this.metaToken();
      if (token === "unavailable") {
        wakes.push(now + MEDIA_RETRY_MS);
      } else if (token !== "missing") {
        try {
          await runBoundedPool(due, MEDIA_CONCURRENCY, (mediaId) => this.downloadOneMedia(mediaId, token));
          // Ids that arrived while this batch ran are due now. A webhook arms the alarm, but the
          // setAlarm at the end of this run would overwrite that, so come back at once.
          if (this.dueMediaIds(Date.now()).length > 0) wakes.push(now);
        } catch (error) {
          if (!(error instanceof MediaTokenError)) throw error;
          wakes.push(now + MEDIA_RETRY_MS);
        }
      }
      // "missing" is not retried on a timer: the WABA is not in the control plane, so no
      // retry can succeed. The next webhook or sync arms the alarm and this step runs again.
    }
    // Last, so an object the batch above wrote for a message erased meanwhile is deleted in this alarm.
    if (!(await this.purgeErasedMedia())) wakes.push(now + MEDIA_RETRY_MS);

    const next = this.sql
      .exec(`SELECT MIN(next_attempt_at) AS next FROM media WHERE state = 'failed'`)
      .toArray()[0]?.next;
    if (next != null) wakes.push(Number(next));
    return wakes.length > 0 ? Math.min(...wakes) : null;
  }

  /** Media ids a message references that need a download: no row yet, or a failed
   * attempt whose backoff has passed. Stored, given-up and erased ids never come back. */
  private dueMediaIds(now: number): string[] {
    return this.sql
      .exec(
        `SELECT DISTINCT json_extract(m.content, '$.media.id') AS media_id
         FROM messages m
         WHERE json_extract(m.content, '$.media.id') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM media d
             WHERE d.media_id = json_extract(m.content, '$.media.id')
               AND (d.state != 'failed' OR d.next_attempt_at > ?)
           )
         LIMIT ?`,
        now,
        MEDIA_BATCH,
      )
      .toArray()
      .map((row) => String(row.media_id));
  }

  /** The WABA's Meta token for the media downloads. `unavailable` when the lookup failed and
   * `missing` when the control plane does not know the WABA. Both are logged, and neither is
   * an attempt against a media id. */
  private async metaToken(): Promise<string | "missing" | "unavailable"> {
    try {
      const token = await getControlPlaneStub(this.env).getMetaAccessTokenForWaba(this.wabaIdForOps());
      if (token !== null) return token;
      this.logMedia("token-waba-missing");
      return "missing";
    } catch (error) {
      this.logMedia("token-lookup-failed", error);
      return "unavailable";
    }
  }

  private logMedia(event: string, error?: unknown): void {
    console.warn(
      JSON.stringify({
        level: "warn",
        area: "media",
        event,
        wabaId: this.wabaIdForOps(),
        ...(error === undefined ? {} : { error: String(error).slice(0, 200) }),
      }),
    );
  }

  /** Downloads one media id into R2 and records the outcome. Never throws: a failure
   * becomes a `failed` row with backoff, or a `gone` row once it cannot succeed. */
  private async downloadOneMedia(mediaId: string, token: string): Promise<void> {
    const now = Date.now();
    // Checked again here, with no await before the write: the due list was read before
    // the token lookup, and an overlapping run may have settled this id since.
    const prior = this.sql
      .exec(`SELECT state, attempts, next_attempt_at FROM media WHERE media_id = ?`, mediaId)
      .toArray()[0];
    if (prior && (prior.state !== "failed" || Number(prior.next_attempt_at) > now)) return;
    const attempts = Number(prior?.attempts ?? 0) + 1;

    let state: "stored" | "failed" | "gone" = "stored";
    let lastError: string | null = null;
    let nextAttemptAt: number | null = null;
    try {
      await downloadMetaMedia({
        bucket: this.env.MEDIA,
        wabaId: this.wabaIdForOps(),
        mediaId,
        token,
        graphVersion: this.env.META_GRAPH_VERSION?.trim() || "v25.0",
      });
    } catch (error) {
      // A rejected token is the WABA's fault, not the media's: nothing is recorded and no attempt counted.
      if (error instanceof MediaTokenError) throw error;
      if (isChecksumMismatch(error)) this.logMedia("checksum-mismatch");
      state = error instanceof MediaPermanentError || attempts >= MEDIA_MAX_ATTEMPTS ? "gone" : "failed";
      lastError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      nextAttemptAt = state === "failed" ? now + withJitter(backoffMs(attempts)) : null;
    }
    // The message may have been erased or pruned while the bytes were in flight. Then nothing
    // may be recorded as stored: the id is tombstoned, and the purge after this batch deletes
    // the object that was just written.
    if (!this.isReferenced(mediaId)) {
      this.markErased(mediaId, now);
      return;
    }
    this.sql.exec(
      `INSERT INTO media (media_id, state, attempts, last_error, next_attempt_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(media_id) DO UPDATE SET state = excluded.state, attempts = excluded.attempts,
         last_error = excluded.last_error, next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at`,
      mediaId,
      state,
      attempts,
      lastError,
      nextAttemptAt,
      now,
    );
  }

  /**
   * Deletes conversation history past the workspace's window. The window lives in
   * the control plane only, so it is read once per sweep here. NULL keeps everything,
   * and a failed lookup deletes nothing: an unknown window is never guessed.
   *
   * A contact left with no message is deleted as well, so a window does not keep
   * the names of conversations it has removed. An app-state contact is the phone's
   * address book, not a conversation, so it stays with or without messages.
   */
  async pruneConversations(now: number): Promise<void> {
    const days = await this.conversationRetentionDays();
    if (days == null) return;
    const cutoff = now - days * DAY_MS;
    this.ctx.storage.transactionSync(() => {
      const mediaIds = this.mediaIdsOf(`at < ?`, cutoff);
      this.sql.exec(`DELETE FROM messages WHERE at < ?`, cutoff);
      this.sql.exec(`DELETE FROM history_media WHERE at < ?`, cutoff);
      this.sql.exec(
        `DELETE FROM contacts WHERE source != 'app_state' AND wa_id NOT IN (SELECT wa_id FROM messages)`,
      );
      this.tombstoneUnreferencedMedia(mediaIds);
    });
  }

  /** Media ids referenced by the messages matching `where`. Read before the rows go. */
  private mediaIdsOf(where: string, ...params: unknown[]): string[] {
    return this.sql
      .exec(
        `SELECT DISTINCT json_extract(content, '$.media.id') AS media_id FROM messages
         WHERE (${where}) AND json_extract(content, '$.media.id') IS NOT NULL`,
        ...params,
      )
      .toArray()
      .map((row) => String(row.media_id));
  }

  /** Tombstones each media id that no remaining message references, so its R2 object
   * is deleted by `purgeErasedMedia`. Runs after the messages are deleted, inside the
   * same transaction, so an object is never left with no tombstone. */
  private tombstoneUnreferencedMedia(mediaIds: string[]): void {
    for (const mediaId of new Set(mediaIds)) {
      if (!this.isReferenced(mediaId)) this.markErased(mediaId, Date.now());
    }
  }

  private isReferenced(mediaId: string): boolean {
    return this.sql
      .exec(`SELECT 1 FROM messages WHERE json_extract(content, '$.media.id') = ? LIMIT 1`, mediaId)
      .toArray().length > 0;
  }

  private markErased(mediaId: string, now: number): void {
    this.sql.exec(
      `INSERT INTO media (media_id, state, attempts, last_error, next_attempt_at, updated_at)
       VALUES (?, 'erased', 0, NULL, NULL, ?)
       ON CONFLICT(media_id) DO UPDATE SET state = 'erased', next_attempt_at = NULL, updated_at = excluded.updated_at`,
      mediaId,
      now,
    );
  }

  /** Deletes the R2 objects of every tombstoned media id, then the tombstones. The rows go
   * first, so an object a concurrent download writes during the R2 call is tombstoned
   * afresh and caught by the next purge. Returns false when R2 refuses: the tombstones
   * are restored and the next attempt picks them up. */
  private async purgeErasedMedia(): Promise<boolean> {
    for (;;) {
      const ids = this.sql
        .exec(`SELECT media_id FROM media WHERE state = 'erased' LIMIT ?`, MEDIA_PURGE_BATCH)
        .toArray()
        .map((row) => String(row.media_id));
      if (ids.length === 0) return true;
      this.sql.exec(`DELETE FROM media WHERE media_id IN (${ids.map(() => "?").join(", ")})`, ...ids);
      try {
        await deleteMediaObjects(this.env.MEDIA, this.wabaIdForOps(), ids);
      } catch (error) {
        for (const mediaId of ids) this.markErased(mediaId, Date.now());
        console.warn(
          JSON.stringify({
            level: "warn",
            area: "media",
            event: "purge-failed",
            wabaId: this.wabaIdForOps(),
            error: String(error).slice(0, 200),
          }),
        );
        return false;
      }
    }
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
    // "manual", never "follow": validateSubscriberUrl vetted THIS url only, and
    // following a Location would let the subscriber point the gateway anywhere.
    // Not "error" either: workerd rejects it outright ("Invalid redirect
    // value"), so every forward threw before reaching the network (eccos-ugb6).
    // With "manual" the 3xx comes back as the response and is a failed attempt.
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(FORWARD_FETCH_TIMEOUT_MS),
    });
    const ok = res.ok;
    if (res.body) await res.body.cancel().catch(() => undefined);
    if (ok) return { ok: true, httpStatus: res.status };
    const redirected = res.status >= 300 && res.status < 400;
    return {
      ok: false,
      reason: `subscriber returned ${res.status}${redirected ? " (redirects are not followed)" : ""}`,
      httpStatus: res.status,
    };
  }

  private async processDelivery(row: DeliveryRow, maxAttempts: number): Promise<void> {
    let ok = false;
    let error: string | null = null;
    let httpStatus: number | null = null;
    const startedAt = Date.now();
    try {
      const outcome = await this.forwardOne(row.payload);
      ok = outcome.ok;
      httpStatus = outcome.httpStatus ?? null;
      if (!outcome.ok) error = outcome.reason;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const attempts = row.attempts + 1;
    // One line per attempt, never the payload: per-WABA volume, success rate and latency.
    // `durationMs` is the subscriber's answer time, `lagMs` the time since the webhook was stored.
    const attempt = {
      area: "forward",
      wabaId: this.wabaIdForOps(),
      phoneNumberId: row.phone_number_id,
      deliveryId: row.id,
      attempt: attempts,
      httpStatus,
      durationMs: Date.now() - startedAt,
      lagMs: Date.now() - row.created_at,
    };
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
    if (ok) {
      console.log(JSON.stringify({ level: "info", event: "delivered", ...attempt }));
      return;
    }
    const terminal = attempts >= maxAttempts;
    console.warn(
      JSON.stringify({
        level: "warn",
        event: terminal ? "delivery-failed" : "attempt-failed",
        ...attempt,
        error: error?.slice(0, 200) ?? null,
      }),
    );
    if (terminal) await this.alertTerminalFailure(row.phone_number_id, error);
  }

  /**
   * Counts `added` occurrences of an alert `kind` (a delivery that exhausted its
   * attempts, an inbound message dropped) and decides whether they earn an alert.
   * At most one alert per kind per OPS_ALERT_INTERVAL_MS; the occurrences in
   * between are counted and reported by the next alert, so a fault that lasts
   * all day costs 24 messages, not one per event.
   *
   * Synchronous SQL with no await between the read and the write: the six
   * concurrent forwards of one alarm run in this same object, and two of them
   * must not both decide to send.
   */
  recordOpsAlert(kind: "failure" | "drop", now: number, added = 1): { send: boolean; count: number } {
    const read = (key: string): number =>
      Number(this.sql.exec("SELECT value FROM ops_state WHERE key = ?", key).toArray()[0]?.value ?? 0);
    const write = (key: string, value: number): void => {
      this.sql.exec(
        "INSERT INTO ops_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        key,
        String(value),
      );
    };
    const count = read(`${kind}s_since_alert`) + added;
    if (now - read(`${kind}_alert_at`) < OPS_ALERT_INTERVAL_MS) {
      write(`${kind}s_since_alert`, count);
      return { send: false, count };
    }
    write(`${kind}_alert_at`, now);
    write(`${kind}s_since_alert`, 0);
    return { send: true, count };
  }

  /** Alerts the operator that inbound messages for this WABA parse to no event:
   * they lack `missing` (field names), so they are neither stored nor forwarded. */
  async alertDroppedMessages(dropped: number, missing: string, types: string): Promise<void> {
    const { send, count } = this.recordOpsAlert("drop", Date.now(), dropped);
    if (!send) return;
    await sendOpsAlert(
      this.env,
      [
        "Eccos: inbound messages are being dropped",
        `WABA ${this.wabaIdForOps()}`,
        `${count} ${count === 1 ? "message" : "messages"} since the last alert, neither stored nor forwarded`,
        `Latest: ${types} without ${missing}`,
        "Logs: event webhook_dropped",
      ].join("\n"),
    );
  }

  private async alertTerminalFailure(phoneNumberId: string | null, error: string | null): Promise<void> {
    const { send, count } = this.recordOpsAlert("failure", Date.now());
    if (!send) return;
    await sendOpsAlert(
      this.env,
      [
        "Eccos: deliveries are failing",
        `WABA ${this.wabaIdForOps()} · phone number id ${phoneNumberId ?? "unknown"}`,
        `${count} ${count === 1 ? "delivery" : "deliveries"} exhausted every retry since the last alert`,
        `Last error: ${error?.slice(0, 200) ?? "unknown"}`,
      ].join("\n"),
    );
  }

  /** The WABA this object serves, read off its idFromName name (gateway-stub.ts). */
  private wabaIdForOps(): string {
    return this.ctx.id.name?.split(":waba:")[1] ?? "unknown";
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

/**
 * The two facts a trail entry needs out of a stored event payload: WHEN Meta
 * says it happened, and — on a `failed` status — the Graph error code.
 *
 * Parsed here rather than shipped as raw payloads over the binding: a trail is
 * a handful of scalars per message, and sending whole event JSONs so the
 * console could pluck two fields would multiply a page's wire size for nothing.
 * A payload that will not parse falls back to `received_at`, Eccos' own clock —
 * later than Meta's by the callback's flight time, and honest about it.
 */
function readEventMoment(payload: string, receivedAt: number): { at: number; errorCode: string | null } {
  try {
    const event = JSON.parse(payload) as Record<string, unknown>;
    return {
      at: typeof event.at === "number" && Number.isFinite(event.at) ? event.at : receivedAt,
      errorCode: typeof event.errorCode === "string" ? event.errorCode : null,
    };
  } catch {
    return { at: receivedAt, errorCode: null };
  }
}

const MESSAGE_COLUMNS =
  "id, wa_id, direction, origin, type, text, content, at, status, error, target_id, phone_number_id";

/** The `(at, rowid)` of the last row a page keeps: the oldest one, in the newest-first query. */
function lastPosition(rows: Record<string, unknown>[], limit: number): Position {
  const row = rows[limit - 1];
  return { at: Number(row?.at), seq: Number(row?.seq) };
}

function toMessageRecord(row: Record<string, unknown>): MessageRecord {
  return {
    id: row.id as string,
    waId: row.wa_id as string,
    direction: row.direction as MessageDirection,
    origin: row.origin as MessageOrigin,
    type: row.type as string,
    text: (row.text as string | null) ?? null,
    content: (row.content as string | null) ?? null,
    at: Number(row.at),
    status: (row.status as MessageStatus | null) ?? null,
    error: (row.error as string | null) ?? null,
    targetId: (row.target_id as string | null) ?? null,
    phoneNumberId: (row.phone_number_id as string | null) ?? null,
  };
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
