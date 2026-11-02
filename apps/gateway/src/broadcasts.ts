/**
 * Broadcasts: one approved template sent to many recipients, paced by the
 * gateway. The rows live in the WABA's Durable Object; the alarm drains them
 * at the account's send rate (see EccosGateway.broadcastStep).
 *
 * A recipient is attempted at most once unless Meta says it was NOT sent
 * (throttling). An unknown outcome (no answer, 5xx) is never retried, so a
 * broadcast can never message anyone twice.
 */

import { isBsuid } from "@eccos/core/bsuid";
import type { MetaErrorCodes } from "@eccos/core/send";

export const MAX_BROADCAST_RECIPIENTS = 10_000;
/** Sending rows older than this belong to a run that died mid-send: their outcome is unknown. */
export const STALE_SENDING_MS = 60_000;
/** Throttled attempts before a recipient is given up as failed. */
export const MAX_THROTTLED_ATTEMPTS = 8;

export type BroadcastStatus = "running" | "completed" | "cancelled" | "halted";
export type RecipientStatus = "queued" | "sending" | "sent" | "failed" | "unknown" | "cancelled";

export interface BroadcastRequest {
  templateName: string;
  language: string;
  recipients: { to: string; components?: unknown[] }[];
}

export type ParsedBroadcast =
  | { ok: true; request: BroadcastRequest; duplicates: number }
  | { ok: false; error: string; invalid?: { index: number; error: string }[] };

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

function isRecipient(to: string): boolean {
  if (isBsuid(to)) return true;
  const digits = to.replace(/\D/g, "").length;
  return /^\+?[0-9][0-9 ().-]*$/.test(to) && digits >= 5 && digits <= 15;
}

/** The same customer written two ways ("+34 600…" and "34600…") is one recipient. */
function recipientKey(to: string): string {
  return isBsuid(to) ? to : to.replace(/\D/g, "");
}

/**
 * Validates a `POST /broadcasts` body. Every recipient must be valid or the
 * whole request is refused (with up to 100 indexes), so a typo never turns into
 * a half-sent campaign. Repeated recipients are dropped, keeping the first.
 */
export function parseBroadcastRequest(body: unknown): ParsedBroadcast {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid body" };
  const record = body as Record<string, unknown>;
  const template = record.template as { name?: unknown; language?: unknown; components?: unknown } | undefined;
  if (!template || typeof template !== "object") return { ok: false, error: "template is required" };
  if (typeof template.name !== "string" || !TEMPLATE_NAME.test(template.name)) {
    return { ok: false, error: "template.name must be a template name" };
  }
  const language =
    typeof template.language === "string"
      ? template.language
      : (template.language as { code?: unknown } | undefined)?.code;
  if (typeof language !== "string" || !LANGUAGE.test(language)) {
    return { ok: false, error: "template.language.code must be a language code such as es or en_US" };
  }
  if (template.components !== undefined && !Array.isArray(template.components)) {
    return { ok: false, error: "template.components must be an array" };
  }
  const defaults = template.components as unknown[] | undefined;
  if (!Array.isArray(record.recipients) || record.recipients.length === 0) {
    return { ok: false, error: "recipients must be a non-empty array" };
  }
  if (record.recipients.length > MAX_BROADCAST_RECIPIENTS) {
    return { ok: false, error: `a broadcast can have at most ${MAX_BROADCAST_RECIPIENTS} recipients` };
  }

  const invalid: { index: number; error: string }[] = [];
  const seen = new Set<string>();
  const recipients: BroadcastRequest["recipients"] = [];
  let duplicates = 0;
  record.recipients.forEach((entry, index) => {
    const item = entry as { to?: unknown; components?: unknown } | null;
    if (!item || typeof item !== "object" || typeof item.to !== "string" || !isRecipient(item.to.trim())) {
      invalid.push({ index, error: "to must be a phone number (5-15 digits) or a BSUID" });
      return;
    }
    if (item.components !== undefined && !Array.isArray(item.components)) {
      invalid.push({ index, error: "components must be an array" });
      return;
    }
    const to = item.to.trim();
    const key = recipientKey(to);
    if (seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);
    const components = (item.components as unknown[] | undefined) ?? defaults;
    recipients.push({ to, ...(components ? { components } : {}) });
  });
  if (invalid.length > 0) {
    return { ok: false, error: "some recipients are invalid", invalid: invalid.slice(0, 100) };
  }
  return { ok: true, request: { templateName: template.name, language, recipients }, duplicates };
}

/** The Meta message body for one recipient. */
export function recipientMessage(
  templateName: string,
  language: string,
  to: string,
  components: unknown[] | null,
): Record<string, unknown> {
  return {
    to,
    type: "template",
    template: { name: templateName, language: { code: language }, ...(components ? { components } : {}) },
  };
}

export type SendVerdict =
  /** Meta said it was not sent and to slow down: queue it again. */
  | "throttled"
  /** Meta may have sent it: never retried. */
  | "unknown"
  /** Nothing in this broadcast can succeed (token, account, template): stop it. */
  | "halt"
  /** This recipient failed; the rest carry on. */
  | "failed";

const THROTTLE_CODES = new Set([4, 80007, 130429, 131056]);
/** Token, permission, account, payment and template errors: the same for every recipient. */
const HALT_CODES = new Set([10, 190, 200, 131031, 131042, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 133010]);

