import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
import { Page } from "../ui";
import {
  getConversationRetention,
  listApiKeys,
  type AccountKeyResource,
  type Result,
} from "../server/gateway";
import { ApiKeysPanel } from "../components/dashboard/api-keys";
import { ConversationRetentionPanel } from "../components/dashboard/conversation-retention";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/reui/frame";

/**
 * Settings — the workspace's own identifiers, its API keys and its conversation history window.
 *
 * It used to carry the forwarding target, the re-subscribe handshake and the
 * pasted-token panel. All three left, and each for its own reason: the first
 * two are what "webhooks" means and now live on /webhooks with the callback URL
 * they belong beside; the token panel moved to an unlisted route
 * (`numbers_.attach-token.tsx`) so the customers it can never serve stop
 * meeting it.
 *
 * The page keeps `requires: "none"` — but on the Workspace panel's own merits
 * now, not the token panel's: the account id is an account-level fact and does
 * not wait on a number. API keys are account-level too.
 */
export const Route = createFileRoute("/settings")({
  loader: () => Promise.all([listApiKeys(), getConversationRetention()]),
  component: SettingsPage,
  pendingComponent: () => (
    <Page title="Settings" kicker="Configuration">
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
        <Skeleton className="h-56 lg:col-span-2" />
      </div>
    </Page>
  ),
});

function SettingsPage() {
  const scope = useLoaderData({ from: "__root__" });
  const [keys, retention] = Route.useLoaderData();
  const router = useRouter();
  // Both post-organization stages carry the account, in two shapes. Reachable
  // before any WABA exists, which is exactly why nothing here may need one.
  const ready = scope.ok && scope.data.stage === "ready" ? scope.data.scope : null;
  const pending =
    scope.ok && scope.data.stage === "account-ready" ? scope.data.resources : null;
  const accountId = ready?.accountId ?? pending?.account?.accountId;
  const wabaId = ready?.selectedWabaId ?? pending?.wabas[0]?.wabaId;
  return (
    <SettingsView
      accountId={accountId}
      keys={keys}
      retention={retention}
      wabaId={wabaId}
      onKeysChanged={() => void router.invalidate()}
    />
  );
}

/**
 * The page itself, free of router hooks so it can be rendered directly
 * (`tests/settings-screen.test.tsx`).
 */
export function SettingsView({
  accountId,
  keys,
  retention,
  wabaId,
  onKeysChanged,
}: {
  accountId?: string;
  keys?: Result<AccountKeyResource[]>;
  retention?: Result<number | null>;
  wabaId?: string;
  onKeysChanged?: () => void;
}) {
  return (
    <Page title="Settings" kicker="Configuration">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {accountId ? <WorkspacePanel accountId={accountId} /> : null}
        {accountId && retention ? (
          <ConversationRetentionPanel retention={retention} onChanged={onKeysChanged} />
        ) : null}
        {accountId && keys ? (
          <div className="lg:col-span-2">
            <ApiKeysPanel keys={keys} wabaId={wabaId} onChanged={onKeysChanged} />
          </div>
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
