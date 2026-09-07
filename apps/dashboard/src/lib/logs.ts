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

/** Records with a string index, told apart from arrays and from `null` — which
 * `typeof` calls an object and which every reader below would otherwise walk. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty string, or nothing. An empty string is not a value an operator
 * needs to see and would render as a labelled blank. */
function asText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * One value the stored request supplies, and the slot it fills.
 *
 * WHAT IS NOT HERE, AND CANNOT BE: a template's body text.
 * `outbound_messages.request` stores the Meta SEND body, which names the
 * template and carries the values — the copy itself only ever lived at Meta.
 * `{{1}} Ada` is therefore a record of what was sent; the same values poured
 * into the template as it stands TODAY would be a reconstruction, and a
 * template edited or deleted since would put words into a message that never
 * carried them. On a forensic surface that is the worst kind of wrong, because
 * it does not look wrong.
 */
export interface RequestValue {
  /** `{{1}}` · `{{order_id}}` · `Header` · `Button 1 URL`. */
  slot: string;
  /** Verbatim from the stored body. */
  value: string;
  /** A value COPIED rather than read — a link, a media id, a filename. Renders
   * monospace, the same rule `FactRow`'s `mono` follows. */
  mono: boolean;
}

export interface RequestReading {
  /** Meta's own message `type` from the stored request: `template`, `text`,
   * `image`… Not a console word — the request is what it is. */
  kind: string;
  /** Template identity, when the send is one. */
  template: { name: string | null; language: string | null } | null;
  /**
   * The message text ITSELF, on the sends that genuinely carry it: a free-form
   * `text` send through `POST /v1/wabas/:wabaId/messages` stores `text.body`,
   * and a media send stores its caption. A template send never does.
   */
  text: string | null;
  /** Every value the request supplies, in the order Meta renders them —
   * header, then body, then buttons. */
  values: RequestValue[];
}

/** The media kinds whose stored body the console reads. Listed rather than
 * derived: `interactive`, `location`, `contacts` and `reaction` have shapes
 * this does not pretend to summarise, and their raw body is right there. */
const MEDIA_KINDS = ["image", "video", "audio", "document", "sticker"];

/**
 * WHAT WAS SENT, read out of the stored Meta body.
 *
 * `null` when the body is empty (content retention swept it) or is not JSON at
 * all — both cases the caller says out loud rather than rendering an empty
 * section.
 */
export function requestReading(request: string): RequestReading | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(request);
  } catch {
    return null;
  }
  const body = asRecord(parsed);
  if (!body) return null;
  const reading: RequestReading = {
    kind: asText(body.type) ?? "message",
    template: null,
    text: null,
    values: [],
  };
  if (reading.kind === "template") readTemplateSend(body.template, reading);
  else if (reading.kind === "text") reading.text = asText(asRecord(body.text)?.body);
  else if (MEDIA_KINDS.includes(reading.kind)) readMediaSend(asRecord(body[reading.kind]), reading);
  return reading;
}

/** What one `parameters[]` entry actually carries. `null` for a shape this does
 * not read — the raw body below the section is the answer for those. */
function paramValue(param: Record<string, unknown>): { value: string; mono: boolean } | null {
  const text = asText(param.text);
  if (text) return { value: text, mono: false };
  const type = asText(param.type)?.toLowerCase() ?? "";
  const inner = asRecord(param[type]);
  if (!inner) return null;
  // A media parameter names the asset Meta fetches for itself — `{ type:
  // "image", image: { link } }`. The link (or the id) IS the value, and the
  // format travels with it because "https://…" alone does not say what Meta
  // put at the top of the message.
  const ref = asText(inner.link) ?? asText(inner.id);
  if (ref) {
    const filename = asText(inner.filename);
    return { value: `${type} · ${ref}${filename ? ` · ${filename}` : ""}`, mono: true };
  }
  // `currency` and `date_time` carry a `fallback_value`, which is exactly what
  // the recipient saw whenever Meta could not localize the parameter.
  const fallback = asText(inner.fallback_value);
  return fallback ? { value: fallback, mono: false } : null;
}

