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
import { deleteTemplate } from "../../server/gateway";
import { failureCopy } from "../../lib/failure";

/**
 * What deleting THIS row actually costs, in Meta's own terms.
 *
 * Status-dependent because the consequence is: deleting an APPROVED template
 * blocks its name from being reused for 30 days — documented by Meta for
 * approved templates only. For a pending or rejected draft no such lock is
 * documented, and inventing a hedge ("this may block the name…") would be the
 * console guessing out loud. Exported so the wording is asserted directly.
 */
export function deleteConfirmCopy(status: string | undefined): string {
  return status?.toUpperCase() === "APPROVED"
    ? "Deleting an approved template blocks its name from reuse for 30 days."
    : "This permanently removes the template.";
}

/** The one template translation the dialog is open for. */
export interface DeleteTarget {
  templateId: string;
  name: string;
  language: string;
  status: string | undefined;
}

interface DeleteTemplateDialogProps {
  wabaId: string;
  target: DeleteTarget;
  onOpenChange: (open: boolean) => void;
  /** Called once Meta has removed it, so the route can re-read the list. */
  onDeleted?: () => void;
}

/**
 * Confirm and delete ONE translation of a template.
 *
 * The row carries a name AND a language, so the delete carries the Graph id
 * (`hsm_id`) that identifies that pair — Meta's name-only form would take every
 * language of the template with it, which is never what a row-level button
 * should do.
 */
export function DeleteTemplateDialog({
  wabaId,
  target,
  onOpenChange,
  onDeleted,
}: DeleteTemplateDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);

  async function onConfirm() {
    setDeleting(true);
    setError(null);
    try {
      const result = await deleteTemplate({
        data: { wabaId, name: target.name, templateId: target.templateId },
      });
      if (!result.ok) {
        // A boundary failure (unreachable / unauthenticated / forbidden) keeps
        // its own mapping — a role without `configure` lands here and reads as
        // "Not available to your role", not as a dead gateway.
        const copy = failureCopy(result);
        setError({ title: copy.title, detail: copy.detail });
        return;
      }
      if (!result.data.ok) {
        setError({
          title: "Meta refused the deletion",
          detail: result.data.detail ?? "Meta refused it without saying why.",
        });
        return;
      }
      onDeleted?.();
      onOpenChange(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this template?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block font-mono text-[11px] break-all text-foreground">
              {target.name} {"·"} {target.language}
            </span>
            <span className="mt-1 block">{deleteConfirmCopy(target.status)}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Mounted even when empty: a live region that appears with its message
            is not reliably announced, one that fills up is. */}
        <output aria-live="polite" aria-atomic="true">
          {error ? (
            <span className="block">
              <span className="block text-xs text-[#ff7777]">{error.title}</span>
              <span className="block text-xs text-muted-foreground">{error.detail}</span>
            </span>
          ) : null}
        </output>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            type="button"
            onClick={onConfirm}
            aria-busy={deleting}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : "Delete template"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
