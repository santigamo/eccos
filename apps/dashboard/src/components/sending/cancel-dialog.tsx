import { useState } from "react";
import type { ReactNode } from "react";
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
import { followSignIn } from "../../lib/follow-sign-in";

export type CancelError = { title: string; detail: string };

/**
 * The confirm-and-cancel shell for a one-click destructive act on outbound traffic
 * (AlertDialog register): busy state, a refusal read in the dialog, no closing while
 * the call is in flight. `onConfirm` returns the refusal to show, or null once done.
 */
export function CancelDialog({
  title,
  description,
  keepLabel,
  confirmLabel,
  busyLabel,
  onConfirm,
  onOpenChange,
  onDone,
}: {
  title: string;
  description: ReactNode;
  keepLabel: string;
  confirmLabel: string;
  busyLabel: string;
  onConfirm: () => Promise<CancelError | null>;
  onOpenChange: (open: boolean) => void;
  /** Called once the act is done, so the route re-reads. */
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CancelError | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const refusal = await onConfirm();
      if (refusal) {
        setError(refusal);
        return;
      }
      onDone();
      onOpenChange(false);
    } catch (thrown) {
      if (followSignIn(thrown)) return;
      setError({ title: "Could not cancel", detail: thrown instanceof Error ? thrown.message : String(thrown) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => (busy ? undefined : onOpenChange(open))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
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
          <AlertDialogCancel disabled={busy}>{keepLabel}</AlertDialogCancel>
          <AlertDialogAction type="button" onClick={confirm} aria-busy={busy} disabled={busy}>
            {busy ? busyLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
