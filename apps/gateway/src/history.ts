import { parseMetaWebhook } from "@eccos/core/parser";
import type { MessageStatus } from "@eccos/gateway-contract";
import { type NewMessage, messageFromEvent, waIdOf } from "./conversations";

type Json = Record<string, unknown>;

/** One history message, or a contact change, read out of a stored sync payload. */
export type SyncItem =
  | { kind: "message"; metadata: Json | null; business: string | null; threadId: string | null; raw: Json }
  | { kind: "contact"; action: string; contact: Json }
  | { kind: "error"; code: number };

/** A `messages` row built from history. `waId` is null for a media webhook that does not
 * name the customer; such a message can only complete a placeholder already stored. */
export interface HistoryMessage extends Omit<NewMessage, "waId"> {
  waId: string | null;
}

export type SyncUnit =
  | { kind: "message"; message: HistoryMessage }
  | { kind: "contact"; waId: string; name: string | null; action: "add" | "remove" }
  | { kind: "error"; code: number };

/** Meta's `history_context.status`, mapped onto the statuses an outbound message can carry. */
const HISTORY_STATUS: Record<string, MessageStatus> = {
  PENDING: "sent",
  SENT: "sent",
  DELIVERED: "delivered",
  READ: "read",
  PLAYED: "read",
  ERROR: "failed",
};

/** The flat list of history messages, contacts and errors in one payload, for one WABA.
 * Order is webhook order, which is what the resumable cursor counts through. Only
 * references are collected here: each item is mapped when it is applied. */
export function syncItems(payload: unknown, wabaId: string): SyncItem[] {
  const items: SyncItem[] = [];
  for (const entry of arrayOf(asRecord(payload)?.entry)) {
    const entryRecord = asRecord(entry);
    if (entryRecord?.id !== wabaId) continue;
    for (const change of arrayOf(entryRecord.changes)) {
      const changeRecord = asRecord(change);
      const value = asRecord(changeRecord?.value);
      if (!value) continue;
      const metadata = asRecord(value.metadata);
      const business = digitsOf(metadata?.display_phone_number);
      if (changeRecord?.field === "history") {
        for (const history of arrayOf(value.history)) {
          const historyRecord = asRecord(history);
          for (const error of arrayOf(historyRecord?.errors)) {
            const code = Number(asRecord(error)?.code);
            if (Number.isFinite(code)) items.push({ kind: "error", code });
          }
          for (const thread of arrayOf(historyRecord?.threads)) {
            const threadRecord = asRecord(thread);
            const threadId = digitsOf(threadRecord?.id);
            for (const message of arrayOf(threadRecord?.messages)) {
              const raw = asRecord(message);
              if (raw) items.push({ kind: "message", metadata, business, threadId, raw });
            }
          }
        }
        // A separate webhook carries media messages (with ids) in value.messages[].
        for (const message of arrayOf(value.messages)) {
          const raw = asRecord(message);
          if (raw) items.push({ kind: "message", metadata, business, threadId: null, raw });
        }
      } else if (changeRecord?.field === "smb_app_state_sync") {
        for (const state of arrayOf(value.state_sync)) {
          const stateRecord = asRecord(state);
          const contact = asRecord(stateRecord?.contact);
          if (contact && stateRecord?.type === "contact") {
            items.push({ kind: "contact", action: String(stateRecord.action), contact });
          }
        }
      }
    }
  }
  return items;
}

/** Maps one item to what the store applies, or null when it names no usable number or message. */
export function mapSyncItem(item: SyncItem, wabaId: string): SyncUnit | null {
  if (item.kind === "error") return item;
  if (item.kind === "contact") {
    if (item.action !== "add" && item.action !== "remove") return null;
    const waId = digitsOf(item.contact.phone_number);
    if (!waId) return null;
    const name = str(item.contact.full_name) ?? str(item.contact.first_name);
    return { kind: "contact", waId, name: item.action === "add" ? name : null, action: item.action };
  }
  // The live parser maps the message; a one-message webhook body keeps its rules (text, media, reactions).
  const event = parseMetaWebhook({
    object: "whatsapp_business_account",
    entry: [{ id: wabaId, changes: [{ value: { metadata: item.metadata, messages: [item.raw] } }] }],
  })[0];
  const parsed = event ? messageFromEvent(event) : null;
  if (!parsed) return null;
  const from = digitsOf(item.raw.from ?? item.raw.from_user_id);
  const to = digitsOf(item.raw.to ?? item.raw.to_user_id);
  // Inside a thread the customer is the thread, so anything sent by someone else is ours.
  // The display number only decides a message that names no thread.
  const outbound = item.threadId !== null ? from !== item.threadId : item.business !== null && from === item.business;
  const waId = item.threadId ?? (outbound ? to : from);
  return {
    kind: "message",
    message: {
      ...parsed,
      waId,
      // A business-sent message is an echo, the same as a live Business App reply; "out" is an API send.
      direction: outbound ? "echo" : "in",
      origin: "history",
      status: outbound ? historyStatus(item.raw.history_context) : null,
    },
  };
}

function historyStatus(context: unknown): MessageStatus {
  const status = str(asRecord(context)?.status)?.toUpperCase() ?? "";
  return HISTORY_STATUS[status] ?? "sent";
}

/** A phone number reduced to digits, or null when none is given. */
function digitsOf(value: unknown): string | null {
  const text = str(value);
  if (text === null) return null;
  const digits = waIdOf(text);
  return digits === "" ? null : digits;
}

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
