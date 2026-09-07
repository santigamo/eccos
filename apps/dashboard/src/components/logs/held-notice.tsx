import { Link } from "@tanstack/react-router";

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
 * SAID ONLY WHEN BOTH HALVES ARE TRUE: no target AND something actually
 * waiting. With an empty queue there is nothing held and the line would be a
 * standing scold on a page that is behaving; with a target set, `pending` rows
 * are ordinary queue and drain in seconds. Data rule 1: when an operator sees
 * this, it always means something.
 *
 * The decision lives HERE rather than at the call sites, so the two pages that
 * show it cannot disagree about when — and so the live region can stay mounted
 * while it says nothing. An element that appears and disappears is not reliably
 * announced; an empty one that fills up is (same reasoning as `StatusBanner` on
 * the Status page). Quiet therefore costs no pixels: no rail, no margin.
 */
export function HeldNotice({
  pending,
  hasForwardingTarget,
  wabaId,
}: {
  pending: number;
  hasForwardingTarget: boolean;
  wabaId?: string;
}) {
  const held = !hasForwardingTarget && pending > 0;
  return (
    <output
      className={
        held
          ? "mb-4 block border-l-2 border-l-[#f0a020] px-3 py-2 text-foreground text-sm"
          : undefined
      }
      aria-live="polite"
    >
      {held ? (
        <>
          Forwarding is held — no target is set.{" "}
          {pending === 1 ? "One event is" : `${pending} events are`} waiting. Nothing has been
          attempted and nothing has failed; events go out the moment you name a receiver.{" "}
          <Link
            to="/webhooks"
            search={wabaId ? { wabaId } : {}}
            className="text-primary underline-offset-4 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Set a forwarding target
          </Link>
        </>
      ) : null}
    </output>
  );
}
