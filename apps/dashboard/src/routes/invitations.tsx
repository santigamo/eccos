import { createFileRoute, getRouteApi, isNotFound, isRedirect, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { acceptInvitation, acceptInviteInput, getInvitation, type InvitationFailure } from "../organizations";
import { authClient } from "../auth/auth-client";
import { signInHref } from "../auth/redirect-target";
import { followSignIn } from "../lib/follow-sign-in";
import { INVITATION_BAD_LINK, INVITATION_RETRY, SIGN_OUT_RETRY } from "../lib/invitation-copy";
import { Button } from "../components/ui/button";
import { FrameDescription, FrameHeader, FrameTitle } from "../components/reui/frame";
import { AuthCard, AUTH_ERROR_BANNER_CLASS } from "../components/auth/auth-page";

type InvitationsSearch = { id?: string };

/** `null` when the link carries no invitation id. */
type InvitationRead = Awaited<ReturnType<typeof getInvitation>> | null;

const RETRY: InvitationFailure = { ok: false, kind: "retry", error: INVITATION_RETRY };

/** Sign-in, returning to this invitation as whoever signs in. */
export function invitationSignInHref(id: string | undefined): string {
  return signInHref(id ? `/invitations?id=${encodeURIComponent(id)}` : "/invitations");
}

/**
 * The loader's whole decision. An id the server function's validator would
 * refuse is answered here, a lapsed session goes to sign-in, and a throw that
 * got past the server function reads as transient, so the page keeps its own
 * copy and ways out instead of the router's error boundary.
 */
export async function loadInvitation(id: string | undefined, read = getInvitation): Promise<InvitationRead> {
  if (id === undefined) return null;
  const input = acceptInviteInput.safeParse({ invitationId: id });
  if (!input.success) return { ok: false, kind: "unavailable", error: INVITATION_BAD_LINK };
  const invitation = await read({ data: input.data }).catch((err: unknown): InvitationFailure => {
    if (isRedirect(err) || isNotFound(err)) throw err;
    return RETRY;
  });
  if (!invitation.ok && invitation.kind === "signed-out") {
    throw redirect({ href: invitationSignInHref(id), reloadDocument: true });
  }
  return invitation;
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
  const router = useRouter();
  const invitationId = Route.useSearch().id;
  const loaded = Route.useLoaderData();
  const user = root.useLoaderData({ select: (data) => data.user });
  const [refused, setRefused] = useState<InvitationFailure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    document.title = "Accept invitation · Eccos";
  }, []);

  // A refusal belongs to the invitation it was about.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new link, not on every render.
  useEffect(() => {
    setRefused(null);
    setError(null);
  }, [invitationId]);

  async function accept() {
    if (!invitationId) return;
    setError(null);
    setPending(true);
    let result: Awaited<ReturnType<typeof acceptInvitation>>;
    try {
      result = await acceptInvitation({ data: { invitationId } });
    } catch (err) {
      if (followSignIn(err)) return;
      result = RETRY;
    }
    if (result.ok) {
      // Accepting made the joined workspace the session's active one; a full
      // load re-resolves the tenant there. Stays pending until the document goes.
      window.location.assign("/");
      return;
    }
    if (result.kind === "signed-out") {
      window.location.assign(invitationSignInHref(invitationId));
      return;
    }
    // Asking again cannot change "unavailable", so it replaces the invitation
    // and takes the Accept button with it.
    if (result.kind === "unavailable") setRefused(result);
    else setError(result.error);
    setPending(false);
  }

  async function signOut() {
    setError(null);
    setSigningOut(true);
    try {
      const result = await authClient.signOut();
      if (result.error) throw result.error;
    } catch {
      // Still signed in: leaving for /signin would bounce straight back here.
      setError(SIGN_OUT_RETRY);
      setSigningOut(false);
      return;
    }
    window.location.assign(invitationSignInHref(invitationId));
  }

  return (
    <InvitationsView
      invitation={refused ?? loaded}
      error={error}
      pending={pending}
      onAccept={() => void accept()}
      onRetry={() => void router.invalidate()}
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
  onRetry,
  signedInAs,
  hasWorkspace,
  signingOut,
  onSignOut,
}: {
  invitation: InvitationRead;
  error: string | null;
  pending: boolean;
  onAccept: () => void;
  onRetry: () => void;
  signedInAs: string | null;
  /** Without one the page renders bare, so it carries its own ways out. */
  hasWorkspace: boolean;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const failure = invitation && !invitation.ok ? invitation : null;
  const shown = error ?? failure?.error ?? null;
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
        ) : failure?.kind === "retry" ? (
          <>
            <FrameTitle>This invitation could not be loaded</FrameTitle>
            <FrameDescription>The invitation was not checked. Try again in a moment.</FrameDescription>
          </>
        ) : (
          <>
            <FrameTitle>{failure ? "This invitation cannot be opened" : "No invitation in this link"}</FrameTitle>
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
      ) : failure?.kind === "retry" ? (
        <Button type="button" onClick={onRetry}>
          Try again
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
