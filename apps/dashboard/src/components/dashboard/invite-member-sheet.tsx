import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { inviteMember, type MemberRole } from "../../members";
import { RoleChoices } from "./role-choices";

const LABEL = "mb-1 block text-[11px] font-medium tracking-wider text-muted-foreground uppercase";

/**
 * The invite form, router-free so tests render it without the sheet's dialog
 * context. The role is three radio cards, each with the one line that says
 * what the role can do.
 */
export function InviteMemberForm({
  organizationId,
  onBusyChange,
  onDirtyChange,
  onInvited,
}: {
  /** The workspace the page shows; the server refuses if the session has moved to another. */
  organizationId: string;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onInvited?: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("operator");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const result = await inviteMember({ data: { email, role, organizationId } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onInvited?.();
    } finally {
      setSending(false);
      onBusyChange?.(false);
    }
  }

  return (
    <form onSubmit={onSubmit} aria-busy={sending} className="flex flex-col gap-5 px-4 pb-4">
      <fieldset disabled={sending} className="contents">
        <div>
          <label htmlFor="invite-email" className={LABEL}>
            Email
          </label>
          <Input
            id="invite-email"
            type="email"
            required
            autoComplete="off"
            maxLength={320}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              onDirtyChange?.(event.target.value.trim() !== "");
            }}
            placeholder="name@company.com"
          />
        </div>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className={LABEL}>Role</legend>
          <RoleChoices name="invite-role" value={role} onChange={setRole} />
        </fieldset>
        <div>
          <Button type="submit">{sending ? "Sending…" : "Send invitation"}</Button>
        </div>
      </fieldset>
      {/* Mounted even when empty: a live region that fills up is announced. */}
      <output aria-live="polite" aria-atomic="true" className={error ? "block text-xs text-destructive-foreground" : undefined}>
        {error}
      </output>
    </form>
  );
}

/**
 * Invite a person, in the task register: a form beside the members list. A
 * typed address or a send in flight refuses backdrop and Escape; the X always
 * closes.
 */
export function InviteMemberSheet({
  organizationId,
  onOpenChange,
  onInvited,
}: {
  organizationId: string;
  onOpenChange: (open: boolean) => void;
  onInvited: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const guarded = busy || dirty;
  return (
    <Sheet
      open
      disablePointerDismissal={guarded}
      onOpenChange={(next, details) => {
        if (!next && guarded && details.reason !== "close-press") {
          details.cancel();
          return;
        }
        onOpenChange(next);
      }}
    >
      <SheetContent side="right" className="gap-2 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader className="gap-2">
          <SheetTitle className="text-sm">Invite member</SheetTitle>
          <SheetDescription>
            They get an email with a link to join this workspace. It works for 7 days.
          </SheetDescription>
        </SheetHeader>
        <InviteMemberForm organizationId={organizationId} onBusyChange={setBusy} onDirtyChange={setDirty} onInvited={onInvited} />
      </SheetContent>
    </Sheet>
  );
}
