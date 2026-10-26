import type { RetryFailedResult, RetryFailedWindow } from "@eccos/gateway-contract";
import type { Result } from "../server/gateway";
import { failureCopy } from "./failure";

/**
 * How the "Retry failed" sheet turns what an operator types into the window the
 * gateway replays, and what it says back. Pure, so the two rules that are easy
 * to get quietly wrong (which instant a local date-time is, and where a window
 * ends) are asserted without a DOM.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** How far back the sheet opens: the failures an operator is looking at today. */
export const DEFAULT_WINDOW_DAYS = 7;

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * An instant as the `YYYY-MM-DDTHH:mm` string a `datetime-local` input holds, in
 * the viewer's own time zone. That input has no zone of its own, so the zone is
 * decided here and in {@link parseLocalInput}, and nowhere else.
 */
export function toLocalInputValue(ms: number): string {
  const date = new Date(ms);
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * The start of the minute a local `YYYY-MM-DDTHH:mm` names, as epoch ms, or
 * `null` when it is not a real moment. `new Date(2026, 1, 31)` rolls over into
 * March instead of failing, so the fields are read back to catch it.
 */
export function parseLocalInput(value: string): number | null {
  const match = LOCAL_INPUT.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(year, month - 1, day, hour, minute);
  const real =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute;
  return real ? date.getTime() : null;
}

/** What the two fields hold when the sheet opens: the last week, up to now. */
export function defaultWindowInputs(now: number): { from: string; to: string } {
  return { from: toLocalInputValue(now - DEFAULT_WINDOW_DAYS * DAY_MS), to: toLocalInputValue(now) };
}

export type WindowReading = { ok: true; window: RetryFailedWindow } | { ok: false; reason: string };

/**
 * The window the gateway will be asked to replay.
 *
 * `from` is the start of the minute typed. `to` is the END of the minute typed:
 * the field has minute resolution and a delivery's `created_at` is exact to the
 * millisecond, so "to 10:30" has to cover 10:30:59.999 or a batch that failed at
 * 10:30:20, inside the minute the operator named, would fall just outside it.
 * It also means the default `to` (now) includes everything up to now.
 */
export function readWindow(fromInput: string, toInput: string): WindowReading {
  const from = parseLocalInput(fromInput);
  if (from === null) return { ok: false, reason: "Choose the date and time the window starts." };
  const toStart = parseLocalInput(toInput);
  if (toStart === null) return { ok: false, reason: "Choose the date and time the window ends." };
  const to = toStart + MINUTE_MS - 1;
  if (from > to) return { ok: false, reason: "The window has to end after it starts." };
  return { ok: true, window: { from, to } };
}

export type RetryFailedNotice =
  | { ok: true; requeued: number; skippedRedacted: number }
  | { ok: false; title: string; detail: string };

/** What the server function takes. Matches the validator in `server/gateway.ts`. */
export type RetryFailedSender = (arg: {
  data: { wabaId: string; from: number; to: number };
}) => Promise<Result<RetryFailedResult>>;

/**
 * Read the window, send it, and say what happened. The sender is a parameter so
 * the request a click builds can be asserted without a browser, which is the
 * gap a static render leaves open. It never throws: a refusal, a dead gateway
 * and a rejected validator all come back as a notice.
 */
export async function submitRetryFailed(
  input: { wabaId: string; fromInput: string; toInput: string },
  send: RetryFailedSender,
): Promise<RetryFailedNotice> {
  const reading = readWindow(input.fromInput, input.toInput);
  if (!reading.ok) return { ok: false, title: "Check the window", detail: reading.reason };
  try {
    const result = await send({ data: { wabaId: input.wabaId, ...reading.window } });
    if (!result.ok) {
      // Keyed on the failure's class, never its message, like every other
      // inline notice: a role without `operate` reads as that, not as an outage.
      const copy = failureCopy(result);
      return { ok: false, ...copy };
    }
    return { ok: true, ...result.data };
  } catch (error) {
    // A THROW rather than a `{ ok: false }`: the validator and the network are
    // what raise here, and the message is the only thing known about either.
    return {
      ok: false,
      title: "The request did not go through",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The lines the result is read in: what was queued, and, only when there is
 * something to say, what could not be. */
export function retryResultLines(result: { requeued: number; skippedRedacted: number }): {
  headline: string;
  notes: string[];
} {
  const { requeued, skippedRedacted } = result;
  const notes: string[] = [];
  if (skippedRedacted > 0) {
    notes.push(
      skippedRedacted === 1
        ? "1 could not be replayed: its content is past the retention window."
        : `${skippedRedacted} could not be replayed: their content is past the retention window.`,
    );
  }
  // An empty window usually means the wrong dates, so say that the search found
  // nothing rather than leave a bare zero to be read as a fault.
  if (requeued === 0 && skippedRedacted === 0) {
    notes.push("No failed deliveries were enqueued in this window.");
  }
  return {
    headline: `${requeued} ${requeued === 1 ? "delivery" : "deliveries"} queued again`,
    notes,
  };
}
