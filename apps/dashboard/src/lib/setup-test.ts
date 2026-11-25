import type { ConversationSummary, InboundRow, OutboundRow } from "@eccos/gateway-contract";
import { knownMetaError } from "./failure";
import { errorReading } from "./logs";

/**
 * How each setup path's live test reads its own success off the console's
 * existing reads. Pure, so every verdict is asserted without a DOM.
 *
 * `since` is when the test started. Meta stamps messages with its own clock,
 * so for paths A and C a message a little older than the browser's start still
 * counts. Path B compares two gateway stamps and needs no slack.
 */
export const CLOCK_SLACK_MS = 2 * 60_000;

export const TEST_MESSAGE = "Hello, this is a test";
export const TEST_REPLY = "Hi! We got your message.";

/** Digits only: what wa.me and the Cloud API take. */
export function digitsOf(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** The link a phone camera opens: WhatsApp, a chat with this number, the test message typed. */
export function waLink(phone: string, text = TEST_MESSAGE): string {
  return `https://wa.me/${digitsOf(phone)}?text=${encodeURIComponent(text)}`;
}

export type Arrived = { waId: string; text: string; at: number };

/** Path A: someone wrote to the number since the test started. */
export function arrivedMessage(conversations: ConversationSummary[], since: number): Arrived | null {
  const hit = conversations.find((c) => c.lastMessage.direction === "in" && c.lastMessage.at >= since - CLOCK_SLACK_MS);
  return hit ? { waId: hit.waId, text: hit.lastMessage.text ?? "", at: hit.lastMessage.at } : null;
}

/** `reason` is the console's words for Meta's error code, null when it has none. */
export type SendOutcome = { state: "waiting" } | { state: "delivered"; at: number } | { state: "failed"; reason: string | null };

/** Meta's own receipt: delivered (or read, which implies it) reached the phone. */
function outcomeOf(row: OutboundRow): SendOutcome {
  const reached = row.trail?.find((event) => event.type === "delivered" || event.type === "read");
  if (reached) return { state: "delivered", at: reached.at };
  const failed = row.trail?.find((event) => event.type === "failed");
  if (row.status === "failed" || failed) {
    const code = (row.error ? errorReading(row.error).code : null) ?? failed?.errorCode ?? null;
    return { state: "failed", reason: knownMetaError(code)?.title ?? null };
  }
  return { state: "waiting" };
}

/** Path A: the reply sent from the wizard, by its Meta message id. */
export function replyOutcome(rows: OutboundRow[], messageId: string): SendOutcome {
  const row = rows.find((r) => r.transport_message_id === messageId);
  return row ? outcomeOf(row) : { state: "waiting" };
}

/** Path C: a send to the operator's own phone since the test started, from their software or from here. */
export function sendToOutcome(rows: OutboundRow[], to: string, since: number): SendOutcome {
  const digits = digitsOf(to);
  const mine = rows.filter((r) => digitsOf(r.recipient) === digits && r.created_at >= since - CLOCK_SLACK_MS);
  const outcomes = mine.map(outcomeOf);
  return (
    outcomes.find((o) => o.state === "delivered") ??
    outcomes.find((o) => o.state === "failed") ??
    { state: "waiting" }
  );
}

/** Who wrote and what, from the stored event (`WhatsAppCallbackEvent`); blank when it cannot be read. */
export type Written = { from: string; text: string; at: number };

function writtenOf(row: InboundRow): Written {
  let event: { from?: unknown; text?: unknown } = {};
  try {
    event = JSON.parse(row.payload) ?? {};
  } catch {
    // A redacted or unreadable payload still counts; it just has nothing to show.
  }
  return {
    from: typeof event.from === "string" ? event.from : "",
    text: typeof event.text === "string" ? event.text : "",
    at: row.received_at,
  };
}

export type ForwardOutcome =
  | { state: "waiting" }
  /** A message came in; the tool has not answered yet. */
  | { state: "arrived"; message: Written }
  /** The tool answered 2xx. */
  | { state: "accepted"; at: number; message: Written }
  /** `httpStatus` is null when the address could not be reached at all. */
  | { state: "refused"; at: number; httpStatus: number | null; message: Written };

/** The kinds a person writes (`lib/setup-checklist.ts`): a status receipt is not a test message. */
const WRITTEN = new Set(["reply", "message"]);

/**
 * Path B: a message received after `since`, and what the tool answered when
 * Eccos forwarded it. `since` is the gateway's own save time, so a message held
 * from before the save and released by it never counts.
 */
export function forwardOutcome(rows: InboundRow[], since: number): ForwardOutcome {
  const mine = rows.filter((r) => WRITTEN.has(r.type) && r.received_at > since);
  const accepted = mine.find((r) => r.delivery_status === "delivered");
  if (accepted) {
    return { state: "accepted", at: accepted.delivery_finished_at ?? accepted.received_at, message: writtenOf(accepted) };
  }
  const refused = mine.find((r) => r.delivery_last_error);
  if (refused) {
    const code = /returned (\d{3})/.exec(refused.delivery_last_error as string)?.[1];
    return {
      state: "refused",
      at: refused.delivery_finished_at ?? refused.delivery_created_at ?? refused.received_at,
      httpStatus: code ? Number(code) : null,
      message: writtenOf(refused),
    };
  }
  const first = mine.at(-1);
  return first ? { state: "arrived", message: writtenOf(first) } : { state: "waiting" };
}

/** A clock time, as the phone shows it. */
export function shortTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A number as people read it: the display form when there is one, else `+digits`. */
export function plusNumber(waId: string): string {
  return waId.startsWith("+") ? waId : `+${waId}`;
}
