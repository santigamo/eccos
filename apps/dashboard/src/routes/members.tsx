import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Page } from "../ui";
import { invalidatePage } from "../lib/invalidate";
import { listWorkspaceMembers, type MembersPage } from "../members";
import type { Failure } from "../server/gateway";
import { FailureView } from "../components/dashboard/failure";
import { MembersTable } from "../components/dashboard/members-table";
import { InvitationsTable } from "../components/dashboard/invitations-table";
import { InviteMemberSheet } from "../components/dashboard/invite-member-sheet";
import { SectionHeading } from "../components/dashboard/plain-table";

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
  if (!result.ok) return <MembersView failure={result} />;
  return <MembersView page={result.data} onChanged={() => void invalidatePage(router)} />;
}

/** Router-free so tests render it directly, like `SettingsView` and `NumbersView`. */
export function MembersView({
  page,
  failure,
  onChanged = () => {},
}: {
  page?: MembersPage;
  /** The read's typed failure: a role without `administer`, no workspace chosen, signed out, unreachable. */
  failure?: Failure;
  onChanged?: () => void;
}) {
  const [inviting, setInviting] = useState(false);
  if (!page) {
    return (
      <Page title={TITLE} kicker={KICKER}>
        {failure ? <FailureView failure={failure} /> : null}
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
      <div className="flex flex-col gap-10">
        <section className="flex flex-col gap-3">
          <SectionHeading title="Members" count={page.members.length} />
          <MembersTable members={page.members} callerRole={page.callerRole} onChanged={onChanged} />
        </section>
        <section className="flex flex-col gap-3">
          <SectionHeading title="Pending invitations" count={page.invitations.length} />
          <InvitationsTable invitations={page.invitations} onChanged={onChanged} />
        </section>
      </div>
      {inviting ? (
        <InviteMemberSheet
          organizationId={page.organizationId}
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
