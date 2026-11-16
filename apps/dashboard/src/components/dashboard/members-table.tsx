import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updateMemberRole, type MemberRole, type MemberView } from "../../members";
import { ROLE_OPTIONS, isOwnerRole, roleLabel } from "../../lib/member-roles";
import { fmtTsShort } from "../../ui";
import { RemoveMemberDialog } from "./remove-member-dialog";
import { CELL, MACHINE_CLASS, ROW, Th } from "./plain-table";

/**
 * The workspace's members. A role select only on rows the caller may change,
 * which is never their own and never an owner's (the owner role is not
 * offered); Remove on rows the caller may remove. Everything else holds the
 * column with an em-dash.
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
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<MemberView | null>(null);
  const callerIsOwner = isOwnerRole(callerRole);

  async function onRole(member: MemberView, role: MemberRole) {
    setSaving(member.memberId);
    setError(null);
    try {
      const result = await updateMemberRole({ data: { memberId: member.memberId, role } });
      if (!result.ok) setError(result.error);
      else onChanged();
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-y border-(--line)">
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Joined</Th>
              <Th srOnly>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const owner = isOwnerRole(member.role);
              const canChangeRole = !member.isSelf && !owner;
              const canRemove = !member.isSelf && (!owner || callerIsOwner);
              return (
                <tr key={member.memberId} className={ROW}>
                  <td className={`${CELL} text-foreground`}>
                    {member.name || "—"}
                    {member.isSelf ? <span className={`ml-2 ${MACHINE_CLASS}`}>You</span> : null}
                  </td>
                  <td className={`${CELL} font-mono text-xs text-muted-foreground`}>{member.email}</td>
                  <td className={CELL}>
                    {canChangeRole ? (
                      <Select
                        value={member.role}
                        disabled={saving !== null}
                        onValueChange={(value) => {
                          if (value && value !== member.role) void onRole(member, value as MemberRole);
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-32 rounded-none"
                          aria-label={`Role of ${member.name || member.email}`}
                        >
                          <SelectValue>{(value: string | null) => roleLabel(value ?? "")}</SelectValue>
                        </SelectTrigger>
                        <SelectContent align="start">
                          {ROLE_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-foreground">{roleLabel(member.role)}</span>
                    )}
                  </td>
                  <td className={`${CELL} font-mono text-xs whitespace-nowrap text-muted-foreground`}>
                    {fmtTsShort(member.joinedAt)}
                  </td>
                  <td className={`${CELL} text-right`}>
                    {canRemove ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => setRemoving(member)}>
                        Remove
                      </Button>
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
      {removing ? (
        <RemoveMemberDialog
          target={removing}
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          onRemoved={onChanged}
        />
      ) : null}
    </div>
  );
}
