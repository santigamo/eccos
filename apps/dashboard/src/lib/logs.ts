/**
 * How the two log views READ a stored row.
 *
 * Pure, and split out of the routes for the reason `lib/health.ts` and
 * `lib/forwarding.ts` are: what a log says about a row is a rule, not
 * decoration, and every one of these has a branch that used to be quietly
 * wrong — so they are asserted without a DOM.
 *
 * Nothing here knows about the forward hop; that vocabulary lives in
 * `lib/forwarding.ts`. These functions describe what ARRIVED (an event) and
 * what WENT OUT (a message), and never mix the two hops in one sentence.
 */

/** The em-dash the grid uses wherever a cell has nothing to say. */
export const EMPTY_CELL = "—";

// --- Outbound: what Eccos asked Meta to send --------------------------------

export interface MessageSummary {
  /** `#1042` — the outbound row id, which is the only stable name a message
   * has inside the console. The wamid names it at META, and is 60 characters of
   * base64 that no operator reads aloud. */
  ref: string;
  /** Meta's own message `type` from the stored request: `template`, `text`,
   * `image`… Not a console word — the request is what it is. */
  kind: string;
  /** Template name, when the message is one. */
  name: string | null;
  /** Template language code (`es`, `en_US`). */
  language: string | null;
}

/**
 * The one line that identifies a message — the door on the Messages log, and
 * what a status event points back at on the Events log.
 *
 * Derived from `outbound_messages.request`, the Meta body exactly as sent, so
 * the console never stores a second copy of the same fact. A body it cannot
 * parse still yields a usable line: the id always works, which is the point of
 * leading with it.
 */
export function messageSummary(id: number, request: string): MessageSummary {
  const summary: MessageSummary = { ref: `#${id}`, kind: "message", name: null, language: null };
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(request) as Record<string, unknown>;
  } catch {
    return summary;
  }
  if (typeof body.type === "string" && body.type) summary.kind = body.type;
  const template = body.template;
  if (template && typeof template === "object") {
    const t = template as { name?: unknown; language?: unknown };
    if (typeof t.name === "string") summary.name = t.name;
    const language = t.language;
    if (language && typeof language === "object") {
      const code = (language as { code?: unknown }).code;
      if (typeof code === "string") summary.language = code;
    }
  }
  return summary;
}

/** `#1042 · template cita_encontrada · es`. The separator is the console's
 * existing `·`, and every part that is unknown simply drops out rather than
 * rendering a placeholder. */
export function messageSummaryText(summary: MessageSummary): string {
  const kind = summary.name ? `${summary.kind} ${summary.name}` : summary.kind;
  return [summary.ref, kind, summary.language].filter((part): part is string => !!part).join(" · ");
}

/** The short form a status event uses to point at its message: `#1042
 * cita_encontrada`. No language and no kind — the event log's PARTY column
 * answers "which of my sends is this about", not "what was in it". */
export function messageRefText(summary: MessageSummary): string {
  return summary.name ? `${summary.ref} ${summary.name}` : summary.ref;
}

// --- Inbound: what arrived from Meta ----------------------------------------

/**
 * Which family an event kind belongs to. Rendered as INK WEIGHT, never as
 * colour: `reply` and `echo` are the rows an operator scans a page of statuses
 * looking for, and colour is reserved by data rule 1 for state that has to be
 * acted on. Only `problem` spends red, because a failed send is exactly that.
 */
export type EventFamily = "message" | "status" | "problem";

export interface EventReading {
  /** The event's own word — `reply`, `echo`, `delivered`, `read`, `failed`.
   * Meta→phone vocabulary; a forward state never appears here. */
  kind: string;
  family: EventFamily;
  /**
   * Who the event concerns, when the event itself says: a reply carries `from`
   * and an echo carries `to`. A status callback carries neither — it names a
   * wamid — so this is null there and the log points at the message instead.
   *
   * The column this fills did not exist. The old Inbound log showed
   * `phone_number_id`, the workspace's OWN number, identical on every row.
   */
  party: { direction: "from" | "to"; phone: string } | null;
  /**
   * The row's content, in one string. Message text for a reply or an echo;
   * `131047 · Re-engagement message` for a failure. Null for a plain status,
   * which genuinely has nothing to show — and never, ever a wamid, which is
   * what the column headed "Summary" used to print on most rows.
   */
  detail: string | null;
}

