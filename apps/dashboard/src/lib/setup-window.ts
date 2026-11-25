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

/** "2 d 23 h left", "23 h left", "48 min left": every countdown in the console, rounded down. */
export function timeLeft(left: number): string {
  if (left >= DAY) return `${Math.floor(left / DAY)} d ${Math.floor((left % DAY) / HOUR)} h left`;
  if (left >= HOUR) return `${Math.floor(left / HOUR)} h left`;
  return `${Math.max(1, Math.floor(left / MINUTE))} min left`;
}

/** Whole days, rounded down like `timeLeft`, never below one. */
const wholeDays = (left: number) => {
  const days = Math.max(1, Math.floor(left / DAY));
  return `${days} ${days === 1 ? "day" : "days"}`;
};

/** "9 days left" for the never-activated deadline, read in whole days. */
export function daysLeft(left: number): string {
  return `${wholeDays(left)} left`;
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
  return `Early access ends in ${wholeDays(pausesAt - now)}. Subscribe to keep sending.`;
}

/**
 * Dates read in UTC on the server and in the first client render, so hydration
 * matches; `local` is the viewer's own zone, for after hydration (`useHydrated`).
 */
const part = (at: number, options: Intl.DateTimeFormatOptions, local = false) =>
  new Date(at).toLocaleString("en-GB", local ? options : { ...options, timeZone: "UTC" });

/** "25 Dec 2026" */
export function longDate(at: number): string {
  return part(at, { day: "numeric", month: "short", year: "numeric" });
}

/** "Fri 4 Dec" */
export function weekdayDate(at: number, local = false): string {
  return part(at, { weekday: "short", day: "numeric", month: "short" }, local).replace(",", "");
}

/** "Sat 28 Nov at 10:42" in the viewer's zone once `local`; just "Sat 28 Nov" before, with no time to mismatch. */
export function weekdayTime(at: number, local = false): string {
  if (!local) return weekdayDate(at);
  return `${weekdayDate(at, true)} at ${part(at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, true)}`;
}
