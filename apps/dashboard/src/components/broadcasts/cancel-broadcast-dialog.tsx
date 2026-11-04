import type { BroadcastSummary } from "@eccos/gateway-contract";
import { cancelBroadcast } from "../../server/gateway";
import { failureCopy } from "../../lib/failure";
import { CancelDialog } from "../sending/cancel-dialog";

/** What cancelling THIS broadcast costs, in the system's own terms. */
export function cancelConfirmCopy(counts: BroadcastSummary["counts"]): string {
  const waiting = counts.queued + counts.sending;
  return `${waiting} recipients not yet sent will not be messaged. The ${counts.sent} already sent stay sent. A cancelled broadcast cannot be resumed.`;
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
        return result.ok ? null : failureCopy(result);
      }}
      onOpenChange={onOpenChange}
      onDone={onCancelled}
    />
  );
}
