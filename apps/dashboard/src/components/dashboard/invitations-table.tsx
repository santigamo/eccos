import { useState } from "react";
import { MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cancelInvitation, resendInvitation, type InvitationView, type MembersMutation } from "../../members";
import { roleLabel } from "../../lib/member-roles";
import { INVITATION_LIFETIME_DAYS, expiresIn } from "../../lib/invitation-expiry";
import { followSignIn } from "../../lib/follow-sign-in";
import { MEMBERS_RETRY } from "../../lib/members-copy";
import { StatusTag, fmtTsShort } from "../../ui";
import { IDENTITY_TIER, MACHINE_CLASS, ROW, SECONDARY_TIER, SUPPORT_TIER, TALL_CELL, Th } from "./plain-table";

/**
 * Pending invitations. Resend and Cancel both write, so they share one kebab
 * (data rule 5). Resend sends a fresh invitation and the old link stops working.
 */
export function InvitationsTable({
  invitations,
  onChanged,
  now = Date.now(),
}: {
  invitations: InvitationView[];
  onChanged: () => void;
  now?: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(run: () => Promise<MembersMutation>) {
    setBusy(true);
    setError(null);
    try {
      const result = await run();
      if (!result.ok) setError(result.error);
      if (result.ok || result.gone) onChanged();
    } catch (err) {
      if (!followSignIn(err)) setError(MEMBERS_RETRY);
    } finally {
      setBusy(false);
    }
  }

  // Mounted in both branches: the last row's failure lands after it has left.
  const output = (
    <output
      aria-live="polite"
      aria-atomic="true"
      className={error ? "block border-l-2 border-l-destructive px-3 py-2 text-sm text-foreground" : undefined}
    >
      {error}
    </output>
  );

  if (invitations.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5 border-t border-(--line) pt-3">
          <p className={`m-0 ${MACHINE_CLASS}`}>No pending invitations</p>
          <p className={`m-0 max-w-prose text-pretty ${SUPPORT_TIER}`}>
            An invitation emails a link to join this workspace with the role you choose. It works for{" "}
            {INVITATION_LIFETIME_DAYS} days, for whoever signs in with that address.
          </p>
        </div>
        {output}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" aria-busy={busy}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-y border-(--line)">
              <Th width="35%">Email</Th>
              <Th width="15%">Role</Th>
              <Th width="20%">Invited by</Th>
              <Th width="20%">Expires</Th>
              <Th srOnly>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {invitations.map((invitation) => (
              <tr key={invitation.id} className={ROW}>
                <td className={`${TALL_CELL} ${IDENTITY_TIER}`}>{invitation.email}</td>
                <td className={`${TALL_CELL}`}>
                  <StatusTag status={roleLabel(invitation.role)} />
                </td>
                <td className={`${TALL_CELL} ${SUPPORT_TIER}`}>{invitation.inviterName || "—"}</td>
                <td className={`${TALL_CELL} whitespace-nowrap`}>
                  <span className={`block text-sm ${invitation.expired ? "text-warning-foreground" : "text-foreground"}`}>
                    {invitation.expired ? "Expired" : expiresIn(invitation.expiresAt, now)}
                  </span>
                  <span className={`block font-mono ${SECONDARY_TIER}`}>{fmtTsShort(invitation.expiresAt)}</span>
                </td>
                <td className={`${TALL_CELL} text-right`}>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      disabled={busy}
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="rounded-none"
                          aria-label={`Actions for the invitation to ${invitation.email}`}
                        />
                      }
                    >
                      <MoreHorizontalIcon aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-40">
                      <DropdownMenuItem
                        onClick={() => void act(() => resendInvitation({ data: { invitationId: invitation.id } }))}
                      >
                        Resend
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => void act(() => cancelInvitation({ data: { invitationId: invitation.id } }))}
                      >
                        Cancel invitation
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {output}
    </div>
  );
}
