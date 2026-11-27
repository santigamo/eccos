import type { WhatsAppCallbackEvent } from "@eccos/core/types";

export const EVENTS_PAGE_DEFAULT = 100;
export const EVENTS_PAGE_MAX = 500;

const EVENT_TYPES: Record<WhatsAppCallbackEvent["type"], true> = {
  sent: true,
  delivered: true,
  read: true,
  failed: true,
  reply: true,
  echo: true,
  message: true,
  message_echo: true,
  scheduled_failed: true,
};

export type EventsQuery = { after?: number; since?: number; type?: string; limit: number };

const nonNegative = (value: string) => (/^\d{1,15}$/.test(value) ? Number(value) : null);

/** The query string of `GET /v1/wabas/:wabaId/events`; a `limit` above the maximum is clamped. */
export function parseEventsQuery(
  query: (name: string) => string | undefined,
): { ok: true; query: EventsQuery } | { ok: false; error: string } {
  const parsed: EventsQuery = { limit: EVENTS_PAGE_DEFAULT };
  for (const name of ["after", "since"] as const) {
    const raw = query(name);
    if (raw === undefined) continue;
    const value = nonNegative(raw);
    if (value === null) return { ok: false, error: `invalid ${name}: expected a non-negative integer` };
    parsed[name] = value;
  }
  const type = query("type");
  if (type !== undefined) {
    if (!Object.hasOwn(EVENT_TYPES, type)) return { ok: false, error: "invalid type" };
    parsed.type = type;
  }
  const limit = query("limit");
  if (limit !== undefined) {
    const value = nonNegative(limit);
    if (!value) return { ok: false, error: "invalid limit: expected a positive integer" };
    parsed.limit = Math.min(value, EVENTS_PAGE_MAX);
  }
  return { ok: true, query: parsed };
}
