/**
 * Scheduled sends: one template to one recipient at a set time, under a client key. Rows
 * live in the WABA's DO. The alarm sends them ahead of broadcasts (EccosGateway.scheduledStep).
 * A row is attempted at most once unless Meta says it was not sent; an unknown outcome is never
 * retried.
 */

import { metaErrorCodes } from "@eccos/core/send";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import { isRecipient, parseTemplate, recipientKey, STALE_SENDING_MS } from "./broadcasts";

export const MAX_PENDING_SCHEDULED = 50_000;
export const MAX_SCHEDULE_AHEAD_MS = 90 * 24 * 3600_000;
export const DEFAULT_EXPIRY_MS = 3600_000;
export const MAX_EXPIRY_AFTER_SEND_MS = 7 * 24 * 3600_000;
export const MAX_SCHEDULED_BODY_BYTES = 64 * 1024;
export const SCHEDULE_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

export type ScheduledStatus = "pending" | "sending" | "sent" | "failed" | "unknown" | "cancelled";
export type ScheduledFailure = "rejected" | "expired" | "unknown";

export interface ScheduledRequest {
  to: string;
  templateName: string;
  language: string;
  components?: unknown[];
  sendAt: number;
  expiresAt: number;
}

export type ParsedScheduled = { ok: true; request: ScheduledRequest } | { ok: false; error: string };

