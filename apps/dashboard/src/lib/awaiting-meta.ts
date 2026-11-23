import type { OutboundRow } from "../server/gateway";

/** How long a send may wait for Meta's final word before the page stops asking. */
export const AWAITING_WINDOW_MS = 10 * 60_000;

const FINAL = new Set(["delivered", "read", "failed"]);

/**
 * True while a send Meta accepted in the last ten minutes has no final status
 * in its trail yet, so /messages can refresh itself until the answer lands.
 */
export function awaitingMeta(rows: readonly OutboundRow[], now: number): boolean {
  return rows.some(
    (row) =>
      row.status === "sent" &&
      now - row.created_at < AWAITING_WINDOW_MS &&
      !(row.trail ?? []).some((event) => FINAL.has(event.type)),
  );
}
