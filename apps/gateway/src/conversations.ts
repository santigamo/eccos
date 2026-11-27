import { isBsuid } from "@eccos/core/bsuid";
import type { TemplateCopy } from "@eccos/core/template-copy";
import type { MessageContent, WhatsAppCallbackEvent } from "@eccos/core/types";
import type { MessageDirection, MessageOrigin, MessageRecord, MessageStatus } from "@eccos/gateway-contract";

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

/** Every `wa_id` is stored as the digits-only number Meta uses, or whole as the
 * BSUID (`US.1349…`) Meta sends for a customer whose number it withholds. */
export function waIdOf(id: string): string {
  return isBsuid(id) ? id : id.replace(/\D/g, "");
}

/** The phone number and BSUID one event names for the same customer; null unless it names both. */
export function customerPairOf(ev: WhatsAppCallbackEvent): { waId: string; userId: string } | null {
  const [id, userId] =
    ev.type === "reply" || ev.type === "message"
      ? [ev.from, ev.fromUserId]
      : ev.type === "echo" || ev.type === "message_echo"
        ? [ev.to, ev.toUserId]
        : [undefined, undefined];
  return pairOf(id, userId);
}

/** A phone/BSUID pair, when `id` is a phone number and `userId` a BSUID. */
export function pairOf(id: unknown, userId: unknown): { waId: string; userId: string } | null {
  if (typeof id !== "string" || typeof userId !== "string" || isBsuid(id) || !isBsuid(userId)) return null;
  const waId = waIdOf(id);
  return waId === "" ? null : { waId, userId };
}

/** The message an inbound (`reply`, `message`) or echo event adds; null for statuses. */
export function messageFromEvent(ev: WhatsAppCallbackEvent): NewMessage | null {
  if (ev.type !== "reply" && ev.type !== "echo" && ev.type !== "message" && ev.type !== "message_echo") return null;
  const outbound = ev.type === "echo" || ev.type === "message_echo";
  const fields: MessageContent =
    ev.type === "reply" || ev.type === "echo" ? { messageType: "text", text: ev.text } : ev;
  const inbound = ev.type === "reply" || ev.type === "message";
  const waId = inbound ? ev.from : ev.to;
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
    targetId: fields.reaction?.messageId ?? fields.originalMessageId ?? (inbound ? ev.replyTo : undefined) ?? null,
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
}): NewMessage & { template: TemplateSend | null } {
  const body = parseRecord(input.request) ?? {};
  const type = typeof body.type === "string" ? body.type : "unknown";
  const typed = asRecord(body[type]);
  // A reaction is stored the way the inbound reader reads one: `reaction.emoji`, folded by the message it names.
  const reactedId = type === "reaction" ? str(typed?.message_id) : null;
  return {
    id: input.id,
    waId: waIdOf(input.waId),
    direction: "out",
    origin: "live",
    type,
    text: outboundText(type, typed),
    content: reactedId
      ? JSON.stringify({ reaction: { messageId: reactedId, emoji: str(typed?.emoji) } })
      : type === "text" || !typed
        ? null
        : JSON.stringify(typed),
    at: input.at,
    status: "sent",
    targetId: reactedId ?? str(asRecord(body.context)?.message_id),
    phoneNumberId: input.phoneNumberId,
    template: type === "template" ? templateSendOf(typed) : null,
  };
}

/** A template send: the template it names and the parameters it filled. */
export interface TemplateSend {
  name: string;
  language: string;
  components: unknown;
}

/** A stored template message with what the customer read added under `copy`; its text becomes the filled body. */
export function withTemplateCopy(content: string | null, copy: TemplateCopy): { content: string; text: string } {
  const stored = (content && parseRecord(content)) ?? {};
  return { content: JSON.stringify({ ...stored, copy }), text: copy.body };
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

/** Text as the conversation shows it: a message's body, a media's caption. A template has none
 * until its copy is known (`withTemplateCopy`). */
function outboundText(type: string, typed: Record<string, unknown> | null): string | null {
  if (type === "text") return str(typed?.body);
  if (type === "template") return null;
  return str(typed?.caption);
}

function templateSendOf(template: Record<string, unknown> | null): TemplateSend | null {
  const name = str(template?.name);
  const language = str(asRecord(template?.language)?.code);
  return name && language ? { name, language, components: template?.components } : null;
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

export const MESSAGE_COLUMNS =
  "id, wa_id, direction, origin, type, text, content, at, status, error, target_id, phone_number_id";

export function toMessageRecord(row: Record<string, unknown>): MessageRecord {
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
