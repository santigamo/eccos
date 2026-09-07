import { describe, expect, test } from "bun:test";
import {
  FORWARD_MAX_ATTEMPTS,
  batchEventSummary,
  deliveryMoment,
  forwardReading,
} from "../src/lib/forwarding";

/**
 * The Eccos → subscriber hop, in its own vocabulary (`src/lib/forwarding.ts`).
 *
 * Pure, and tested without a DOM for the reason `lib/health.ts` is: the word a
 * console puts on a row is a rule, and this one used to print the database's
 * `delivered` on a screen where `delivered` already meant something else. The
 * three-way split of `pending` is the part that is easy to get quietly wrong,
 * so each branch is pinned by itself.
 */

describe("forwardReading", () => {
  test("a forwarded batch never says `delivered` again", () => {
    // THE COLLISION THIS ENDS. `deliveries.status = 'delivered'` means the
    // SUBSCRIBER received the batch; the event log's `delivered` means the
    // CUSTOMER'S PHONE received a message. Both appeared on one screen.
    const reading = forwardReading({ status: "delivered", attempts: 1, hasForwardingTarget: true });
    expect(reading).toEqual({ state: "forwarded", label: "forwarded" });
  });

  test("no target: held, whatever the attempt count says", () => {
    // `alarm()` HOLDS the drain when nothing is configured — no attempt, no
    // increment, no error. Rendered as `pending` with `attempts 0` and a
    // next-attempt in the past, that was indistinguishable from stuck.
    expect(forwardReading({ status: "pending", attempts: 0, hasForwardingTarget: false })).toEqual({
      state: "held",
      label: "held",
    });
    // A target removed after a few refusals leaves attempts spent and nothing
    // more coming: `retrying 2/6` would promise work that will not happen.
    expect(forwardReading({ status: "pending", attempts: 2, hasForwardingTarget: false })).toEqual({
      state: "held",
      label: "held",
    });
  });

  test("with a target: queued before the first attempt, retrying after it", () => {
    expect(forwardReading({ status: "pending", attempts: 0, hasForwardingTarget: true })).toEqual({
      state: "queued",
      label: "queued",
    });
    // The RATIO is the reading: 5/6 is one attempt from terminal, 1/6 is noise.
    expect(forwardReading({ status: "pending", attempts: 2, hasForwardingTarget: true })).toEqual({
      state: "retrying",
      label: `retrying 2/${FORWARD_MAX_ATTEMPTS}`,
    });
  });

  test("failed is failed, and an unknown status is shown rather than guessed", () => {
    expect(forwardReading({ status: "failed", attempts: 6, hasForwardingTarget: true })?.state).toBe(
      "failed",
    );
    expect(forwardReading({ status: "sideways", attempts: 0, hasForwardingTarget: true })).toEqual({
      state: "unknown",
      label: "sideways",
    });
  });

  test("no batch at all reads as null, so the caller can draw the em-dash", () => {
    // An event ingested before the event→batch link existed, or one whose batch
    // aged out of the delivery-audit window. Inventing a state for it would be
    // the console asserting something it does not know.
    expect(forwardReading({ status: null, attempts: null, hasForwardingTarget: true })).toBeNull();
    expect(forwardReading({ status: undefined, attempts: 3, hasForwardingTarget: false })).toBeNull();
  });
});

describe("deliveryMoment", () => {
  const row = (over: Partial<{ status: string; finished_at: number | null; next_attempt_at: number }>) => ({
    status: "pending",
    finished_at: null,
    next_attempt_at: 1_000,
    ...over,
  });

  test("a finished batch names its completion, not its arrival", () => {
    expect(deliveryMoment(row({ status: "delivered", finished_at: 2_000 }), true)).toEqual({
      label: "finished",
      at: 2_000,
    });
  });

  test("a held batch has NO next attempt, and the console does not invent one", () => {
    // THE LIE BY LABEL THIS REPLACED: `next_attempt_at` on a held row is the
    // ingest instant, so a column headed "Next attempt" showed a next attempt
    // in the past for work that was never going to be attempted.
    expect(deliveryMoment(row({ next_attempt_at: 1 }), false)).toEqual({ label: "held", at: null });
  });

  test("a waiting batch with a target names when it will be tried", () => {
    expect(deliveryMoment(row({ next_attempt_at: 5_000 }), true)).toEqual({
      label: "next",
      at: 5_000,
    });
  });

  test("a terminal row written before `finished_at` existed says it does not know", () => {
    // `created_at` is the moment the batch ARRIVED. Borrowing it here would
    // invent a completion out of an arrival — the exact confusion the column
    // was added to end — so the answer is `unknown`, never a timestamp.
    expect(deliveryMoment(row({ status: "failed", finished_at: null }), true)).toEqual({
      label: "unknown",
      at: null,
    });
  });
});

describe("batchEventSummary", () => {
  const batch = (...types: string[]) =>
    JSON.stringify({ events: types.map((type) => ({ type })) });

  test("says what the batch is carrying, counted by kind", () => {
    expect(batchEventSummary(batch("reply"))).toBe("1 reply");
    expect(batchEventSummary(batch("reply", "reply"))).toBe("2 replies");
    expect(batchEventSummary(batch("delivered", "delivered", "read"))).toBe("2 delivered · 1 read");
  });

  test("a redacted payload says so instead of rendering as empty", () => {
    // The metadata row survives content retention on purpose, as delivery
    // evidence. An empty cell there would read as a bug rather than a policy.
    expect(batchEventSummary("")).toBe("content expired");
  });

  test("unparseable or empty storage falls back to the em-dash", () => {
    expect(batchEventSummary("{not json")).toBe("—");
    expect(batchEventSummary(JSON.stringify({ events: [] }))).toBe("—");
  });
});
