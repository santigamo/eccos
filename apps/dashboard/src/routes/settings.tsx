import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { getSubscriberConfig } from "../server/gateway";
import { Page, Unreachable } from "../ui";
import { SubscriberForm } from "../components/dashboard/subscriber-form";
import { ResubscribeAction } from "../components/dashboard/resubscribe-action";

export const Route = createFileRoute("/settings")({
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId }),
  loader: ({ deps }) => getSubscriberConfig({ data: { wabaId: deps.wabaId } }),
  component: SettingsPage,
});

function SettingsPage() {
  const result = Route.useLoaderData();
  const { wabaId } = Route.useSearch();
  const scope = useLoaderData({ from: "__root__" });
  const selectedWabaId = wabaId ?? (scope.ok && scope.data.stage === "ready" ? scope.data.scope.selectedWabaId : undefined);
  if (!result.ok) {
    return (
      <Page title="Settings" kicker="Configuration">
        <Unreachable error={result.error} />
      </Page>
    );
  }
  return (
    <Page title="Settings" kicker="Configuration">
      {/* The form column stays a readable measure — full-bleed inputs on a
          wide viewport read as a broken layout, not as a form. */}
      <div className="flex max-w-xl flex-col gap-4">
        <SubscriberForm config={result.data} wabaId={selectedWabaId} />
        <ResubscribeAction wabaId={selectedWabaId} />
      </div>
    </Page>
  );
}
