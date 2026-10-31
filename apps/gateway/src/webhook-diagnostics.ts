import { messageDropReason } from "@eccos/core/parser";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import { WABA_ID_PATTERN } from "./control-plane";

// What the webhook logs say about a Meta payload. Names and counts only: never
// message content, phone numbers, user ids, profile names or payload values.

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function logName(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32) || "?" : "?";
}

/** Event counts by type, one log key each: `n_reply`, `n_status_read`, `n_message_image`, `n_message_echo_text`. */
export function eventCounts(events: WhatsAppCallbackEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ev of events) {
    const name =
      ev.type === "message" || ev.type === "message_echo"
        ? `${ev.type}_${logName(ev.messageType)}`
        : ev.type === "reply" || ev.type === "echo"
          ? ev.type
          : `status_${ev.type}`;
    counts[`n_${name}`] = (counts[`n_${name}`] ?? 0) + 1;
  }
  return counts;
}

/** The messages and echoes of one WABA that parse to no event. `missing` names the
 * required fields they lack (`from`, `to+id`); empty when they only carried nothing. */
export interface MessageDrops {
  wabaId: string;
  dropped: number;
  missing: string;
  types: string;
  keys: string;
}

export function messageDrops(payload: unknown): MessageDrops[] {
  const byWaba = new Map<string, { dropped: number; missing: Set<string>; types: Set<string>; keys: Set<string> }>();
  for (const entry of list(record(payload)?.entry)) {
    const wabaId = record(entry)?.id;
    if (typeof wabaId !== "string" || !WABA_ID_PATTERN.test(wabaId)) continue;
    for (const change of list(record(entry)?.changes)) {
      const { field, value } = record(change) ?? {};
      const echo = field === "smb_message_echoes";
      if (!echo && field !== undefined && field !== "messages") continue;
      for (const message of list(record(value)?.[echo ? "message_echoes" : "messages"])) {
        const reason = messageDropReason(message, echo);
        if (!reason) continue;
        const drops = byWaba.get(wabaId) ?? { dropped: 0, missing: new Set(), types: new Set(), keys: new Set() };
        byWaba.set(wabaId, drops);
        drops.dropped++;
        if (reason.startsWith("missing=")) for (const name of reason.slice(8).split("+")) drops.missing.add(name);
        drops.types.add(`${echo ? "echo_" : ""}${logName(record(message)?.type)}`);
        for (const key of Object.keys(record(message) ?? {})) drops.keys.add(logName(key));
      }
    }
  }
  return [...byWaba].map(([wabaId, drops]) => ({
    wabaId,
    dropped: drops.dropped,
    missing: [...drops.missing].sort().join("+"),
    types: [...drops.types].sort().join("+"),
    keys: [...drops.keys].sort().join("+").slice(0, 300),
  }));
}

/** The entry ids (WABA ids) a webhook names. */
export function webhookWabaIds(payload: unknown): string {
  const ids = list(record(payload)?.entry).map((entry) => record(entry)?.id);
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && WABA_ID_PATTERN.test(id)))].join(",");
}

/** Each change's `field` and value keys, each message's `type` and Meta error
 * codes, statuses by name, and for a message or echo that parses to no event its
 * type, what it lacks and its keys. */
export function webhookShape(payload: unknown): string {
  const parts = new Set<string>();
  for (const entry of list(record(payload)?.entry)) {
    for (const change of list(record(entry)?.changes)) {
      const { field, value } = record(change) ?? {};
      const fields = record(value);
      parts.add(`${typeof field === "string" ? field : "?"}:${Object.keys(fields ?? {}).sort().join("+")}`);
      for (const status of list(fields?.statuses)) parts.add(`status:${logName(record(status)?.status)}`);
      for (const message of list(fields?.messages)) {
        parts.add(`type:${logName(record(message)?.type)}`);
        for (const error of list(record(message)?.errors)) parts.add(`error:${record(error)?.code ?? "?"}`);
        addDropped(parts, message, false);
      }
      for (const echo of list(fields?.message_echoes)) addDropped(parts, echo, true);
    }
  }
  return [...parts].join(",").slice(0, 600);
}

function addDropped(parts: Set<string>, message: unknown, echo: boolean): void {
  const reason = messageDropReason(message, echo);
  if (!reason) return;
  const keys = Object.keys(record(message) ?? {}).sort().join("+");
  parts.add(`dropped:${logName(record(message)?.type)}:${reason};keys=${keys}`);
}
