import type { BroadcastSummary } from "@eccos/gateway-contract";
import { cancelBroadcast } from "../../server/gateway";
import { broadcastStateLabel } from "../../lib/broadcasts";
import { failureCopy } from "../../lib/failure";
import { CancelDialog } from "../sending/cancel-dialog";

/** What cancelling THIS broadcast costs, in the system's own terms. */
export function cancelConfirmCopy(counts: BroadcastSummary["counts"]): string {
  const inFlight = counts.sending > 0 ? ` The ${counts.sending} being sent now may still go out.` : "";
  return `${counts.queued} queued recipients will not be messaged.${inFlight} The ${counts.sent} already sent stay sent. A cancelled broadcast cannot be resumed.`;
}

/** Confirm and cancel a running broadcast. The server decides who may; a refusal reads in the dialog. */
export function CancelBroadcastDialog({
  wabaId,
  broadcast,
  onOpenChange,
  onCancelled,
}: {
  wabaId: string;
  broadcast: BroadcastSummary;
  onOpenChange: (open: boolean) => void;
  /** Called once the broadcast is stopped (or already gone), so the route re-reads it. */
  onCancelled: () => void;
}) {
  return (
    <CancelDialog
      title="Cancel this broadcast?"
      description={
        <>
          <span className="block font-mono text-[11px] break-all text-foreground">
            {broadcast.template.name} {"·"} {broadcast.template.language}
          </span>
          <span className="mt-1 block">{cancelConfirmCopy(broadcast.counts)}</span>
        </>
      }
      keepLabel="Keep sending"
      confirmLabel="Cancel broadcast"
      busyLabel="Cancelling…"
      onConfirm={async () => {
        const result = await cancelBroadcast({ data: { wabaId, broadcastId: broadcast.id } });
        if (!result.ok) return failureCopy(result);
        if (result.data && result.data.status !== "cancelled") {
          onCancelled();
          return { title: "Too late to cancel", detail: `It already ended: ${broadcastStateLabel(result.data)}.` };
        }
        return null;
      }}
      onOpenChange={onOpenChange}
      onDone={onCancelled}
    />
  );
}
