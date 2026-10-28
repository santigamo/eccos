import type { ConversationSummary, CursorPage, MessageRecord } from "../server/gateway";
import { normalizeSearchWabaId } from "./search";

/**
 * How the conversation inbox READS a stored message (`src/routes/conversations.tsx`).
 *
 * Pure, so every branch is asserted without a DOM, the same discipline as
 * `lib/logs.ts`. The stored `content` is the gateway's normalized JSON; nothing
 * here joins to a live record, so a reading is only ever what was stored.
 */

const MEDIA_TYPES = new Set(["image", "sticker", "audio", "video", "document"]);
const WA_ID_PATTERN = /^\+?[0-9][0-9 ()-]{3,31}$/;

/**
 * A customer's number as the URL and the server both take it: digits only, so
 * a pasted "+34 600 ..." reads the same as "34600...", or undefined. The URL
 * normalizes first, so a bad `?waId=` never reaches the gateway as a refusal
 * that would read as an outage.
 */
export function normalizeWaId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return WA_ID_PATTERN.test(trimmed) ? trimmed.replace(/\D/g, "") : undefined;
}

/**
 * The `?wabaId=` and `?waId=` a conversations URL carries. A bare id is read as the
 * JSON number the router makes of it (`?waId=34600111222`), so both forms select the same thread.
 */
