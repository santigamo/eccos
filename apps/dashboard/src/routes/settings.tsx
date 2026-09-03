import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { getSubscriberConfig } from "../server/gateway";
import { Page } from "../ui";
import { FailureView } from "../components/dashboard/failure";
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
  // The page is reachable at WABA level, so it has to work in the
  // awaiting-a-phone state too: the forwarding target is precisely what an
  // operator prepares before any traffic exists. `account-ready` carries the
  // account's resources, which is where the WABA id and the account id come
  // from when there is no active scope yet.
  const ready = scope.ok && scope.data.stage === "ready" ? scope.data.scope : null;
  const pending =
    scope.ok && scope.data.stage === "account-ready" ? scope.data.resources : null;
  const selectedWabaId = wabaId ?? ready?.selectedWabaId ?? pending?.wabas[0]?.wabaId;
  const accountId = ready?.accountId ?? pending?.account?.accountId;
  if (!result.ok) {
    return (
      <Page title="Settings" kicker="Configuration">
        <FailureView failure={result} />
      </Page>
    );
  }
  return (
    <Page title="Settings" kicker="Configuration">
      {/* The form column stays a readable measure — full-bleed inputs on a
          wide viewport read as a broken layout, not as a form. */}
      <div className="flex max-w-xl flex-col gap-4">
        <SubscriberForm config={result.data} wabaId={selectedWabaId} />
        {/* Re-subscribe stays behind an active WABA: for one still awaiting a
            phone number the webhooks ARE subscribed, and the reconciler path it
            drives needs a primary phone, so the action would mean nothing. */}
        {ready ? <ResubscribeAction wabaId={selectedWabaId} /> : null}
        {/* The account id lives here, not in first-run setup: it is a support
            and API identifier, not something an operator needs while they are
            still trying to attach a number. */}
        {accountId ? <WorkspacePanel accountId={accountId} /> : null}
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
