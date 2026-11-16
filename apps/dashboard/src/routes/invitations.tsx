import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { acceptInvitation, acceptInviteInput, getInvitation } from "../organizations";
import { authClient } from "../auth/auth-client";
import { signInHref } from "../auth/redirect-target";
import { followSignIn } from "../lib/follow-sign-in";
import { INVITATION_BAD_LINK, INVITATION_RETRY } from "../lib/invitation-copy";
import { Button } from "../components/ui/button";
import { FrameDescription, FrameHeader, FrameTitle } from "../components/reui/frame";
import { AuthCard, AUTH_ERROR_BANNER_CLASS } from "../components/auth/auth-page";

type InvitationsSearch = { id?: string };

/** `null` when the link carries no invitation id. */
type InvitationRead = Awaited<ReturnType<typeof getInvitation>> | null;

/** An id the server function's validator would refuse is answered here, not thrown at the router. */
export function loadInvitation(id: string | undefined): Promise<InvitationRead> {
  if (id === undefined) return Promise.resolve(null);
  const input = acceptInviteInput.safeParse({ invitationId: id });
  if (!input.success) return Promise.resolve({ ok: false, error: INVITATION_BAD_LINK });
  return getInvitation({ data: input.data });
}

export const Route = createFileRoute("/invitations")({
  validateSearch: (search: Record<string, unknown>): InvitationsSearch =>
    typeof search.id === "string" ? { id: search.id } : {},
  loaderDeps: ({ search }) => ({ id: search.id }),
  loader: ({ deps }) => loadInvitation(deps.id),
  component: InvitationsPage,
});

const root = getRouteApi("__root__");

/**
 * Invitation acceptance screen (eccos-0x0.5, contract §7; restyled in
 * eccos-b5j). The invitation id in the URL is a pointer, not a capability:
 * acceptance requires the signed-in matching verified identity, enforced by
 * the auth API on both the read and the accept.
 */
function InvitationsPage() {
  const invitationId = Route.useSearch().id;
  const invitation = Route.useLoaderData();
  const user = root.useLoaderData({ select: (data) => data.user });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

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
      setError(INVITATION_RETRY);
      setPending(false);
      return;
    }
    // Accepting made the joined workspace the session's active one; a full
    // load re-resolves the tenant there. Stays pending until the document goes.
    window.location.assign("/");
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      // Back to this invitation, through sign-in, as whoever signs in next.
      const here = invitationId ? `/invitations?id=${encodeURIComponent(invitationId)}` : "/invitations";
      window.location.assign(signInHref(here));
    }
  }

  return (
    <InvitationsView
      invitation={invitation}
      error={error}
      pending={pending}
      onAccept={() => void accept()}
      signedInAs={user?.email ?? null}
      hasWorkspace={(user?.workspaces.length ?? 0) > 0}
      signingOut={signingOut}
      onSignOut={() => void signOut()}
    />
  );
}

export function InvitationsView({
  invitation,
  error,
  pending,
  onAccept,
  signedInAs,
  hasWorkspace,
  signingOut,
  onSignOut,
}: {
  invitation: InvitationRead;
  error: string | null;
  pending: boolean;
  onAccept: () => void;
  signedInAs: string | null;
  /** Without one the page renders bare, so it carries its own ways out. */
  hasWorkspace: boolean;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const shown = error ?? (invitation && !invitation.ok ? invitation.error : null);
  const name = invitation?.ok ? invitation.data.organizationName || "the workspace" : "";
  const joined = invitation?.ok === true && invitation.data.joined;
  return (
    <AuthCard title="Accept invitation" kicker="Invitations">
      <FrameHeader>
        {invitation?.ok ? (
          <>
            <FrameTitle>{joined ? `You already joined ${name}` : `Join ${name}`}</FrameTitle>
            <FrameDescription>
              {joined
                ? "Your invitation was accepted. Open the workspace to continue."
                : "Accepting adds you to this existing workspace and its resources. No new workspace is created."}
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
          {joined ? (pending ? "Opening…" : "Open workspace") : pending ? "Accepting…" : "Accept invitation"}
        </Button>
      ) : null}
      {signedInAs ? (
        <div className="mt-5 flex flex-col items-start gap-2 border-t border-(--line) pt-4 text-sm text-muted-foreground">
          <p className="m-0">
            Signed in as <span className="text-foreground">{signedInAs}</span>
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button type="button" variant="outline" size="sm" disabled={signingOut} onClick={onSignOut}>
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
            {hasWorkspace ? null : (
              <a href="/onboarding" className="text-foreground underline-offset-4 hover:underline">
                Create a workspace instead
              </a>
            )}
          </div>
        </div>
      ) : null}
    </AuthCard>
  );
}