export function conversationsSearch(search: Record<string, unknown>): { wabaId?: string; waId?: string } {
  const asText = (value: unknown) => (typeof value === "number" ? String(value) : value);
  return { wabaId: normalizeSearchWabaId(asText(search.wabaId)), waId: normalizeWaId(asText(search.waId)) };
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

const parsedContent = new WeakMap<MessageRecord, Json>();

/** The stored `content`, read defensively and parsed once per message: a row that will not parse reads as empty. */
export function contentOf(message: MessageRecord): Json {
  const cached = parsedContent.get(message);
  if (cached) return cached;
  let content: Json = {};
  if (message.content) {
    try {
      content = asRecord(JSON.parse(message.content)) ?? {};
    } catch {
      content = {};
    }
  }
  parsedContent.set(message, content);
  return content;
}

/**
 * The media a row points at. Inbound media keeps its id under `media`; a send
 * keeps Meta's request body, where the id sits on the typed object itself. A
 * send by link has no id, so it has no media to fetch.
 */
export function mediaIdOf(message: MessageRecord): string | null {
  if (!MEDIA_TYPES.has(message.type)) return null;
  const content = contentOf(message);
  return str(asRecord(content.media)?.id) ?? str(content.id);
}

export function mediaFilenameOf(message: MessageRecord): string | null {
  const content = contentOf(message);
  return str(asRecord(content.media)?.filename) ?? str(content.filename);
}

/** The console's own media route (`/media/<wabaId>/<mediaId>`), or null without both ids. */
export function mediaSrc(wabaId: string | undefined, mediaId: string | null): string | null {
  if (!wabaId || !mediaId) return null;
  return `/media/${encodeURIComponent(wabaId)}/${encodeURIComponent(mediaId)}`;
}

export interface LocationReading {
  latitude: number;
  longitude: number;
  name: string | null;
  address: string | null;
  mapHref: string;
}

export function locationOf(message: MessageRecord): LocationReading | null {
  const location = asRecord(contentOf(message).location);
  const latitude = location?.latitude;
  const longitude = location?.longitude;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  return {
    latitude,
    longitude,
    name: str(location?.name),
    address: str(location?.address),
    mapHref: `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`,
  };
}

export interface ContactReading {
  name: string;
  phones: string[];
}

/** Meta's contact cards, reduced to what an operator reads: a name and its numbers. */
export function contactsOf(message: MessageRecord): ContactReading[] {
  const { contacts } = contentOf(message);
  if (!Array.isArray(contacts)) return [];
  return contacts.map((contact: unknown) => {
    const card = asRecord(contact) ?? {};
    const phones = Array.isArray(card.phones) ? card.phones : [];
    return {
      name: str(asRecord(card.name)?.formatted_name) ?? "Unnamed contact",
      phones: phones.flatMap((phone) => {
        const number = str(asRecord(phone)?.phone);
        return number ? [number] : [];
      }),
    };
  });
}

/** The code Meta gave an unsupported message, as the gateway stored it. */
export function errorCodeOf(message: MessageRecord): string | null {
  return str(contentOf(message).errorCode);
}

/** The emoji a reaction carries; null is Meta's way of removing one. */
export function reactionEmojiOf(message: MessageRecord): string | null {
  return str(asRecord(contentOf(message).reaction)?.emoji);
}

export interface ThreadEntry {
  message: MessageRecord;
  /** What to show as the text: an edit's new text replaces the original. */
  text: string | null;
  edited: boolean;
  deleted: boolean;
  /** The emoji each sender's latest reaction carries; a sender holds at most one. */
  reactions: string[];
}

/**
 * The entries a reader sees, from a thread's messages oldest first.
 *
 * An edit, a revoke or a reaction names the message it acts on. When that
 * message is in the thread the act folds into it and stops being a row of its
 * own; when it is not, the act stays as a row, because it is still a fact the
 * operator should see. The newest edit wins, since the input is in time order,
 * and so does each sender's newest reaction: an empty one removes it.
 */
export function threadEntries(messages: MessageRecord[]): ThreadEntry[] {
  const rows = messages.map((message) => ({
    message,
    text: message.text,
    edited: false,
    deleted: false,
    reactedBy: new Map<string, string>(),
  }));
  const entries = new Map(rows.map((row) => [row.message.id, row]));
  const folded = new Set<string>();
  for (const message of messages) {
    const target = message.targetId ? entries.get(message.targetId) : undefined;
    if (!target) continue;
    if (message.type === "edit") {
      target.text = message.text;
      target.edited = true;
    } else if (message.type === "revoke") {
      target.deleted = true;
    } else if (message.type === "reaction") {
      // The customer is one sender; the business (sent or echoed from its app) is the other.
      const sender = message.direction === "in" ? "customer" : "business";
      const emoji = reactionEmojiOf(message);
      if (emoji) target.reactedBy.set(sender, emoji);
      else target.reactedBy.delete(sender);
    } else {
      continue;
    }
    folded.add(message.id);
  }
  return rows
    .filter((row) => !folded.has(row.message.id))
    .map(({ reactedBy, ...row }) => ({ ...row, reactions: [...reactedBy.values()] }));
}

/** Drops repeats, keeping the first occurrence: a page that shifted under a live refresh can overlap the one before it. */
export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** `name` when Meta gave one, the number otherwise. The number is written the way a person would dial it. */
export function conversationTitle(waId: string, name: string | null): string {
  return name ?? `+${waId}`;
}

/**
 * Who sent a stored message, as the thread labels it. Only a send through Eccos's
 * API is "Sent via Eccos"; a reply the staff wrote in the WhatsApp Business app,
 * live or imported from history, is not.
 */
export function senderLabelOf(message: Pick<MessageRecord, "direction" | "origin">): string {
  if (message.direction === "in") return "Customer";
  return message.direction === "out" && message.origin === "live"
    ? "Sent via Eccos"
    : "Sent from the WhatsApp Business app";
}

/** What a message without text is called, in the list and the thread alike. */
const TYPE_LABEL: Record<string, string> = {
  image: "Photo",
  sticker: "Sticker",
  audio: "Audio message",
  video: "Video",
  document: "Document",
  location: "Location",
  contacts: "Contact",
  reaction: "Reaction",
  edit: "Edited message",
  revoke: "Message deleted",
  unsupported: "Unsupported message",
  media_placeholder: "Media not available",
};

/** The last message as the list previews it: its text or caption, else what kind it is. The staff's own sends are marked as theirs. */
export function previewOf(last: ConversationSummary["lastMessage"]): string {
  const body = last.type === "revoke" ? "Message deleted" : (last.text ?? TYPE_LABEL[last.type] ?? last.type);
  return last.direction === "in" ? body : `You: ${body}`;
}

/**
 * How long ago, in words short enough for a list. Evidence keeps its exact
 * time (`fmtTsShort` on the thread); this is only the list's at-a-glance read.
 */
export function relativeTime(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/** Meta's customer service window: free text only within this long after the customer's last message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ServiceWindow {
  open: boolean;
  /** The window's state in a few words, as the composer shows it. */
  label: string;
}

/**
 * Whether free text may still be sent, and how long it has. `lastInboundAt` is
 * the customer's newest inbound message, or null when none was found: with no
 * such message there is no window to be open.
 */
export function serviceWindowOf(lastInboundAt: number | null, now: number): ServiceWindow {
  if (lastInboundAt === null || now - lastInboundAt >= SERVICE_WINDOW_MS) {
    return { open: false, label: "Window closed: templates only" };
  }
  const left = SERVICE_WINDOW_MS - (now - lastInboundAt);
  const hours = Math.floor(left / 3_600_000);
  const remaining = hours >= 1 ? `${hours} h` : `${Math.max(1, Math.ceil(left / 60_000))} min`;
  return { open: true, label: `Window open, ${remaining} left` };
}

/**
 * The window the composer shows. A free-text send Meta refused as closed shuts
 * the window for the inbound it was refused on, until the customer writes again.
 */
export function composerWindowOf(lastInboundAt: number | null, refusedAt: number | null, now: number): ServiceWindow {
  const refused = refusedAt !== null && refusedAt === lastInboundAt;
  return serviceWindowOf(refused ? null : lastInboundAt, now);
}

/** Whether a stored message is one the customer sent that opens or resets their window. System notices (Meta's own, such as a number change) do not. */
export function opensWindow(message: MessageRecord): boolean {
  return message.direction === "in" && message.type !== "system";
}

export interface ReplyLine {
  /** The number the reply goes out from; null when the thread names none. */
  phoneNumberId: string | null;
  /** The newest window-opening inbound on that number, or null when none is inside the window. */
  lastInboundAt: number | null;
}

/** Enter sends, Shift+Enter is a newline, and an Enter that ends an IME composition is left to the input. */
export function isSendKey(event: { key: string; shiftKey: boolean; isComposing: boolean }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

/** The number a thread is on: the newest message that names one. Replies go out from it. */
export function threadPhoneNumberId(items: MessageRecord[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const phoneNumberId = items[i]?.phoneNumberId;
    if (phoneNumberId) return phoneNumberId;
  }
  return null;
}
