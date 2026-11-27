import type {
  BroadcastRecipientRow,
  BroadcastRecipientStatus,
  BroadcastSummary,
} from "@eccos/gateway-contract";
import { fmtCount } from "../ui";

/**
 * How the console words a broadcast's states. Pure, so it runs under plain
 * `bun test`.
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

/**
 * A broadcast's state with the reason beside it: `paused · 1,241 waiting` while the
 * workspace's sending is paused (billing), `halted · <reason>` when it stopped itself.
 */
export function broadcastState(
  summary: Pick<BroadcastSummary, "status" | "counts" | "haltReason">,
  sendingPaused: boolean,
): { label: string; reason: string | null } {
  if (summary.status === "running" && sendingPaused) {
    return { label: "paused", reason: `${fmtCount(summary.counts.queued)} waiting` };
  }
  if (summary.status === "halted") return { label: "halted", reason: summary.haltReason };
  return { label: broadcastStateLabel(summary), reason: null };
}

/**
 * Messages a minute a broadcast sends: 80% of the account's rate, in whole ticks,
 * as the gateway paces it (`pacing()` in apps/gateway/src/broadcasts.ts).
 */
export function broadcastPace(ratePerMinute: number): number {
  const budget = Math.max(1, ratePerMinute * 0.8);
  if (budget >= 60) return Math.floor(budget / 60) * 60;
  return Math.round(60_000 / Math.ceil(60_000 / budget));
}

/** The list holds nothing at all: no rows on the first page. */
export function broadcastsFirstRun(items: readonly unknown[], cursor: string | undefined): boolean {
  return items.length === 0 && cursor === undefined;
}

export function recipientStateLabel(row: Pick<BroadcastRecipientRow, "status">): string {
  return row.status === "unknown" ? "unknown outcome" : row.status;
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
