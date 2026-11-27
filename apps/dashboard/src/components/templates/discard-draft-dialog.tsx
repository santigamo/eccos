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

/** What leaving costs, in the operator's terms; it costs something else mid-submit. */
export function discardDraftCopy(submitting: boolean, editing = false): string {
  if (submitting) {
    return editing
      ? "This edit is still being submitted. Leaving now abandons Meta's answer to an edit that may already have been applied."
      : "This template is still being submitted. Leaving now abandons Meta's answer to a creation that may already have succeeded.";
  }
  return editing
    ? "Nothing has been changed at Meta yet. The edits typed here are lost."
    : "Nothing has been created yet. The name, body, examples, footer and buttons typed here are lost.";
}

/**
 * The one question between unsent work and an in-app navigation away from it.
 * Confirm register: Escape means Keep editing, and the draft survives.
 */
export function DiscardDraftDialog({
  submitting,
  editing,
  onKeep,
  onDiscard,
}: {
  submitting: boolean;
  editing: boolean;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onKeep();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{editing ? "Discard these changes?" : "Discard this draft?"}</AlertDialogTitle>
          <AlertDialogDescription>{discardDraftCopy(submitting, editing)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction type="button" onClick={onDiscard}>
            Discard draft
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
