import { useState } from "react";
import { MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { MembersMutation, MemberView } from "../../members";
import { isOwnerRole, roleLabel } from "../../lib/member-roles";
import { StatusTag, fmtTsShort } from "../../ui";
import { ChangeRoleDialog } from "./change-role-dialog";
import { RemoveMemberDialog } from "./remove-member-dialog";
import { IDENTITY_TIER, MACHINE_CLASS, ROW, SECONDARY_TIER, SUPPORT_TIER, TALL_CELL, Th } from "./plain-table";

type Open = { act: "role" | "remove"; member: MemberView };

/**
 * The workspace's members. Change role and Remove share one kebab (data rule
 * 5), on rows the caller may act on: never their own, and an owner's only for
 * another owner, who may remove but not demote them here.
 */
export function MembersTable({
  members,
  callerRole,
  onChanged,
}: {
  members: MemberView[];
  callerRole: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const [error, setError] = useState<string | null>(null);
  const callerIsOwner = isOwnerRole(callerRole);

  // A refusal stays in its dialog; a member that is gone closes it and is said here.
  function onResult(result: MembersMutation) {
    if (result.ok) setError(null);
    else if (result.gone) setError(result.error);
    if (result.ok || result.gone) onChanged();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-y border-(--line)">
              <Th width="45%">Member</Th>
              <Th width="20%">Role</Th>
              <Th width="25%">Joined</Th>
              <Th srOnly>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const owner = isOwnerRole(member.role);
              const canChangeRole = !member.isSelf && !owner;
              const canRemove = !member.isSelf && (!owner || callerIsOwner);
              const who = member.name || member.email;
              return (
                <tr key={member.memberId} className={ROW}>
                  <td className={`${TALL_CELL}`}>
                    <span className={IDENTITY_TIER}>{member.name || member.email}</span>
                    {member.isSelf ? <span className={`ml-2 ${MACHINE_CLASS}`}>You</span> : null}
                    {member.name ? <span className={`block ${SECONDARY_TIER}`}>{member.email}</span> : null}
                  </td>
                  <td className={`${TALL_CELL}`}>
                    <StatusTag status={roleLabel(member.role)} />
                  </td>
                  <td className={`${TALL_CELL} whitespace-nowrap ${SUPPORT_TIER}`}>{fmtTsShort(member.joinedAt)}</td>
                  <td className={`${TALL_CELL} text-right`}>
                    {canChangeRole || canRemove ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="rounded-none"
                              aria-label={`Actions for ${who}`}
                            />
                          }
                        >
                          <MoreHorizontalIcon aria-hidden="true" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-40">
                          {canChangeRole ? (
                            <DropdownMenuItem onClick={() => setOpen({ act: "role", member })}>Change role</DropdownMenuItem>
                          ) : null}
                          {canRemove ? (
                            <DropdownMenuItem variant="destructive" onClick={() => setOpen({ act: "remove", member })}>
                              Remove
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
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
      {open?.act === "role" ? (
        <ChangeRoleDialog target={open.member} onOpenChange={(next) => !next && setOpen(null)} onResult={onResult} />
      ) : null}
      {open?.act === "remove" ? (
        <RemoveMemberDialog target={open.member} onOpenChange={(next) => !next && setOpen(null)} onResult={onResult} />
      ) : null}
    </div>
  );
}
