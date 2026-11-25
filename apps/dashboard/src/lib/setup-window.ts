import type { AccountSummary, PauseReason } from "@eccos/gateway-contract";

/**
 * The account's activation timers, from `AccountSummary.funnel`.
 * An account with no funnel clock reads null and nothing counts down.
 *
 * - `activatedAt`: the first message went through (unix ms).
 * - `pausesAt`: when an unpaid account pauses (unix ms): 72 hours after
 *   activation, day 14 for one that never activated, or the end of early access
 *   the operator scheduled (`pauseReason: "early_access_ended"`).
 */
export interface SetupWindow {
  activatedAt: number | null;
  pausesAt: number | null;
  pauseReason: PauseReason | null;
}

export function setupWindowOf(account: AccountSummary | null | undefined): SetupWindow {
  const funnel = account?.funnel;
  return { activatedAt: funnel?.activatedAt ?? null, pausesAt: funnel?.pausesAt ?? null, pauseReason: funnel?.pauseReason ?? null };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How the strip reads: neutral with more than a day left, amber inside the last day, then the last hour. */
export type WindowPhase = "neutral" | "day" | "hour";

export function windowPhase(left: number): WindowPhase {
  if (left > DAY) return "neutral";
  return left > HOUR ? "day" : "hour";
}

/** "2 d 23 h left", "23 h left", "48 min left". */
export function timeLeft(left: number): string {
  if (left >= DAY) return `${Math.floor(left / DAY)} d ${Math.floor((left % DAY) / HOUR)} h left`;
  if (left >= HOUR) return `${Math.floor(left / HOUR)} h left`;
  return `${Math.max(1, Math.ceil(left / MINUTE))} min left`;
}

/** "9 days left" for the never-activated deadline, read in whole days. */
export function daysLeft(left: number): string {
  const days = Math.max(1, Math.ceil(left / DAY));
  return `${days} ${days === 1 ? "day" : "days"} left`;
}

/** The setup window is running: activated, unpaid and not yet paused. */
export function windowOpen(window: SetupWindow, now: number): window is SetupWindow & { activatedAt: number; pausesAt: number } {
  return window.activatedAt !== null && window.pausesAt !== null && window.pausesAt > now;
}

/** An early-access workspace heading for its scheduled pause. */
export function earlyAccessEnding(window: SetupWindow, now: number): window is SetupWindow & { pausesAt: number } {
  return window.pauseReason === "early_access_ended" && window.pausesAt !== null && window.pausesAt > now;
}

/** "Early access ends in 9 days. Subscribe to keep sending." */
export function earlyAccessMessage(pausesAt: number, now: number): string {
  const days = Math.max(1, Math.ceil((pausesAt - now) / DAY));
  return `Early access ends in ${days} ${days === 1 ? "day" : "days"}. Subscribe to keep sending.`;
}

// The console renders on the server too, so every date reads in UTC and says so when it shows a time.
const part = (at: number, options: Intl.DateTimeFormatOptions) =>
  new Date(at).toLocaleString("en-GB", { ...options, timeZone: "UTC" });

/** "25 Dec 2026" */
export function longDate(at: number): string {
  return part(at, { day: "numeric", month: "short", year: "numeric" });
}

/** "Fri 4 Dec" */
export function weekdayDate(at: number): string {
  return part(at, { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
}

/** "Sat 28 Nov at 10:42 UTC" */
export function weekdayTime(at: number): string {
  return `${weekdayDate(at)} at ${part(at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} UTC`;
}
