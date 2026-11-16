import { useState } from "react";
import { MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cancelInvitation, resendInvitation, type InvitationView } from "../../members";
import { roleLabel } from "../../lib/member-roles";
import { fmtTsShort } from "../../ui";
import { CELL, MACHINE_CLASS, ROW, Th } from "./plain-table";

/**
 * Pending invitations. Resend and Cancel both write, so they share one kebab
 * (data rule 5). Resend sends a fresh invitation and the old link stops working.
 */
export function InvitationsTable({
  invitations,
  onChanged,
}: {
  invitations: InvitationView[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (invitations.length === 0) {
    return (
      <div className="flex flex-col gap-1.5 border-t border-(--line) pt-3">
        <p className={`m-0 ${MACHINE_CLASS}`}>No pending invitations</p>
        <p className="m-0 max-w-prose text-sm text-pretty text-muted-foreground">
          An invitation emails a link to join this workspace with the role you choose. It works for 7
          days, for whoever signs in with that address.
        </p>
      </div>
    );
  }

  async function act(run: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setBusy(true);
    setError(null);
    try {
      const result = await run();
      if (!result.ok) setError(result.error);
      else onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" aria-busy={busy}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-y border-(--line)">
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Invited by</Th>
              <Th>Expires</Th>
              <Th srOnly>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {invitations.map((invitation) => (
              <tr key={invitation.id} className={ROW}>
                <td className={`${CELL} font-mono text-xs text-foreground`}>{invitation.email}</td>
                <td className={`${CELL} text-foreground`}>{roleLabel(invitation.role)}</td>
                <td className={`${CELL} text-muted-foreground`}>{invitation.inviterName || "—"}</td>
                <td className={`${CELL} font-mono text-xs whitespace-nowrap`}>
                  {invitation.expired ? (
                    <span className="text-warning-foreground">Expired {fmtTsShort(invitation.expiresAt)}</span>
                  ) : (
                    <span className="text-muted-foreground">{fmtTsShort(invitation.expiresAt)}</span>
                  )}
                </td>
                <td className={`${CELL} text-right`}>
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
      <output
        aria-live="polite"
        aria-atomic="true"
        className={error ? "block border-l-2 border-l-destructive px-3 py-2 text-sm text-foreground" : undefined}
      >
        {error}
      </output>
    </div>
  );
}
