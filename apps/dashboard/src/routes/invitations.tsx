import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { acceptInvitation } from "../organizations";
import { Button } from "../components/ui/button";
import { FrameDescription, FrameHeader, FrameTitle } from "../components/reui/frame";
import { AuthCard, AUTH_ERROR_BANNER_CLASS } from "../components/auth/auth-page";

type InvitationsSearch = { id?: string };

export const Route = createFileRoute("/invitations")({
  validateSearch: (search: Record<string, unknown>): InvitationsSearch => {
    const id = typeof search.id === "string" ? search.id : undefined;
    return id ? { id } : {};
  },
  component: InvitationsPage,
});

/**
 * Invitation acceptance screen (eccos-0x0.5, contract §7; restyled in
 * eccos-b5j). The invitation id in the URL is a pointer, not a capability:
 * acceptance requires the signed-in matching verified identity, enforced by
 * the auth API and re-checked here.
 */
function InvitationsPage() {
  // The invitation id comes from the accept link (/invitations?id=...).
  const invitationId = Route.useSearch().id;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    document.title = "Accept invitation · Eccos";
  }, []);

  async function accept() {
    setError(null);
    setPending(true);
    const result = await acceptInvitation({ data: { invitationId } });
    setPending(false);
    if (!result.ok) {
      // Rendered inline; fail closed on stale/expired/mismatched invitations.
      setError(result.error);
      return;
    }
    window.location.assign("/");
  }

  return (
    <AuthCard title="Accept invitation" kicker="Invitations">
      <FrameHeader>
        <FrameTitle>Join the workspace</FrameTitle>
        <FrameDescription>
          Accepting joins the existing workspace and its resources. No new
          account is created.
        </FrameDescription>
      </FrameHeader>
      {error ? (
        <p className={AUTH_ERROR_BANNER_CLASS} role="alert">
          {error}
        </p>
      ) : null}
      <Button type="button" disabled={pending} onClick={() => void accept()}>
        {pending ? "Accepting…" : "Accept invitation"}
      </Button>
    </AuthCard>
  );
}
