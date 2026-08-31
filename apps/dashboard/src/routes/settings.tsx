import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { getSubscriberConfig } from "../server/gateway";
import { Page, Unreachable } from "../ui";
import { SubscriberForm } from "../components/dashboard/subscriber-form";
import { ResubscribeAction } from "../components/dashboard/resubscribe-action";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/reui/frame";

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
        {/* The account id lives here, not in first-run setup: it is a support
            and API identifier, not something an operator needs while they are
            still trying to attach a number. */}
        {scope.ok && scope.data.stage === "ready" ? (
          <WorkspacePanel accountId={scope.data.scope.accountId} />
        ) : null}
      </div>
    </Page>
  );
}

/** Identifiers an operator needs when they open a support thread or an API key. */
function WorkspacePanel({ accountId }: { accountId: string }) {
  return (
    <Frame variant="default" spacing="lg">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-sm font-semibold">Workspace</FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            The account scope every WABA, key, and log line in this console
            belongs to. Quote it in support threads.
          </FrameDescription>
        </FrameHeader>
        <dl className="my-0 -mx-(--frame-panel-px) mt-5 divide-y divide-(--line) border-y border-(--line)">
          <div className="flex items-center justify-between gap-4 px-(--frame-panel-px) py-2.5">
            <dt className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
              Account ID
            </dt>
            <dd className="m-0 font-mono text-xs break-all text-foreground">{accountId}</dd>
          </div>
        </dl>
      </FramePanel>
    </Frame>
  );
}
