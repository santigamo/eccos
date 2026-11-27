/**
 * A pending send's time in the viewer's zone, named: the one stated exception to
 * the console's UTC rule (docs/DASHBOARD-DESIGN.md), because it is a plan a person
 * checks, not evidence matched against a log. `timeZone` undefined is the viewer's;
 * read it only after hydration, since the server does not know it.
 */

export type LocalTime = { day: string; clock: string; zone: string };

export function localTime(at: number, timeZone?: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
    timeZone,
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: `${part("weekday")} ${part("day")} ${part("month")}`,
    clock: `${part("hour")}:${part("minute")}`,
    zone: part("timeZoneName"),
  };
}

/** `2026-11-28T08:00:00Z`: the exact instant, without milliseconds. */
export function utcInstant(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `expires 10:00`, with the day when it is not the send's own. */
export function expiresPhrase(sendAt: number, expiresAt: number, timeZone?: string): string {
  const send = localTime(sendAt, timeZone);
  const expires = localTime(expiresAt, timeZone);
  return expires.day === send.day ? `expires ${expires.clock}` : `expires ${expires.day}, ${expires.clock}`;
}
