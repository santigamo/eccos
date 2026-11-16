import { Link } from "@tanstack/react-router";
import { heldSentence } from "../../lib/forwarding";
import { INLINE_LINK } from "../../ui";

/**
 * "Forwarding is held" — the third register in which the console says the same
 * fact, and the only one that appears above a log.
 *
 * The other two are the row tag (`HELD`, amber) and the sheet's Forwarding
 * section. They answer "what happened to THIS event"; this answers "why does
 * the whole page look stuck", which is the question an operator actually
 * arrives with when every row reads the same.
 *
 * It borrows the Status banner's exact anatomy — a live region, a 2px amber
 * rail, one sentence, a real link to the page that resolves it — because it is
 * the same statement about the same system, and a second visual language for it
 * would read as a second condition.
 *
 * SAID ONLY WHEN BOTH HALVES ARE TRUE: a confirmed missing target (`false`,
 * never the `null` of a failed read) AND something actually waiting. With an empty queue there is nothing held and the line would be a
 * standing scold on a page that is behaving; with a target set, `pending` rows
 * are ordinary queue and drain in seconds. Data rule 1: when an operator sees
 * this, it always means something.
 *
 * `link={false}` is for /webhooks, where the form that resolves it is the page.
 *
 * The decision lives HERE rather than at the call sites, so the pages that
 * show it cannot disagree about when — and so the live region can stay mounted
 * while it says nothing. An element that appears and disappears is not reliably
 * announced; an empty one that fills up is (same reasoning as `StatusBanner` on
 * the Status page). Quiet therefore costs no pixels: no rail, no margin.
 */
export function HeldNotice({
  pending,
  hasForwardingTarget,
  wabaId,
  retentionDays,
  link = true,
}: {
  pending: number;
  hasForwardingTarget: boolean | null;
  wabaId?: string;
  retentionDays?: number | null;
  link?: boolean;
}) {
  const held = hasForwardingTarget === false && pending > 0;
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
          {heldSentence(pending, retentionDays)}
          {link ? (
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
          ) : null}
        </>
      ) : null}
    </output>
  );
}
