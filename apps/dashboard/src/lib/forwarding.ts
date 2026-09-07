import type { LastForward, SubscriberConfig } from "@eccos/gateway-contract";
import { eventKindNoun } from "./logs";

/**
 * How the Webhooks page reads the forwarding state. Pure, so the two rules that
 * are easy to get quietly wrong can be asserted without a DOM.
 */

/** The header tag. A FACT about configuration, never a switch — Eccos has no
 * pause semantics, so there is nothing here to toggle. */
export function forwardingTag(config: SubscriberConfig): "forwarding" | "no target" {
  return config.url === null ? "no target" : "forwarding";
}

export interface LastForwardReading {
  /** The delivery row's own status, as the log shows it. */
  status: string;
  /**
   * Which moment `at` is. THE RULE THIS MODULE EXISTS FOR: a row with
   * `finishedAt: null` has not finished — it is queued, held for want of a
   * target, or between retries — and its only timestamp is when the batch
   * ARRIVED. Reporting that as a completion turns "queued 15 days ago" into
   * "delivered 15 days ago", which is the confusion `finished_at` was added to
   * end. Never fall back from one to the other.
   */
  moment: "queued" | "finished";
  /** Epoch ms of whichever moment `moment` names. */
  at: number;
  /** Attempts spent. `0` on a row nothing has been tried against — which is
   * what a held row looks like, and it is not a failure. */
  attempts: number;
  /** Verbatim from `deliveries.last_error`; only ever set on a real attempt. */
  lastError: string | null;
}

export function readLastForward(last: LastForward | null): LastForwardReading | null {
  if (!last) return null;
  const finished = last.finishedAt !== null;
  return {
    status: last.status,
    moment: finished ? "finished" : "queued",
    at: finished ? (last.finishedAt as number) : last.createdAt,
    attempts: last.attempts,
    lastError: last.lastError,
  };
}

/**
 * ── THE FORWARD HOP, IN ITS OWN WORDS ───────────────────────────────────────
 *
 * `deliveries.status` is `pending` / `delivered` / `failed`, and the console
 * used to print those verbatim. Two of them were already taken: `delivered` is
 * ALSO a Meta status meaning the customer's phone received a message, and both
 * words appeared on the same screen meaning different things. The database
 * vocabulary is the forwarding contract and does not move; the console
 * translates, and nothing below ever says `delivered` about a forward again.
 *
 * `pending` splits into three readings that a single word cannot carry, and the
 * split is the whole reason this function exists:
 *
 *  - `held` — no forwarding target is configured, so `alarm()` deliberately
 *    holds the drain (`apps/gateway/src/gateway.ts`). Nothing has been
 *    attempted and nothing has failed. Rendering that as "pending" with an
 *    attempt count of 0 and a next-attempt time in the past is
 *    indistinguishable from a stuck queue, which is what it looked like.
 *  - `queued` — a target exists and this batch has not been tried yet. Neutral:
 *    it is the ordinary state of a healthy queue for a few seconds.
 *  - `retrying n/6` — a target exists and refused; the count is the whole
 *    information, because 5/6 is one attempt from terminal and 1/6 is noise.
 *
 * `hasForwardingTarget` is already on the root loader (the sidebar checklist
 * reads it), so telling `held` from `queued` costs no extra read.
 */

/**
 * The gateway's own default (`FORWARD_MAX_ATTEMPTS`, `gateway.ts`). A console
 * on a self-host deployment that raised the var would render a denominator one
 * short — which is why the number is only ever shown as part of a ratio the
 * operator can compare against their own configuration, never as a countdown
 * the console claims to own.
 */
export const FORWARD_MAX_ATTEMPTS = 6;

export type ForwardState = "forwarded" | "queued" | "held" | "retrying" | "failed" | "unknown";

export interface ForwardReading {
  state: ForwardState;
  /** What the tag says. Carries the attempt ratio on `retrying`, because the
   * ratio is the reading. */
  label: string;
}

/**
 * Translate one delivery row's state. `null` means there is no batch to
 * describe — an event ingested before the link existed, or one whose batch has
 * aged out of the delivery-audit window — and the caller renders the em-dash
 * rather than guessing.
 */
export function forwardReading(input: {
  status: string | null | undefined;
  attempts: number | null | undefined;
  hasForwardingTarget: boolean;
}): ForwardReading | null {
  const status = input.status ?? null;
  if (status === null) return null;
  const attempts = input.attempts ?? 0;
  if (status === "delivered") return { state: "forwarded", label: "forwarded" };
  if (status === "failed") return { state: "failed", label: "failed" };
  if (status !== "pending") return { state: "unknown", label: status };
  // Held wins over the attempt count on purpose: a target that was removed
  // after a few refusals leaves a row with attempts spent and nothing more
  // coming, and "retrying 2/6" would promise work that will not happen.
  if (!input.hasForwardingTarget) return { state: "held", label: "held" };
  if (attempts === 0) return { state: "queued", label: "queued" };
  return { state: "retrying", label: `retrying ${attempts}/${FORWARD_MAX_ATTEMPTS}` };
}

/**
 * WHICH MOMENT a delivery row's timestamp is — the column that used to be
 * headed "Next attempt" for every row alike.
 *
 * On a held row that header was a lie by label: `next_attempt_at` is the
 * ingest instant, so the queue showed a next attempt in the past for work that
 * was never going to be attempted. Naming the moment is the fix; there is no
 * new data behind it.
 *
 * `unknown` is a real answer, not a gap to paper over: a terminal row written
 * before `finished_at` existed did finish, and the console does not know when.
 * Borrowing `created_at` there would invent a completion out of an arrival —
 * exactly what that column was added to stop.
 */
export interface DeliveryMoment {
  label: "finished" | "next" | "held" | "unknown";
  at: number | null;
}

export function deliveryMoment(
  record: { status: string; finished_at: number | null; next_attempt_at: number },
  hasForwardingTarget: boolean,
): DeliveryMoment {
  if (record.finished_at !== null) return { label: "finished", at: record.finished_at };
  if (record.status !== "pending") return { label: "unknown", at: null };
  if (!hasForwardingTarget) return { label: "held", at: null };
  return { label: "next", at: record.next_attempt_at };
}

/**
 * WHAT a forwarding batch is carrying, read from its own payload.
 *
 * The queue's rows are the only place an operator can ask "what was in the
 * thing that failed", and the answer was previously a row id and nothing else.
 * A redacted payload (content retention, or erasure) says so in words rather
 * than rendering as empty: the metadata row survives on purpose as delivery
 * evidence, and an empty cell would read as a bug.
 */
export function batchEventSummary(payload: string): string {
  if (payload === "") return "content expired";
  let parsed: { events?: unknown };
  try {
    parsed = JSON.parse(payload) as { events?: unknown };
  } catch {
    return "—";
  }
  if (!Array.isArray(parsed.events) || parsed.events.length === 0) return "—";
  const counts = new Map<string, number>();
  for (const event of parsed.events) {
    const type =
      event && typeof event === "object" && typeof (event as { type?: unknown }).type === "string"
        ? ((event as { type: string }).type)
        : "event";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, n]) => `${n} ${eventKindNoun(type, n)}`)
    .join(" · ");
}
