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

/** No scheduled send under any status: the page opens with its first-run block. */
export function scheduledFirstRun(counts: Record<ScheduledStatus, number>): boolean {
  return SCHEDULED_STATUSES.every((status) => counts[status] === 0);
}

/** What an empty tab says while other tabs hold rows. */
export const SCHEDULED_EMPTY: Record<ScheduledStatus, { label: string; description: string }> = {
  pending: {
    label: "NOTHING PENDING",
    description: "No sends are waiting to go out. The ones that ended are under the other tabs.",
  },
  sending: { label: "NOTHING SENDING", description: "No send is going out right now." },
  sent: { label: "NONE SENT YET", description: "Sends that went out appear here." },
  failed: { label: "NO FAILED SENDS", description: "No scheduled send was refused by Meta or expired." },
  unknown: { label: "NO UNKNOWN OUTCOMES", description: "Every send that was attempted got an answer from Meta." },
  cancelled: { label: "NONE CANCELLED", description: "No scheduled send was cancelled." },
};

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

/** Why a send can no longer be cancelled, for "It already ended: …". */
export function endedPhrase(row: Pick<ScheduledSend, "status" | "failureReason">): string {
  switch (row.status) {
    case "sending":
      return "is being sent";
    case "sent":
      return "was sent";
    case "failed":
      return row.failureReason === "expired" ? "expired" : "failed";
    case "unknown":
      return "has an unknown outcome";
    default:
      return row.status;
  }
}
