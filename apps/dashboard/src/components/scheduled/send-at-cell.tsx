import type { ScheduledSend } from "@eccos/gateway-contract";
import { useHydrated } from "../../hooks/use-hydrated";
import { expiresPhrase, localTime, utcInstant } from "../../lib/send-at";
import { fmtTs } from "../../ui";
import { IDENTITY_TIER, SECONDARY_TIER } from "../dashboard/plain-table";

/**
 * When a scheduled send goes out. A pending row reads in the viewer's zone, named,
 * over the exact UTC instant; that reading needs the browser, so the server and the
 * first client render print UTC. Every other row is evidence and stays UTC.
 */
export function SendAtCell({ row }: { row: Pick<ScheduledSend, "status" | "sendAt" | "expiresAt"> }) {
  const local = useHydrated();
  if (row.status === "pending" && local) {
    const at = localTime(row.sendAt);
    return (
      <>
        <span className={`block ${IDENTITY_TIER}`}>
          {at.day}, {at.clock} <span className="font-normal text-muted-foreground">{at.zone}</span>
        </span>
        <span className="block font-mono text-xs text-muted-foreground">{utcInstant(row.sendAt)}</span>
        <span className={`block ${SECONDARY_TIER}`}>{expiresPhrase(row.sendAt, row.expiresAt)}</span>
      </>
    );
  }
  const open = row.status === "pending" || row.status === "sending";
  return (
    <>
      <span className="font-mono text-xs">{fmtTs(row.sendAt)}</span>
      {open ? <span className="block text-xs text-muted-foreground">expires {fmtTs(row.expiresAt)}</span> : null}
    </>
  );
}
