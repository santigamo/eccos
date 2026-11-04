import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { BroadcastSummary } from "@eccos/gateway-contract";
import { cancelBroadcast } from "../../server/gateway";
import { failureCopy } from "../../lib/failure";
import { followSignIn } from "../../lib/follow-sign-in";

/** What cancelling THIS broadcast costs, in the system's own terms. */
export function cancelConfirmCopy(counts: BroadcastSummary["counts"]): string {
  const waiting = counts.queued + counts.sending;
  return `${waiting} recipients not yet sent will not be messaged. The ${counts.sent} already sent stay sent. A cancelled broadcast cannot be resumed.`;
}

/**
 * Confirm and cancel a running broadcast: a one-click destructive act, so the
 * AlertDialog register. The server decides who may; a refusal reads in the dialog.
 */
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
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);

  async function onConfirm() {
    setCancelling(true);
    setError(null);
    try {
      const result = await cancelBroadcast({ data: { wabaId, broadcastId: broadcast.id } });
      if (!result.ok) {
        setError(failureCopy(result));
        return;
      }
      onCancelled();
      onOpenChange(false);
    } catch (thrown) {
      if (followSignIn(thrown)) return;
      setError({ title: "Could not cancel", detail: thrown instanceof Error ? thrown.message : String(thrown) });
    } finally {
      setCancelling(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => (cancelling ? undefined : onOpenChange(open))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this broadcast?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block font-mono text-[11px] break-all text-foreground">
              {broadcast.template.name} {"·"} {broadcast.template.language}
            </span>
            <span className="mt-1 block">{cancelConfirmCopy(broadcast.counts)}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <output aria-live="polite" aria-atomic="true">
          {error ? (
            <span className="block">
              <span className="block text-xs text-[#ff7777]">{error.title}</span>
              <span className="block text-xs text-muted-foreground">{error.detail}</span>
            </span>
          ) : null}
        </output>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={cancelling}>Keep sending</AlertDialogCancel>
          <AlertDialogAction type="button" onClick={onConfirm} aria-busy={cancelling} disabled={cancelling}>
            {cancelling ? "Cancelling…" : "Cancel broadcast"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
