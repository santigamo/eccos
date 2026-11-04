import type { ScheduledSend } from "@eccos/gateway-contract";
import { cancelScheduled } from "../../server/gateway";
import { failureCopy } from "../../lib/failure";
import { endedPhrase } from "../../lib/scheduled";
import { fmtTs } from "../../ui";
import { CancelDialog } from "../sending/cancel-dialog";

/** What cancelling THIS scheduled send costs, in the system's own terms. */
export function cancelScheduledCopy(row: Pick<ScheduledSend, "to" | "sendAt">): string {
  return `It will not be sent to ${row.to} at ${fmtTs(row.sendAt)}. A PUT on the same key schedules it again.`;
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