export interface ScheduledSend {
  key: string;
  status: ScheduledStatus;
  phoneNumberId: string;
  to: string;
  template: { name: string; language: string };
  sendAt: number;
  expiresAt: number;
  attempts: number;
  messageId: string | null;
  failureReason: ScheduledFailure | null;
  /** Meta's error envelope as stored (JSON text); the route parses it. */
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

type Row = Record<string, SqlStorageValue>;

/** Epoch ms, or an ISO 8601 time that carries its own offset. */
function parseInstant(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Validates a `PUT /scheduled/:key` body. A `sendAt` already past (but not expired) is due now. */
export function parseScheduledRequest(body: unknown, now: number): ParsedScheduled {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid body" };
  const record = body as Record<string, unknown>;
  if (typeof record.to !== "string" || !isRecipient(record.to.trim())) {
    return { ok: false, error: "to must be a phone number (5-15 digits) or a BSUID" };
  }
  const template = parseTemplate(record.template);
  if (!template.ok) return template;
  const sendAt = parseInstant(record.sendAt);
  if (sendAt === null) {
    return { ok: false, error: "sendAt must be epoch milliseconds or an ISO 8601 time with a timezone" };
  }
  if (sendAt > now + MAX_SCHEDULE_AHEAD_MS) return { ok: false, error: "sendAt can be at most 90 days ahead" };
  let expiresAt = sendAt + DEFAULT_EXPIRY_MS;
  if (record.expiresAt !== undefined) {
    const parsed = parseInstant(record.expiresAt);
    if (parsed === null) {
      return { ok: false, error: "expiresAt must be epoch milliseconds or an ISO 8601 time with a timezone" };
    }
    expiresAt = parsed;
  }
  if (expiresAt <= sendAt) return { ok: false, error: "expiresAt must be after sendAt" };
  if (expiresAt > sendAt + MAX_EXPIRY_AFTER_SEND_MS) {
    return { ok: false, error: "expiresAt can be at most 7 days after sendAt" };
  }
  if (expiresAt <= now) return { ok: false, error: "expiresAt is in the past" };
  return {
    ok: true,
    request: {
      to: record.to.trim(),
      templateName: template.name,
      language: template.language,
      ...(template.components ? { components: template.components } : {}),
      sendAt,
      expiresAt,
    },
  };
}

export const SCHEDULED_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS scheduled_sends (
    account_id      TEXT NOT NULL,
    key             TEXT NOT NULL,
    phone_number_id TEXT NOT NULL,
    recipient       TEXT NOT NULL,
    template_name   TEXT NOT NULL,
    language        TEXT NOT NULL,
    components      TEXT,
    status          TEXT NOT NULL,
    send_at         INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    message_id      TEXT,
    error           TEXT,
    reason          TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (account_id, key)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_sends (status, next_attempt_at);`,
  // Retention sweeps by settle time; unindexed it would scan every row hourly (billed as rows read).
  `CREATE INDEX IF NOT EXISTS idx_scheduled_updated ON scheduled_sends (updated_at);`,
];

const text = (value: SqlStorageValue | undefined): string | null => (value == null ? null : String(value));

export function toScheduled(row: Row): ScheduledSend {
  return {
    key: String(row.key),
    status: row.status as ScheduledStatus,
    phoneNumberId: String(row.phone_number_id),
    to: String(row.recipient),
    template: { name: String(row.template_name), language: String(row.language) },
    sendAt: Number(row.send_at),
    expiresAt: Number(row.expires_at),
    attempts: Number(row.attempts),
    messageId: text(row.message_id),
    failureReason: text(row.reason) as ScheduledFailure | null,
    error: text(row.error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function readScheduled(sql: SqlStorage, accountId: string, key: string): ScheduledSend | null {
  const row = sql.exec(`SELECT * FROM scheduled_sends WHERE account_id = ? AND key = ?`, accountId, key).toArray()[0];
  return row ? toScheduled(row) : null;
}

export function listScheduled(
  sql: SqlStorage,
  accountId: string,
  opts: { status?: ScheduledStatus; after?: string; limit: number },
): ScheduledSend[] {
  const params: (string | number)[] = [accountId, opts.after ?? ""];
  let filter = "";
  if (opts.status) {
    filter = "AND status = ?";
    params.push(opts.status);
  }
  params.push(opts.limit);
  return sql
    .exec(`SELECT * FROM scheduled_sends WHERE account_id = ? AND key > ? ${filter} ORDER BY key LIMIT ?`, ...params)
    .toArray()
    .map(toScheduled);
}

export type PutState = "created" | "replaced" | "not_pending" | "full";

/** Creates or replaces the row under `key`. Sent, sending and unknown rows may have reached the customer: they stay. */
export function upsertScheduled(
  sql: SqlStorage,
  input: { accountId: string; key: string; phoneNumberId: string; request: ScheduledRequest },
  now: number,
): { state: PutState; row: ScheduledSend | null } {
  const { accountId, key, phoneNumberId, request } = input;
  const existing = readScheduled(sql, accountId, key);
  if (existing && ["sending", "sent", "unknown"].includes(existing.status)) {
    return { state: "not_pending", row: existing };
  }
  const components = request.components ? JSON.stringify(request.components) : null;
  if (existing?.status === "pending") {
    sql.exec(
      `UPDATE scheduled_sends SET phone_number_id = ?, recipient = ?, template_name = ?, language = ?, components = ?,
         send_at = ?, expires_at = ?, next_attempt_at = ?, attempts = 0, error = NULL, updated_at = ? WHERE account_id = ? AND key = ?`,
      phoneNumberId, request.to, request.templateName, request.language, components,
      request.sendAt, request.expiresAt, request.sendAt, now, accountId, key,
    );
    return { state: "replaced", row: readScheduled(sql, accountId, key) };
  }
  const open = Number(
    sql.exec(`SELECT COUNT(*) AS n FROM scheduled_sends WHERE status IN ('pending', 'sending')`).toArray()[0]?.n ?? 0,
  );
  if (open >= MAX_PENDING_SCHEDULED) return { state: "full", row: null };
  sql.exec(
    `INSERT OR REPLACE INTO scheduled_sends (account_id, key, phone_number_id, recipient, template_name, language,
       components, status, send_at, expires_at, next_attempt_at, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, ?, ?)`,
    accountId, key, phoneNumberId, request.to, request.templateName, request.language, components,
    request.sendAt, request.expiresAt, request.sendAt, now, now,
  );
  return { state: "created", row: readScheduled(sql, accountId, key) };
}

export type CancelState = "cancelled" | "unchanged" | "not_pending" | "missing";

export function cancelScheduled(
  sql: SqlStorage,
  accountId: string,
  key: string,
  now: number,
): { state: CancelState; row: ScheduledSend | null } {
  const row = readScheduled(sql, accountId, key);
  if (!row) return { state: "missing", row: null };
  if (row.status === "cancelled" || row.status === "failed") return { state: "unchanged", row };
  if (row.status !== "pending") return { state: "not_pending", row };
  sql.exec(
    `UPDATE scheduled_sends SET status = 'cancelled', components = NULL, updated_at = ? WHERE account_id = ? AND key = ?`,
    now, accountId, key,
  );
  return { state: "cancelled", row: readScheduled(sql, accountId, key) };
}

/** What the failure event needs from a row that just ended. */
export type EndedRow = { account_id: string; key: string; recipient: string; phone_number_id: string };

/** Pending rows past `expires_at` end as failed/expired. `next_attempt_at <= expires_at` always holds, so the due index finds them. */
export function expireDue(sql: SqlStorage, now: number): EndedRow[] {
  return sql
    .exec(
      `UPDATE scheduled_sends SET status = 'failed', reason = 'expired', components = NULL, updated_at = ?
       WHERE status = 'pending' AND next_attempt_at <= ? AND expires_at <= ?
       RETURNING account_id, key, recipient, phone_number_id`,
      now, now, now,
    )
    .toArray() as EndedRow[];
}

/** Rows left `sending` by a run that died mid-send: Meta may have them, so they end as unknown. */
export function sweepStaleSending(sql: SqlStorage, now: number): EndedRow[] {
  return sql
    .exec(
      `UPDATE scheduled_sends SET status = 'unknown', reason = 'unknown', components = NULL, updated_at = ?
       WHERE status = 'sending' AND updated_at < ?
       RETURNING account_id, key, recipient, phone_number_id`,
      now, now - STALE_SENDING_MS,
    )
    .toArray() as EndedRow[];
}

/** Moves up to `limit` due rows to `sending`, earliest first. */
export function claimDue(sql: SqlStorage, now: number, limit: number): Row[] {
  return sql
    .exec(
      `UPDATE scheduled_sends SET status = 'sending', updated_at = ?
       WHERE (account_id, key) IN (
         SELECT account_id, key FROM scheduled_sends
         WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?)
       RETURNING *`,
      now, now, limit,
    )
    .toArray();
}

/** When the step next has work: the earliest pending attempt or the earliest stale `sending` row. */
export function nextScheduledWake(sql: SqlStorage): number | null {
  const row = sql
    .exec(
      `SELECT (SELECT MIN(next_attempt_at) FROM scheduled_sends WHERE status = 'pending') AS due,
              (SELECT MIN(updated_at) FROM scheduled_sends WHERE status = 'sending') AS sending`,
    )
    .toArray()[0];
  const wakes = [
    row?.due == null ? null : Number(row.due),
    row?.sending == null ? null : Number(row.sending) + STALE_SENDING_MS,
  ].filter((wake): wake is number => wake !== null);
  return wakes.length > 0 ? Math.min(...wakes) : null;
}

/** The `scheduled_failed` event for a row that ended without a send; `to` is digits-only like the rest of the stream. Error fields only when Meta answered. */
export function scheduledFailedEvent(
  row: Pick<EndedRow, "key" | "recipient" | "phone_number_id">,
  reason: ScheduledFailure,
  error: unknown,
  at: number,
): WhatsAppCallbackEvent {
  const { errorCode } = metaErrorCodes(error);
  const inner = (error as { error?: { message?: unknown; error_data?: { details?: unknown } } } | null)?.error;
  const message = inner?.error_data?.details ?? inner?.message;
  return {
    type: "scheduled_failed",
    scheduleKey: String(row.key),
    to: recipientKey(String(row.recipient)),
    reason,
    ...(errorCode !== null ? { errorCode: String(errorCode) } : {}),
    ...(typeof message === "string" ? { errorMessage: message } : {}),
    at,
    phoneNumberId: String(row.phone_number_id),
  };
}
