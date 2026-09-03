import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { getSubscriberConfig } from "../server/gateway";
import type { Result, SubscriberConfig } from "../server/gateway";
import { Page } from "../ui";
import { FailureView } from "../components/dashboard/failure";
import { SubscriberForm } from "../components/dashboard/subscriber-form";
import { TokenConnectPanel } from "../components/dashboard/connect-token";
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
  // Whether there is a WABA for the forwarding target to belong to. This page
  // is reachable with none (scope-requirements.ts: `/settings` is `"none"`,
  // because the token panel below is how the first one gets attached), and in
  // that state `getSubscriberConfig` legitimately fails — its scope does not
  // exist yet. That is not a gateway problem, so it does not get a failure
  // card that says it is.
  const hasWaba = ready !== null || (pending?.wabas.length ?? 0) > 0;
  return (
    <SettingsView
      result={result}
      hasWaba={hasWaba}
      isActive={ready !== null}
      selectedWabaId={selectedWabaId}
      accountId={accountId}
    />
  );
}

/**
 * The page itself, free of router hooks so its stages can be rendered directly
 * (`tests/settings-screen.test.tsx`).
 *
 * The stage that matters most is the one with NO WABA at all: the token panel
 * has to render there, because attaching a number is the way out of it.
 */
export function SettingsView({
  result,
  hasWaba,
  isActive,
  selectedWabaId,
  accountId,
}: {
  result: Result<SubscriberConfig>;
  /** A WABA exists for the forwarding target to belong to. */
  hasWaba: boolean;
  /** …and it is active, which is what the re-subscribe action needs. */
  isActive: boolean;
  selectedWabaId?: string;
  accountId?: string;
}) {
  return (
    <Page title="Settings" kicker="Configuration">
      {/* The form column stays a readable measure — full-bleed inputs on a
          wide viewport read as a broken layout, not as a form. */}
      <div className="flex max-w-xl flex-col gap-4">
        {/* The subscriber area is the part that needs a WABA, so its failure is
            scoped to it. The page does NOT early-return on it any more: an
            account with zero WABAs is exactly the state the token panel below
            fixes, and `getSubscriberConfig` throws "has no registered WABAs" in
            it — so returning early here hid the one form that could get the
            operator out of it. */}
        {!hasWaba ? (
          <NoNumberNote />
        ) : result.ok ? (
          <SubscriberForm config={result.data} wabaId={selectedWabaId} />
        ) : (
          <FailureView failure={result} />
        )}
        {/* Re-subscribe stays behind an active WABA: for one still awaiting a
            phone number the webhooks ARE subscribed, and the reconciler path it
            drives needs a primary phone, so the action would mean nothing. */}
        {isActive ? <ResubscribeAction wabaId={selectedWabaId} /> : null}
        {/* Renders in EVERY stage, deliberately — including the one where the
            subscriber read failed. Attaching the Cloud API test number is the
            way out of the no-WABA state, so this is precisely the panel that
            must not be conditional on there already being a WABA. */}
        <TokenConnectPanel />
        {/* The account id lives here, not in first-run setup: it is a support
            and API identifier, not something an operator needs while they are
            still trying to attach a number. */}
        {accountId ? <WorkspacePanel accountId={accountId} /> : null}
      </div>
    </Page>
  );
}

/**
 * What stands in for the forwarding target before any number exists.
 *
 * Structure, not a lone muted line (data rule 6): the machine-voice label, one
 * sentence saying what will appear here, and no action of its own — the action
 * is the panel directly below it. Deliberately NOT a `FailureView`: nothing
 * failed, and only `unreachable` may say the gateway is unreachable.
 */
function NoNumberNote() {
  return (
    <Frame variant="default" spacing="lg">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            No number yet
          </FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            A forwarding target belongs to a WhatsApp number. Attach one — with
            Connect with Meta on the Numbers page, or by token below — and the
            settings for it appear here.
          </FrameDescription>
        </FrameHeader>
      </FramePanel>
    </Frame>
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
