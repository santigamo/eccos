import { createFileRoute } from "@tanstack/react-router";
import { acceptInvitation } from "../organizations";
import { Page } from "../ui";

type InvitationsSearch = { id?: string };

export const Route = createFileRoute("/invitations")({
  validateSearch: (search: Record<string, unknown>): InvitationsSearch => {
    const id = typeof search.id === "string" ? search.id : undefined;
    return id ? { id } : {};
  },
  component: InvitationsPage,
});

/**
 * Invitation acceptance screen (eccos-0x0.5, contract §7). The invitation id in
 * the URL is a pointer, not a capability: acceptance requires the signed-in
 * matching verified identity, enforced by the auth API and re-checked here.
 */
function InvitationsPage() {
  // The invitation id comes from the accept link (/invitations?id=...).
  const invitationId = Route.useSearch().id;

  async function accept() {
    const result = await acceptInvitation({ data: { invitationId } });
    if (!result.ok) {
      // Rendered inline; fail closed on stale/expired/mismatched invitations.
      window.alert(result.error);
      return;
    }
    window.location.assign("/");
  }

  return (
    <main id="main-content" className="min-h-svh px-4 py-6 md:px-8 md:py-8">
      <Page title="Accept invitation" kicker="Invitations">
        <p>
          Accepting joins the existing workspace and its resources. No new account is created.
        </p>
        <button type="button" onClick={() => void accept()}>
          Accept invitation
        </button>
      </Page>
    </main>
  );
}

