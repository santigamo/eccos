import type { ScheduledSend } from "@eccos/gateway-contract";
import { cancelScheduled } from "../../server/gateway";
import { failureCopy } from "../../lib/failure";
import { formatCustomerId } from "../../lib/customer-id";
import { endedPhrase } from "../../lib/scheduled";
import { localTime } from "../../lib/send-at";
import { CancelDialog } from "../sending/cancel-dialog";

/**
 * What cancelling THIS scheduled send costs. Opened only by a click, so it reads the
 * time in the viewer's zone, as the pending row did.
 */
export function cancelScheduledCopy(row: Pick<ScheduledSend, "to" | "sendAt">, timeZone?: string): string {
  const at = localTime(row.sendAt, timeZone);
  return `It will not be sent to ${formatCustomerId(row.to)} on ${at.day} at ${at.clock} ${at.zone}. It can be scheduled again under the same key.`;
}

/** Confirm and cancel a pending scheduled send. A send claimed meanwhile reads "Too late to cancel". */
export function CancelScheduledDialog({
  wabaId,
  scheduled,
  onOpenChange,
  onCancelled,
}: {
  wabaId: string;
  scheduled: ScheduledSend;
  onOpenChange: (open: boolean) => void;
  /** Called once the dialog is done, so the route re-reads. */
  onCancelled: () => void;
}) {
  return (
    <CancelDialog
      title="Cancel this scheduled send?"
      description={
        <>
          <span className="block font-mono text-[11px] break-all text-foreground">
            {scheduled.key} {"·"} {scheduled.template.name} {"·"} {scheduled.template.language}
          </span>
          <span className="mt-1 block">{cancelScheduledCopy(scheduled)}</span>
        </>
      }
      keepLabel="Keep it"
      confirmLabel="Cancel send"
      busyLabel="Cancelling…"
      onConfirm={async () => {
        const result = await cancelScheduled({ data: { wabaId, key: scheduled.key } });
        if (!result.ok) return failureCopy(result);
        const { state, scheduled: current } = result.data;
        if (state === "not_pending" || (state === "unchanged" && current?.status !== "cancelled")) {
          onCancelled();
          return {
            title: "Too late to cancel",
            detail: `It already ended: ${current ? endedPhrase(current) : "is being sent"}.`,
          };
        }
        return null;
      }}
      onOpenChange={onOpenChange}
      onDone={onCancelled}
    />
  );
}