function readTemplateSend(template: unknown, reading: RequestReading): void {
  const record = asRecord(template);
  if (!record) return;
  reading.template = {
    name: asText(record.name),
    language: asText(asRecord(record.language)?.code),
  };
  if (!Array.isArray(record.components)) return;
  // Meta numbers body placeholders by POSITION, so the counter advances on
  // every parameter — including one this cannot read. Skipping a slot silently
  // would renumber every value after it and put the right text against the
  // wrong `{{n}}`.
  let positional = 0;
  let headerPositional = 0;
  for (const raw of record.components) {
    const component = asRecord(raw);
    if (!component) continue;
    const type = asText(component.type)?.toLowerCase() ?? "";
    const parameters = Array.isArray(component.parameters) ? component.parameters : [];
    for (const rawParam of parameters) {
      const param = asRecord(rawParam);
      if (!param) continue;
      const named = asText(param.parameter_name);
      let slot: string;
      // A button's fill is a URL fragment or a payload code — pasted, never
      // read as prose — so it takes the copy register whatever its parameter
      // type says.
      let mono = false;
      if (type === "header") {
        headerPositional += 1;
        // A media header has exactly one parameter and no placeholder to
        // name, so it is labelled by what it IS; a text header's placeholders
        // are numbered inside the header, not continuing the body's run.
        slot = asText(param.text) ? `Header {{${named ?? headerPositional}}}` : "Header";
      } else if (type === "button") {
        const index = Number(component.index ?? 0);
        const position = Number.isFinite(index) ? index + 1 : 1;
        slot = `Button ${position}${asText(component.sub_type)?.toLowerCase() === "url" ? " URL" : ""}`;
        mono = true;
      } else {
        positional += 1;
        slot = `{{${named ?? positional}}}`;
      }
      const value = paramValue(param);
      if (value) reading.values.push({ slot, value: value.value, mono: mono || value.mono });
    }
  }
}

function readMediaSend(media: Record<string, unknown> | null, reading: RequestReading): void {
  if (!media) return;
  // The caption IS the message the recipient reads; the asset is a reference
  // the operator copies. Two different registers, so two different fields.
  reading.text = asText(media.caption);
  const link = asText(media.link);
  const ref = link ?? asText(media.id);
  if (ref) reading.values.push({ slot: link ? "Link" : "Media id", value: ref, mono: true });
  const filename = asText(media.filename);
  if (filename) reading.values.push({ slot: "Filename", value: filename, mono: false });
}

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
 *
 * One parser, `requestReading`, behind both this and the sheet's readable
 * section — the grid's name for a message and the sheet's reading of it can
 * never disagree about which template a row is.
 */
export function messageSummary(id: number, request: string): MessageSummary {
  const reading = requestReading(request);
  return {
    ref: `#${id}`,
    kind: reading?.kind ?? "message",
    name: reading?.template?.name ?? null,
    language: reading?.template?.language ?? null,
  };
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
  /** What the customer wrote (a `reply`) or what Eccos' own send said (an
   * `echo`). Null on a status callback, which carries no text at all. */
  text: string | null;
  /** Meta's Graph error code on a `failed` status, e.g. `131047`. */
  errorCode: string | null;
  /** Meta's own sentence about that failure. It is Meta's words, shown as
   * evidence beside the code an operator will search for — not the console
   * speaking (data rule 7 governs what the CONSOLE claims, and it claims
   * nothing here). */
  errorMessage: string | null;
  /**
   * The event's OWN moment, from Meta's `timestamp` — when the phone received
   * it, when it was read, when the customer wrote. Not `received_at`, which is
   * when the callback reached Eccos; the two differ by flight time and the
   * first is the one an operator compares against a customer's screenshot.
   */
  at: number | null;
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
    text: null,
    errorCode: null,
    errorMessage: null,
    at: null,
    detail: null,
  };
  const event = (() => {
    try {
      return asRecord(JSON.parse(payload));
    } catch {
      return null;
    }
  })();
  if (!event) return reading;
  const from = asText(event.from);
  const to = asText(event.to);
  if (from) reading.party = { direction: "from", phone: from };
  else if (to) reading.party = { direction: "to", phone: to };
  if (typeof event.at === "number" && Number.isFinite(event.at)) reading.at = event.at;
  reading.text = asText(event.text);
  reading.errorCode = asText(event.errorCode);
  reading.errorMessage = asText(event.errorMessage);
  // `detail` is the ONE-LINE form the log grid shows, derived from the fields
  // above rather than parsed a second time: the sheet and the row it was opened
  // from cannot disagree about what an event says.
  if (reading.text) reading.detail = reading.text;
  else if (reading.errorCode || reading.errorMessage) {
    reading.detail = [reading.errorCode, reading.errorMessage]
      .filter((part): part is string => !!part)
      .join(" · ");
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
