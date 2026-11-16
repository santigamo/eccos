import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { updateMemberRole, type MemberRole, type MembersMutation, type MemberView } from "../../members";
import { roleInSentence } from "../../lib/member-roles";
import { RoleChoices } from "./role-choices";
import { followSignIn } from "../../lib/follow-sign-in";
import { MEMBERS_RETRY } from "../../lib/members-copy";

/** What moving from one role to another costs, or null when it costs nothing worth saying. */
export function roleChangeCost(from: string, to: MemberRole): string | null {
  if (from === to) return null;
  if (from === "admin") {
    return "They stop managing numbers, API keys, billing and members, and the connection link they made stops working.";
  }
  if (to === "admin") return "They will manage numbers, API keys, billing and members.";
  return null;
}

/**
 * Change one member's role. A decision read before it is written: the three
 * roles with their lines, the cost of the move, and nothing saved until
 * "Change role".
 */
export function ChangeRoleDialog({
  target,
  onOpenChange,
  onResult,
}: {
  target: MemberView;
  onOpenChange: (open: boolean) => void;
  /** Every answer, so the page can re-read on success or on a member that is gone. */
  onResult: (result: MembersMutation) => void;
}) {
  const [role, setRole] = useState<MemberRole | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cost = role ? roleChangeCost(target.role, role) : null;

  async function onConfirm() {
    if (!role) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateMemberRole({ data: { memberId: target.memberId, role } });
      onResult(result);
      if (result.ok || result.gone) onOpenChange(false);
      else setError(result.error);
    } catch (err) {
      if (!followSignIn(err)) setError(MEMBERS_RETRY);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      disablePointerDismissal={saving}
      onOpenChange={(next, details) => {
        if (!next && saving && details.reason !== "close-press") {
          details.cancel();
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change role</DialogTitle>
          <DialogDescription>
            {target.name || target.email} is {roleInSentence(target.role)}.
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={saving} className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="sr-only">New role</legend>
          <RoleChoices name="change-role" value={role} current={target.role} onChange={setRole} />
        </fieldset>
        <output aria-live="polite" aria-atomic="true" className="flex flex-col gap-1 empty:hidden">
          {cost ? <span className="block text-sm text-warning-foreground">{cost}</span> : null}
          {error ? <span className="block text-xs text-destructive-foreground">{error}</span> : null}
        </output>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            aria-busy={saving}
            disabled={saving || !role || role === target.role}
          >
            {saving ? "Saving…" : "Change role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
