import type {
  BroadcastRecipientRow,
  BroadcastRecipientStatus,
  BroadcastSummary,
} from "@eccos/gateway-contract";

/**
 * How the console words a broadcast's states. Pure and type-only on the
 * contract, so it runs under plain `bun test`.
 *
 * A broadcast speaks the Eccos → Meta hop (`sent` / `failed`) and nothing
 * else: `delivered` is a later receipt from Meta and is counted on the
 * summary, never written on a recipient row (data rule 9).
 */

export const RECIPIENT_STATUSES: readonly BroadcastRecipientStatus[] = [
  "queued",
  "sending",
  "sent",
  "failed",
  "unknown",
  "cancelled",
];

export function broadcastStateLabel(summary: Pick<BroadcastSummary, "status">): string {
  return summary.status === "running" ? "sending" : summary.status;
}

export function recipientStateLabel(row: Pick<BroadcastRecipientRow, "status">): string {
  return row.status === "unknown" ? "unknown outcome" : row.status;
}

/** Recipients Eccos has attempted: cancelled and still-queued ones are not. */
export function attemptedCount(counts: BroadcastSummary["counts"]): number {
  return counts.sent + counts.failed + counts.unknown;
}

/** A recipient status from the URL, or undefined. */
export function normalizeRecipientStatus(value: unknown): BroadcastRecipientStatus | undefined {
  return RECIPIENT_STATUSES.find((status) => status === value);
}

/** A seq cursor from the URL: digits only. */
export function normalizeSeqCursor(value: unknown): string | undefined {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  return /^[0-9]{1,15}$/.test(text) ? text : undefined;
}

/** A broadcast id from the URL (`bc_` + 32 hex), or undefined. */
export function normalizeBroadcastId(value: unknown): string | undefined {
  return typeof value === "string" && /^bc_[0-9a-f]{32}$/.test(value) ? value : undefined;
}
