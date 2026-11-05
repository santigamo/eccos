import { Link } from "@tanstack/react-router";
import type { ScheduledPage, ScheduledStatus } from "@eccos/gateway-contract";
import { SCHEDULED_STATUSES } from "../../lib/scheduled";
import { COUNT_LINK } from "../../ui";
import { countInk } from "../broadcasts/recipient-counts";

/**
 * The status filter, as per-status counts (data rule 2: every number is a door).
 * All six show, zeros included: they are the tabs. Local on purpose: `pending` is
 * amber in `StatusCounts`, and on a healthy gateway that would colour the whole page.
 */
export function ScheduledStatusTabs({
  counts,
  status,
  wabaId,
}: {
  counts: ScheduledPage["counts"];
  status: ScheduledStatus;
  wabaId?: string;
}) {
  return (
    <ul
      aria-label="scheduled sends by status"
      className="mb-3 flex list-none flex-wrap items-center gap-x-2 gap-y-1 p-0 text-[11px] font-medium tracking-wider uppercase"
    >
      {SCHEDULED_STATUSES.map((entry, i) => {
        const current = entry === status;
        const ink = current
          ? "text-foreground"
          : counts[entry] === 0
            ? "text-muted-foreground hover:text-foreground"
            : countInk(entry);
        return (
          <li key={entry} className="flex items-center gap-2">
            {i > 0 ? (
              <span aria-hidden="true" className="text-muted-foreground/50">
                ·
              </span>
            ) : null}
            <Link
              to="/scheduled"
              search={{ ...(entry === "pending" ? {} : { status: entry }), ...(wabaId ? { wabaId } : {}) }}
              aria-current={current ? "page" : undefined}
              className={`${COUNT_LINK} ${ink}`}
            >
              {entry} <span className="tabular-nums">{counts[entry]}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