export function classifySendFailure(status: number, unknown: boolean, codes: MetaErrorCodes): SendVerdict {
  if (status === 429 || (codes.errorCode !== null && THROTTLE_CODES.has(codes.errorCode))) return "throttled";
  if (unknown) return "unknown";
  if (codes.errorCode !== null && HALT_CODES.has(codes.errorCode)) return "halt";
  return "failed";
}

/** Seconds to wait after the nth throttled attempt: 5, 10, 20… up to 5 minutes. */
export function throttleDelayMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 300_000);
}

/** Sends per one-second tick for a per-minute rate. */
export function sendsPerTick(ratePerMinute: number): number {
  return Math.max(1, Math.floor(ratePerMinute / 60));
}

export const BROADCAST_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS broadcasts (
    id              TEXT PRIMARY KEY,
    account_id      TEXT NOT NULL,
    phone_number_id TEXT NOT NULL,
    template_name   TEXT NOT NULL,
    language        TEXT NOT NULL,
    status          TEXT NOT NULL,
    total           INTEGER NOT NULL,
    duplicates      INTEGER NOT NULL,
    rate_per_minute INTEGER NOT NULL,
    idempotency_key TEXT,
    body_hash       TEXT NOT NULL,
    halt_reason     TEXT,
    next_send_at    INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    finished_at     INTEGER
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_broadcasts_key
    ON broadcasts (account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;`,
  `CREATE TABLE IF NOT EXISTS broadcast_recipients (
    broadcast_id TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    recipient    TEXT NOT NULL,
    components   TEXT,
    status       TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    message_id   TEXT,
    error        TEXT,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (broadcast_id, seq)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_status
    ON broadcast_recipients (broadcast_id, status, seq);`,
];

export interface BroadcastSummary {
  id: string;
  status: BroadcastStatus;
  phoneNumberId: string;
  template: { name: string; language: string };
  total: number;
  duplicatesSkipped: number;
  ratePerMinute: number;
  counts: Record<RecipientStatus, number>;
  /** Meta's later receipts for the messages that were sent. */
  delivery: { delivered: number; read: number; failed: number };
  haltReason: string | null;
  createdAt: number;
  finishedAt: number | null;
}

const EMPTY_COUNTS: Record<RecipientStatus, number> = {
  queued: 0,
  sending: 0,
  sent: 0,
  failed: 0,
  unknown: 0,
  cancelled: 0,
};

export function readBroadcast(sql: SqlStorage, id: string): BroadcastSummary | null {
  const row = sql.exec(`SELECT * FROM broadcasts WHERE id = ?`, id).toArray()[0];
  if (!row) return null;
  const counts = { ...EMPTY_COUNTS };
  for (const entry of sql
    .exec(`SELECT status, COUNT(*) AS n FROM broadcast_recipients WHERE broadcast_id = ? GROUP BY status`, id)
    .toArray()) {
    counts[entry.status as RecipientStatus] = Number(entry.n);
  }
  const delivery = { delivered: 0, read: 0, failed: 0 };
  for (const entry of sql
    .exec(
      `SELECT e.type AS type, COUNT(DISTINCT e.transport_message_id) AS n
       FROM broadcast_recipients r JOIN inbound_events e ON e.transport_message_id = r.message_id
       WHERE r.broadcast_id = ? AND r.message_id IS NOT NULL AND e.type IN ('delivered', 'read', 'failed')
       GROUP BY e.type`,
      id,
    )
    .toArray()) {
    delivery[entry.type as keyof typeof delivery] = Number(entry.n);
  }
  return {
    id: String(row.id),
    status: row.status as BroadcastStatus,
    phoneNumberId: String(row.phone_number_id),
    template: { name: String(row.template_name), language: String(row.language) },
    total: Number(row.total),
    duplicatesSkipped: Number(row.duplicates),
    ratePerMinute: Number(row.rate_per_minute),
    counts,
    delivery,
    haltReason: row.halt_reason === null ? null : String(row.halt_reason),
    createdAt: Number(row.created_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
  };
}

export interface BroadcastRecipientRow {
  seq: number;
  to: string;
  status: RecipientStatus;
  messageId: string | null;
  /** Meta's error envelope as stored (JSON text); the route parses it. */
  error: string | null;
  attempts: number;
}

export function readRecipients(
  sql: SqlStorage,
  id: string,
  opts: { status?: RecipientStatus; after?: number; limit: number },
): BroadcastRecipientRow[] {
  const params: (string | number)[] = [id, opts.after ?? -1];
  let filter = "";
  if (opts.status) {
    filter = "AND status = ?";
    params.push(opts.status);
  }
  params.push(opts.limit);
  return sql
    .exec(
      `SELECT seq, recipient, status, message_id, error, attempts FROM broadcast_recipients
       WHERE broadcast_id = ? AND seq > ? ${filter} ORDER BY seq LIMIT ?`,
      ...params,
    )
    .toArray()
    .map((row) => ({
      seq: Number(row.seq),
      to: String(row.recipient),
      status: row.status as RecipientStatus,
      messageId: row.message_id === null ? null : String(row.message_id),
      error: row.error === null ? null : String(row.error),
      attempts: Number(row.attempts),
    }));
}

/** A stored error back as Meta's object, or the text when it is not JSON. */
export function parseStoredError(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
