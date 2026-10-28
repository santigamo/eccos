import type { ConversationSummary, MessageRecord } from "../server/gateway";

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
 * A customer's number as the URL and the server both take it, or undefined.
 * The URL normalizes first, so a bad `?waId=` never reaches the gateway as a
 * refusal that would read as an outage.
 */
export function normalizeWaId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return WA_ID_PATTERN.test(normalized) ? normalized : undefined;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The stored `content`, read defensively: a row that will not parse reads as empty. */
export function contentOf(message: MessageRecord): Json {
  if (!message.content) return {};
  try {
    return asRecord(JSON.parse(message.content)) ?? {};
  } catch {
    return {};
  }
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
  /** Emoji reacted onto this message, in the order they arrived. */
  reactions: string[];
}

/**
 * The entries a reader sees, from a thread's messages oldest first.
 *
 * An edit, a revoke or a reaction names the message it acts on. When that
 * message is in the thread the act folds into it and stops being a row of its
 * own; when it is not, the act stays as a row, because it is still a fact the
 * operator should see. The newest edit wins, since the input is in time order.
 */
export function threadEntries(messages: MessageRecord[]): ThreadEntry[] {
  const rows: ThreadEntry[] = messages.map((message) => ({
    message,
    text: message.text,
    edited: false,
    deleted: false,
    reactions: [],
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
      const emoji = reactionEmojiOf(message);
      if (emoji) target.reactions.push(emoji);
    } else {
      continue;
    }
    folded.add(message.id);
  }
  return rows.filter((row) => !folded.has(row.message.id));
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

/** The last message as the list previews it. The staff's own sends are marked as theirs. */
export function previewOf(last: ConversationSummary["lastMessage"]): string {
  const body = last.type === "revoke" ? "Message deleted" : (last.text ?? last.type);
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
