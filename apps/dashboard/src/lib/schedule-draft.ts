import { isBsuid } from "@eccos/core/bsuid";
import type { ScheduledSend, ScheduleSendFailureCode } from "@eccos/gateway-contract";
import { normalizeCustomerId } from "./customer-id";
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

export const NOT_SCHEDULED = "Not scheduled";

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

/** Epoch ms of a local day and time, or null while either is incomplete. A time in a DST gap resolves forward. */
export function instantOf({ day, time }: When): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const at = new Date(`${day}T${time}`).getTime();
  return Number.isFinite(at) ? at : null;
}

/** The day and time the send will actually go out at, which a DST gap moves. */
export function resolvedWhen(when: When, at: number | null, timeZone?: string): When {
  return at === null ? when : { day: when.day, time: localTime(at, timeZone).clock };
}

/** One line when the typed time is not one instant in `timeZone`: skipped by DST, or repeated. */
export function dstNote(when: When, at: number | null, timeZone: string): string | null {
  if (at === null) return null;
  const resolved = localTime(at, timeZone);
  const date = resolved.day.split(" ").slice(1).join(" ");
  if (resolved.clock !== when.time) {
    return `${when.time} does not exist on ${date} in ${timeZone}; it will send at ${resolved.clock}.`;
  }
  if (localTime(at + HOUR, timeZone).clock === when.time) {
    return `${when.time} happens twice on ${date} in ${timeZone}; it will send at the first, ${when.time} ${resolved.zone}.`;
  }
  return null;
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

/** A recipient must carry its country code: a national number would reach someone in another country. */
export function recipientProblem(value: string): string | null {
  const to = value.trim();
  return isBsuid(to) || to.startsWith("+") ? null : "Include the country code, starting with +.";
}

/**
 * Whether the send a `key_exists` names is this very draft: a retry whose first answer was
 * lost. Then it was scheduled, and saying "choose another key" would invite a second send.
 */
export function isSameSend(
  existing: Pick<ScheduledSend, "status" | "to" | "sendAt" | "template">,
  draft: { to: string; sendAt: number; templateName: string; languageCode: string },
): boolean {
  return (
    existing.status === "pending" &&
    existing.to === normalizeCustomerId(draft.to) &&
    existing.sendAt === draft.sendAt &&
    existing.template.name === draft.templateName &&
    existing.template.language === draft.languageCode
  );
}

/** `Saturday 28 November, 09:00`, for the readback. */
export function longDay(at: number, timeZone?: string): string {
  const { day, clock } = localTime(at, timeZone, "long");
  return `${day}, ${clock}`;
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
  const title = NOT_SCHEDULED;
  const secondary = failure.detail ? { secondary: failure.detail } : {};
  switch (failure.code) {
    case "key_exists": {
      const existing = failure.existing;
      const state = existing ? ` (${existing.status} for ${shortWhen(existing.sendAt, timeZone)})` : "";
      return { title, detail: `A send with this key already exists${state}. Choose another key.` };
    }
    case "invalid_time":
      return { title, detail: "That time cannot be scheduled.", ...secondary };
    case "invalid_request":
      return { title, detail: "Eccos refused this request.", ...secondary };
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
