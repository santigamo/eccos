import type { ScheduledSend, ScheduledStatus } from "@eccos/gateway-contract";

/**
 * How the console reads a scheduled send. Pure and type-only on the contract, so it
 * runs under plain `bun test`.
 */

export const SCHEDULED_STATUSES: readonly ScheduledStatus[] = [
  "pending",
  "sending",
  "sent",
  "failed",
  "unknown",
  "cancelled",
];

/** A scheduled status from the URL, or undefined. */
export function normalizeScheduledStatus(value: unknown): ScheduledStatus | undefined {
  return SCHEDULED_STATUSES.find((status) => status === value);
}

/** A schedule key from the URL (the gateway's SCHEDULE_KEY), or undefined. */
export function normalizeScheduleKey(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

/** Soonest first while it can still go out; the ended ones read newest first (the gateway's order). */
export function readsSoonestFirst(status: ScheduledStatus): boolean {
  return status === "pending" || status === "sending";
}

/** What a row ended as, for the Outcome cell. */
export type ScheduledOutcome =
  | { kind: "message"; messageId: string }
  | { kind: "expired" }
  | { kind: "error"; raw: string }
  | { kind: "unknown" };

/** Null while nothing has happened to the row. */
export function scheduledOutcome(
  row: Pick<ScheduledSend, "status" | "messageId" | "failureReason" | "error">,
): ScheduledOutcome | null {
  if (row.status === "sent" && row.messageId) return { kind: "message", messageId: row.messageId };
  if (row.status === "failed") {
    if (row.failureReason === "expired") return { kind: "expired" };
    return row.error ? { kind: "error", raw: row.error } : { kind: "unknown" };
  }
  if (row.status === "unknown") return row.error ? { kind: "error", raw: row.error } : { kind: "unknown" };
  return null;
}
