import { createFileRoute } from "@tanstack/react-router";
import { getSubscriberConfig } from "../server/gateway";
import { Page, Unreachable } from "../ui";
import { SubscriberForm } from "../components/dashboard/subscriber-form";
import { ResubscribeAction } from "../components/dashboard/resubscribe-action";

export const Route = createFileRoute("/settings")({
  loader: () => getSubscriberConfig(),
  component: SettingsPage,
});

function SettingsPage() {
  const result = Route.useLoaderData();
  if (!result.ok) {
    return (
      <Page title="Settings">
        <Unreachable error={result.error} />
      </Page>
    );
  }
  return (
    <Page title="Settings">
      <div className="flex flex-col gap-4">
        <SubscriberForm config={result.data} />
        <ResubscribeAction />
      </div>
    </Page>
  );
}