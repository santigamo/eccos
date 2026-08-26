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
        <SubscriberForm config={result.data} />
        <ResubscribeAction />
      </div>
    </Page>
  );
}