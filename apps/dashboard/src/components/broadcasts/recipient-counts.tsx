import { Link } from "@tanstack/react-router";
import type { BroadcastSummary } from "@eccos/gateway-contract";
import { RECIPIENT_STATUSES } from "../../lib/broadcasts";
import { COUNT_LINK } from "../../ui";

/** Red where an operator may have to act; amber only while the broadcast is still going. */
function ink(status: string, running: boolean): string {
  if (status === "failed" || status === "unknown") return "text-[#ff7777]";
  if (running && (status === "queued" || status === "sending")) return "text-[#f0a020]";
  return "text-muted-foreground hover:text-foreground";
}

/**
 * Per-status recipient counts, each a door into this same page filtered by that
 * status (data rule 2). Local on purpose: `StatusCounts` is wired to the two
 * logs, and zero counts are noise here.
 */
export function RecipientCounts({
  broadcastId,
  counts,
  running,
  wabaId,
}: {
  broadcastId: string;
  counts: BroadcastSummary["counts"];
  running: boolean;
  wabaId?: string;
}) {
  const entries = RECIPIENT_STATUSES.filter((status) => counts[status] > 0);
  if (entries.length === 0) return null;
  return (
    <ul
      aria-label="recipients by status"
      className="mt-3 flex list-none flex-wrap items-center gap-x-2 gap-y-1 p-0 text-[11px] font-medium tracking-wider uppercase"
    >
      {entries.map((status, i) => (
        <li key={status} className="flex items-center gap-2">
          {i > 0 ? (
            <span aria-hidden="true" className="text-muted-foreground/50">
              ·
            </span>
          ) : null}
          <Link
            to="/broadcasts/$broadcastId"
            params={{ broadcastId }}
            search={{ status, ...(wabaId ? { wabaId } : {}) }}
            className={`${COUNT_LINK} ${ink(status, running)}`}
          >
            {status} <span className="tabular-nums">{counts[status]}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
