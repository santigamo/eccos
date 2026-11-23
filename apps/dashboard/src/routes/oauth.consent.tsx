import type { ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AuthSplitShell } from "../components/blocks/auth-13/components/auth";
import { AUTHORIZATION_EXPIRED, OAuthConsentView } from "../components/blocks/auth-13/oauth-consent-view";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { getOAuthConsent } from "../oauth-consent";

type ConsentSearch = { client_id?: string; redirect_uri?: string; scope?: string };

/**
 * Display copies of three signed parameters. The page sends the raw signed
 * query back with its answer (`oauthProviderClient`), and Better Auth refuses
 * it if any of them was changed, so what is shown is what is answered.
 */
const text = (value: unknown) => (value === undefined || value === null ? undefined : String(value));

export const Route = createFileRoute("/oauth/consent")({
  validateSearch: (search: Record<string, unknown>): ConsentSearch => ({
    client_id: text(search.client_id),
    redirect_uri: text(search.redirect_uri),
    scope: text(search.scope),
  }),
  loaderDeps: ({ search }) => ({ clientId: search.client_id }),
  loader: ({ deps }) => (deps.clientId ? getOAuthConsent({ data: { clientId: deps.clientId } }) : null),
  pendingComponent: ConsentPending,
  component: ConsentPage,
});

function hostOf(uri: string | undefined): string | null {
  try {
    return uri ? new URL(uri).host : null;
  } catch {
    return null;
  }
}

function ConsentPage() {
  const details = Route.useLoaderData();
  const { redirect_uri, scope } = Route.useSearch();
  const redirectHost = hostOf(redirect_uri);
  if (!details?.clientName || !redirectHost || !scope) {
    return <ConsentNotice title="Nothing to approve" body={AUTHORIZATION_EXPIRED} />;
  }
  if (!details.workspace) {
    return (
      <ConsentNotice
        title="Choose a workspace first"
        body="The agent works in one workspace. Choose it, then come back to this step."
        action={
          <Button type="button" onClick={() => window.location.assign(`/oauth/workspace${window.location.search}`)}>
            Choose a workspace
          </Button>
        }
      />
    );
  }
  return (
    <OAuthConsentView
      clientName={details.clientName}
      redirectHost={redirectHost}
      workspaceName={details.workspace.name || details.workspace.id}
      scope={scope}
    />
  );
}

function ConsentNotice({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <AuthSplitShell>
      <div className="mx-auto flex w-full max-w-[22rem] flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl leading-tight font-semibold text-balance">{title}</h1>
          <p className="text-muted-foreground text-base text-pretty">{body}</p>
        </div>
        {action}
      </div>
    </AuthSplitShell>
  );
}

function ConsentPending() {
  return (
    <AuthSplitShell>
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <h1 className="text-3xl leading-tight font-semibold text-balance">Connect an agent</h1>
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </AuthSplitShell>
  );
}
