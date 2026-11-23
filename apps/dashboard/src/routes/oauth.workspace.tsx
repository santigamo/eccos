import { createFileRoute } from "@tanstack/react-router";
import { AuthSplitShell } from "../components/blocks/auth-13/components/auth";
import { OAuthWorkspaceView } from "../components/blocks/auth-13/oauth-workspace-view";
import { Skeleton } from "../components/ui/skeleton";
import { getSessionUser } from "../organizations";

export const Route = createFileRoute("/oauth/workspace")({
  loader: async () => (await getSessionUser())?.workspaces ?? [],
  pendingComponent: WorkspacePending,
  component: WorkspacePage,
});

function WorkspacePage() {
  return <OAuthWorkspaceView workspaces={Route.useLoaderData()} />;
}

function WorkspacePending() {
  return (
    <AuthSplitShell>
      <div className="mx-auto flex w-full max-w-[22rem] flex-col gap-6">
        <h1 className="text-3xl leading-tight font-semibold text-balance">Choose a workspace</h1>
        <Skeleton className="h-24 w-full" />
      </div>
    </AuthSplitShell>
  );
}
