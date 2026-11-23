import { Link } from "@tanstack/react-router";
import { heldCount, heldSentence, targetMissing } from "../../lib/forwarding";
import { INLINE_LINK } from "../../ui";

/**
 * "Forwarding is held", said above a page rather than on one row. The row tag
 * (`HELD`) and the sheet's Forwarding section answer "what happened to THIS
 * event"; this answers "why does the whole page look stuck".
 *
 * It borrows the Status banner's anatomy (a live region, an amber rail, one
 * statement, a link to the page that resolves it) because it is the same
 * statement about the same system.
 *
 * Said only when both halves are true: a target confirmed missing
 * (`targetMissing`, never a failed read) and something actually waiting. The
 * decision lives here so the pages that show it cannot disagree about when,
 * and so the live region stays mounted while it says nothing: an element that
 * appears is not reliably announced, an empty one that fills up is.
 *
 * `countOnly` is for /webhooks, where the panel below is the action and
 * already states the promise and the deadline.
 */
export function HeldNotice({
  pending,
  hasForwardingTarget,
  wabaId,
  retentionDays,
  countOnly = false,
}: {
  pending: number;
  hasForwardingTarget: boolean | null;
  wabaId?: string;
  retentionDays?: number | null;
  countOnly?: boolean;
}) {
  const held = targetMissing(hasForwardingTarget) && pending > 0;
  return (
    <output
      className={
        held
          ? "mb-4 block border-l-2 border-l-warning px-3 py-2 text-foreground text-sm"
          : undefined
      }
      aria-live="polite"
    >
      {held ? (
        <>
          {countOnly ? heldCount(pending) : heldSentence(pending, retentionDays)}
          {countOnly ? null : (
            <>
              {" "}
              <Link
                to="/webhooks"
                search={wabaId ? { wabaId } : {}}
                className={INLINE_LINK}
              >
                Set a forwarding target
              </Link>
            </>
          )}
        </>
      ) : null}
    </output>
  );
}
