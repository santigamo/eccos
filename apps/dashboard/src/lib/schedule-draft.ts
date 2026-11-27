import type { ScheduledSend, ScheduleSendFailureCode } from "@eccos/gateway-contract";
import { localTime } from "./send-at";

/**
 * The "Schedule a send" sheet's rules, pure so they run under plain `bun test`. Times are
 * the viewer's (`timeZone` undefined), the stated exception to the UTC rule.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The gateway's MAX_SCHEDULE_AHEAD_MS. */
const MAX_AHEAD_MS = 90 * DAY;

export const DELAYS = [
  { ms: 15 * MINUTE, label: "15 minutes" },
  { ms: HOUR, label: "1 hour" },
  { ms: 3 * HOUR, label: "3 hours" },
  { ms: DAY, label: "1 day" },
  { ms: 7 * DAY, label: "7 days" },
] as const;
export const DEFAULT_DELAY_MS = HOUR;

export type When = { day: string; time: string };

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

export function tomorrowAtNine(now: Date): When {
  return { day: dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)), time: "09:00" };
}

/** The date input's bounds: today to 90 days ahead. */
export function dayBounds(now: Date): { min: string; max: string } {
  return { min: dayOf(now), max: dayOf(new Date(now.getTime() + MAX_AHEAD_MS)) };
}

/** Epoch ms of a local day and time, or null while either is incomplete. */
export function instantOf({ day, time }: When): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const at = new Date(`${day}T${time}`).getTime();
  return Number.isFinite(at) ? at : null;
}

/** `console-20261128-0900-x7k2`: dated, so it reads in the list, and suffixed, so two never collide. */
export function consoleKey({ day, time }: When, suffix: string): string {
  return `console-${day.replaceAll("-", "")}-${time.replace(":", "")}-${suffix}`;
}

export function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => alphabet[byte % alphabet.length]).join("");
}

/** Why this time cannot be scheduled, or null. */
export function whenProblem(sendAt: number | null, now: number): string | null {
  if (sendAt === null) return "Pick a day and a time.";
  if (sendAt <= now) return "Pick a time in the future. To send it now, use Send test on the template.";
  if (sendAt > now + MAX_AHEAD_MS) {
    const until = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(
      new Date(now + MAX_AHEAD_MS),
    );
    return `A send can be scheduled up to 90 days ahead (until ${until}).`;
  }
  return null;
}

/** `Saturday 28 November, 09:00`, for the readback. */
export function longDay(at: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")}, ${part("hour")}:${part("minute")}`;
}

/** `Madrid time` from `Europe/Madrid`: the zone as a person names it. */
export function zoneName(timeZone: string): string {
  return `${(timeZone.split("/").at(-1) ?? timeZone).replaceAll("_", " ")} time`;
}

/** `Sat 28 Nov, 09:00`: the primary's and the toast's reading. */
export function shortWhen(at: number, timeZone?: string): string {
  const { day, clock } = localTime(at, timeZone);
  return `${day}, ${clock}`;
}

/** What a refused schedule says. Nothing is ever partly scheduled, so each line says so. */
export function scheduleFailureCopy(
  failure: {
    code: ScheduleSendFailureCode;
    detail: string | null;
    existing?: ScheduledSend;
    templateStatus?: string;
  },
  template: string,
  timeZone?: string,
): { title: string; detail: string; secondary?: string } {
  const title = "Not scheduled";
  switch (failure.code) {
    case "key_exists": {
      const existing = failure.existing;
      const state = existing ? ` (${existing.status} for ${shortWhen(existing.sendAt, timeZone)})` : "";
      return { title, detail: `A send with this key already exists${state}. Choose another key.` };
    }
    case "invalid_time":
      return { title, detail: "That time cannot be scheduled.", ...(failure.detail ? { secondary: failure.detail } : {}) };
    case "subscription_required":
      return { title, detail: "Sending is paused for this workspace, so nothing can be scheduled." };
    case "no_phone":
      return { title, detail: "This number is no longer connected to the account." };
    case "too_many_pending":
      return { title, detail: "This account already holds 50,000 pending sends, which is the limit." };
    case "template_not_approved":
      return {
        title,
        detail: `${template} is no longer approved: Meta now lists it as ${failure.templateStatus ?? "not approved"}. Nothing was scheduled.`,
      };
    case "template_not_found":
      return { title, detail: `Meta no longer lists ${template}. Nothing was scheduled.` };
    case "templates_unreachable":
      return { title, detail: "Eccos could not check the template with Meta. Nothing was scheduled. Try again." };
  }
}