const EVENT_FAMILIES: Record<string, EventFamily> = {
  reply: "message",
  echo: "message",
  delivered: "status",
  read: "status",
  failed: "problem",
};

export function eventReading(type: string, payload: string): EventReading {
  const reading: EventReading = {
    kind: type,
    family: EVENT_FAMILIES[type] ?? "status",
    party: null,
    detail: null,
  };
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return reading;
  }
  if (typeof event.from === "string" && event.from) {
    reading.party = { direction: "from", phone: event.from };
  } else if (typeof event.to === "string" && event.to) {
    reading.party = { direction: "to", phone: event.to };
  }
  if (typeof event.text === "string" && event.text) {
    reading.detail = event.text;
    return reading;
  }
  const code = typeof event.errorCode === "string" ? event.errorCode : null;
  const message = typeof event.errorMessage === "string" ? event.errorMessage : null;
  if (code || message) {
    reading.detail = [code, message].filter((part): part is string => !!part).join(" · ");
  }
  return reading;
}

/**
 * The last of a wamid, for the case where a status event names a message the
 * console cannot find — a send made outside Eccos, or one already past the
 * content-retention window.
 *
 * The tail rather than the head: Meta's wamids share a long constant prefix, so
 * the first characters distinguish nothing while the last ones are what a
 * developer greps their own logs for.
 */
export function wamidTail(wamid: string): string {
  return wamid.length <= 14 ? wamid : `…${wamid.slice(-12)}`;
}

/**
 * JSON as an operator reads it — two-space indent, or the raw string back when
 * it will not parse.
 *
 * Never throws and never renders "undefined": both sheets show stored text that
 * a retention sweep may have emptied, and the honest answer to unparseable
 * storage is the storage itself.
 */
export function prettyJson(raw: string): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * The label an event kind takes in a COUNT. `reply` and `echo` are countable
 * things and get their plural; `delivered` / `read` / `failed` describe a
 * message and never take one — "55 reads" is a different noun and "2
 * delivereds" is not a word.
 */
const EVENT_PLURALS: Record<string, string> = { reply: "replies", echo: "echoes" };

/** The noun for `n` events of one kind. One table, two callers: the count row
 * above the log and the queue's per-batch summary. */
export function eventKindNoun(kind: string, n: number): string {
  return n === 1 ? kind : EVENT_PLURALS[kind] ?? kind;
}

/** The count row's label, which is a CATEGORY name and so always plural where
 * the kind has one — `replies 0` names the category, `reply 0` would read as a
 * broken sentence. */
export function eventCountLabel(kind: string): string {
  return eventKindNoun(kind, 2);
}

export interface EventCountEntry {
  kind: string;
  label: string;
  n: number;
  family: EventFamily;
}

/**
 * THE SENTENCE THAT KILLS THE MISREAD, as ordered entries.
 *
 * A workspace with two template sends and no customer traffic used to read
 * "2 inbound events" on a page called Inbound — which says two people wrote in.
 * Spelled out it reads `2 events · replies 0 · echoes 0 · delivered 2`, and the
 * misreading is impossible.
 *
 * `reply` and `echo` are listed EVEN AT ZERO, and that is the whole design:
 * their zero is the information. A status kind at zero is not — nobody needs to
 * be told that no read receipts have arrived — so it drops out, and the row
 * stays short on a young workspace.
 *
 * Order is fixed rather than by count: the two kinds that mean a human did
 * something lead, always, so an operator's eye lands in the same place on every
 * workspace.
 */
const EVENT_COUNT_ORDER = ["reply", "echo", "delivered", "read", "failed"];

export function eventCountEntries(byType: Record<string, number>): EventCountEntry[] {
  const seen = new Set<string>();
  const entries: EventCountEntry[] = [];
  const push = (kind: string, n: number) => {
    if (seen.has(kind)) return;
    seen.add(kind);
    entries.push({ kind, label: eventCountLabel(kind), n, family: EVENT_FAMILIES[kind] ?? "status" });
  };
  for (const kind of EVENT_COUNT_ORDER) {
    const n = byType[kind] ?? 0;
    if (n > 0 || kind === "reply" || kind === "echo") push(kind, n);
  }
  // Anything the parser learns to emit later still shows up, rather than
  // silently vanishing from a total it is part of.
  for (const [kind, n] of Object.entries(byType)) {
    if (n > 0) push(kind, n);
  }
  return entries;
}
