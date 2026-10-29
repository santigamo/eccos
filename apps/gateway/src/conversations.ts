import type { MessageContent, WhatsAppCallbackEvent } from "@eccos/core/types";
import type { MessageDirection, MessageOrigin, MessageStatus } from "@eccos/gateway-contract";

/** One row of the `messages` table, as the write paths produce it. */
export interface NewMessage {
  id: string;
  waId: string;
  direction: MessageDirection;
  origin: MessageOrigin;
  type: string;
  text: string | null;
  content: string | null;
  at: number;
  status: MessageStatus | null;
  targetId: string | null;
  phoneNumberId: string | null;
}

/** A status callback: the message it names and the status it moves that message to. */
export interface StatusUpdate {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  error: string | null;
}

/** The `MessageContent` fields that go into `messages.content`; the rest are columns. */
const CONTENT_KEYS = [
  "media",
  "location",
  "contacts",
  "reaction",
  "interactive",
  "order",
  "system",
  "originalMessageId",
  "errorCode",
  "errorMessage",
] as const satisfies readonly (keyof MessageContent)[];

/** Every `wa_id` is stored as the digits-only number Meta uses. */
export function waIdOf(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** The message an inbound (`reply`, `message`) or echo event adds; null for statuses. */
export function messageFromEvent(ev: WhatsAppCallbackEvent): NewMessage | null {
  if (ev.type !== "reply" && ev.type !== "echo" && ev.type !== "message" && ev.type !== "message_echo") return null;
  const outbound = ev.type === "echo" || ev.type === "message_echo";
  const fields: MessageContent =
    ev.type === "reply" || ev.type === "echo" ? { messageType: "text", text: ev.text } : ev;
  const waId = ev.type === "reply" || ev.type === "message" ? ev.from : ev.to;
  return {
    id: ev.messageId,
    waId: waIdOf(waId),
    direction: outbound ? "echo" : "in",
    origin: "live",
    type: fields.messageType,
    text: fields.text ?? fields.media?.caption ?? null,
    content: contentJson(fields),
    at: ev.at,
    status: outbound ? "sent" : null,
    targetId: fields.reaction?.messageId ?? fields.originalMessageId ?? null,
    phoneNumberId: ev.phoneNumberId ?? null,
  };
}

/** The message a successful send adds, read back from the Meta request body Eccos sent.
 * `waId` is the number Meta answered with, which may differ from the typed recipient. */
export function messageFromOutbound(input: {
  id: string;
  waId: string;
  request: string;
  phoneNumberId: string | null;
  at: number;
}): NewMessage {
  const body = parseRecord(input.request) ?? {};
  const type = typeof body.type === "string" ? body.type : "unknown";
  const typed = asRecord(body[type]);
  return {
    id: input.id,
    waId: waIdOf(input.waId),
    direction: "out",
    origin: "live",
    type,
    text: outboundText(type, typed),
    content: type === "text" || !typed ? null : JSON.stringify(typed),
    at: input.at,
    status: "sent",
    targetId: null,
    phoneNumberId: input.phoneNumberId,
  };
}

/** The status a sent/delivered/read/failed callback applies; null for every other event. */
export function statusFromEvent(ev: WhatsAppCallbackEvent): StatusUpdate | null {
  if (ev.type !== "sent" && ev.type !== "delivered" && ev.type !== "read" && ev.type !== "failed") return null;
  return {
    id: ev.transportMessageId,
    status: ev.type,
    error: ev.type === "failed" ? (ev.errorCode ?? ev.errorMessage ?? null) : null,
  };
}

/** Position of a row in the `(at, rowid)` order every conversation read uses. */
export interface Position {
  at: number;
  seq: number;
}

/** The first page starts after every row: `at` and `rowid` are both well below this. */
export const FIRST_POSITION: Position = { at: Number.MAX_SAFE_INTEGER, seq: Number.MAX_SAFE_INTEGER };

/** Opaque cursor: the position of the last row a page returned. `at` ties are common
 * (Meta timestamps are whole seconds), so the rowid breaks them. */
export function encodeCursor(position: Position): string {
  return btoa(`${position.at}:${position.seq}`);
}

export function decodeCursor(cursor: string | undefined): Position {
  if (cursor === undefined) return FIRST_POSITION;
  const match = /^(\d+):(\d+)$/.exec(atob(cursor));
  if (!match) throw new Error("invalid cursor");
  return { at: Number(match[1]), seq: Number(match[2]) };
}

function contentJson(fields: MessageContent): string | null {
  const content = Object.fromEntries(
    CONTENT_KEYS.filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]]),
  );
  return Object.keys(content).length > 0 ? JSON.stringify(content) : null;
}

/** Text as the conversation shows it: a template is labelled by its name, media by its caption. */
function outboundText(type: string, typed: Record<string, unknown> | null): string | null {
  if (type === "text") return str(typed?.body);
  if (type === "template") {
    const name = str(typed?.name);
    return name ? `template:${name}` : null;
  }
  return str(typed?.caption);
}

function parseRecord(json: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(json));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
