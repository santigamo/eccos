import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { acceptInvitation, getInvitation } from "../organizations";
import { followSignIn } from "../lib/follow-sign-in";
import { resetClientState } from "../hooks/client-state";
import { Button } from "../components/ui/button";
import { FrameDescription, FrameHeader, FrameTitle } from "../components/reui/frame";
import { AuthCard, AUTH_ERROR_BANNER_CLASS } from "../components/auth/auth-page";

type InvitationsSearch = { id?: string };

/** `null` when the link carries no invitation id. */
type InvitationRead = Awaited<ReturnType<typeof getInvitation>> | null;

export const Route = createFileRoute("/invitations")({
  validateSearch: (search: Record<string, unknown>): InvitationsSearch => {
    const id = typeof search.id === "string" ? search.id : undefined;
    return id ? { id } : {};
  },
  loaderDeps: ({ search }) => ({ id: search.id }),
  loader: ({ deps }): Promise<InvitationRead> =>
    deps.id ? getInvitation({ data: { invitationId: deps.id } }) : Promise.resolve(null),
  component: InvitationsPage,
});

const ACCEPT_FAILED = "Something went wrong with this invitation. Please try again.";

/**
 * Invitation acceptance screen (eccos-0x0.5, contract §7; restyled in
 * eccos-b5j). The invitation id in the URL is a pointer, not a capability:
 * acceptance requires the signed-in matching verified identity, enforced by
 * the auth API on both the read and the accept.
 */
function InvitationsPage() {
  const invitationId = Route.useSearch().id;
  const invitation = Route.useLoaderData();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    document.title = "Accept invitation · Eccos";
  }, []);

  async function accept() {
    if (!invitationId) return;
    setError(null);
    setPending(true);
    try {
      const result = await acceptInvitation({ data: { invitationId } });
      if (!result.ok) {
        setError(result.error);
        setPending(false);
        return;
      }
    } catch (err) {
      if (followSignIn(err)) return;
      setError(ACCEPT_FAILED);
      setPending(false);
      return;
    }
    // Accepting made the joined workspace the session's active one; a full
    // load re-resolves the tenant there. Stays pending until the document goes.
    resetClientState();
    window.location.assign("/");
  }

  return <InvitationsView invitation={invitation} error={error} pending={pending} onAccept={() => void accept()} />;
}

export function InvitationsView({
  invitation,
  error,
  pending,
  onAccept,
}: {
  invitation: InvitationRead;
  error: string | null;
  pending: boolean;
  onAccept: () => void;
}) {
  const shown = error ?? (invitation && !invitation.ok ? invitation.error : null);
  return (
    <AuthCard title="Accept invitation" kicker="Invitations">
      <FrameHeader>
        {invitation?.ok ? (
          <>
            <FrameTitle>Join {invitation.data.organizationName || "the workspace"}</FrameTitle>
            <FrameDescription>
              Accepting adds you to this existing workspace and its resources. No new workspace is created.
            </FrameDescription>
          </>
        ) : (
          <>
            <FrameTitle>{invitation ? "This invitation cannot be opened" : "No invitation in this link"}</FrameTitle>
            <FrameDescription>
              Open the link from your invitation email, signed in with the address it was sent to.
            </FrameDescription>
          </>
        )}
      </FrameHeader>
      {shown ? (
        <p className={AUTH_ERROR_BANNER_CLASS} role="alert">
          {shown}
        </p>
      ) : null}
      {invitation?.ok ? (
        <Button type="button" disabled={pending} onClick={onAccept}>
          {pending ? "Accepting…" : "Accept invitation"}
        </Button>
      ) : null}
    </AuthCard>
  );
}
