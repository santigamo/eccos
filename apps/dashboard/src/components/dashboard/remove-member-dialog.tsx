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
import { removeMember, type MembersMutation, type MemberView } from "../../members";
import { isOwnerRole } from "../../lib/member-roles";
import { followSignIn } from "../../lib/follow-sign-in";
import { MEMBERS_RETRY } from "../../lib/members-copy";

/** What removing this member costs. Exported so the wording is asserted directly. */
export function removeMemberCopy(role: string): string[] {
  return [
    "Their access ends on their next request.",
    "API keys they created keep working. Revoke them in Settings if they should stop.",
    "Invitations they sent that are still pending are cancelled.",
    ...(role === "admin" || isOwnerRole(role) ? ["The connection link they made stops working."] : []),
  ];
}

export function RemoveMemberDialog({
  target,
  onOpenChange,
  onResult,
}: {
  target: MemberView;
  onOpenChange: (open: boolean) => void;
  /** Every answer, so the page can re-read on success or on a member that is gone. */
  onResult: (result: MembersMutation) => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setRemoving(true);
    setError(null);
    try {
      const result = await removeMember({ data: { memberId: target.memberId } });
      onResult(result);
      if (result.ok || result.gone) onOpenChange(false);
      else setError(result.error);
    } catch (err) {
      if (!followSignIn(err)) setError(MEMBERS_RETRY);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={(next) => (removing ? undefined : onOpenChange(next))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {target.name || target.email}?</AlertDialogTitle>
          <AlertDialogDescription>
            {removeMemberCopy(target.role).map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <output aria-live="polite" aria-atomic="true" className={error ? "block text-xs text-destructive-foreground" : undefined}>
          {error}
        </output>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
          <AlertDialogAction type="button" onClick={onConfirm} aria-busy={removing} disabled={removing}>
            {removing ? "Removing…" : "Remove member"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
