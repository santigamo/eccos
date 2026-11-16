import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Page } from "../ui";
import { invalidatePage } from "../lib/invalidate";
import { ASK_TO_MANAGE_MEMBERS } from "../lib/members-copy";
import { listWorkspaceMembers, type MembersPage } from "../members";
import { MembersTable } from "../components/dashboard/members-table";
import { InvitationsTable } from "../components/dashboard/invitations-table";
import { InviteMemberSheet } from "../components/dashboard/invite-member-sheet";
import { MACHINE_CLASS } from "../components/dashboard/plain-table";

const TITLE = "Members";
const KICKER = "Workspace";

export const Route = createFileRoute("/members")({
  loader: () => listWorkspaceMembers(),
  component: MembersRoute,
  pendingComponent: () => (
    <Page title={TITLE} kicker={KICKER}>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </div>
    </Page>
  ),
});

function MembersRoute() {
  const result = Route.useLoaderData();
  const router = useRouter();
  // A role without `administer` is refused by the server with ASK_TO_MANAGE_MEMBERS.
  if (!result.ok) return <MembersView error={result.error} />;
  return <MembersView page={result.data} onChanged={() => void invalidatePage(router)} />;
}

/** Router-free so tests render it directly, like `SettingsView` and `NumbersView`. */
export function MembersView({
  page,
  error,
  onChanged = () => {},
}: {
  page?: MembersPage;
  /** Shown instead of the lists: the refusal for a role without `administer`, or a failed read. */
  error?: string;
  onChanged?: () => void;
}) {
  const [inviting, setInviting] = useState(false);
  if (!page) {
    return (
      <Page title={TITLE} kicker={KICKER}>
        <p className="m-0 text-sm text-muted-foreground">{error ?? ASK_TO_MANAGE_MEMBERS}</p>
      </Page>
    );
  }
  return (
    <Page
      title={TITLE}
      kicker={KICKER}
      actions={
        <Button type="button" aria-haspopup="dialog" aria-expanded={inviting} onClick={() => setInviting(true)}>
          Invite member
        </Button>
      }
    >
      <div className="flex flex-col gap-8">
        <section className="flex flex-col gap-2">
          <h2 className={`m-0 ${MACHINE_CLASS}`}>Members</h2>
          <MembersTable members={page.members} callerRole={page.callerRole} onChanged={onChanged} />
        </section>
        <section className="flex flex-col gap-2">
          <h2 className={`m-0 ${MACHINE_CLASS}`}>Pending invitations</h2>
          <InvitationsTable invitations={page.invitations} onChanged={onChanged} />
        </section>
      </div>
      {inviting ? (
        <InviteMemberSheet
          onOpenChange={setInviting}
          onInvited={() => {
            setInviting(false);
            onChanged();
          }}
        />
      ) : null}
    </Page>
  );
}
