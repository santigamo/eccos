import { useEffect, useState } from "react";
import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
import { invalidatePage } from "../lib/invalidate";
import { Page } from "../ui";
import {
  confirmCheckout,
  getBilling,
  getConversationRetention,
  getGatewayOrigin,
  listApiKeys,
  type AccountKeyResource,
  type BillingState,
  type Result,
} from "../server/gateway";
import { BillingPanel, type CheckoutReturn } from "../components/dashboard/billing-panel";
import { ApiKeysPanel } from "../components/dashboard/api-keys";
import { ConversationRetentionPanel } from "../components/dashboard/conversation-retention";
import { TwoFactorPanel } from "../components/dashboard/two-factor";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/reui/frame";
import { CONFIG_STALE_MS } from "../lib/route-stale";

/**
 * Settings — the workspace's own identifiers, its API keys, its conversation
 * history window, and the signed-in user's two-factor authentication.
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
  staleTime: CONFIG_STALE_MS,
  // Creem returns the customer here with the subscription it created.
  validateSearch: (search: Record<string, unknown>): { billing?: "success"; subscription_id?: string } => ({
    billing: search.billing === "success" ? "success" : undefined,
    subscription_id: typeof search.subscription_id === "string" ? search.subscription_id : undefined,
  }),
  loader: () => Promise.all([listApiKeys(), getConversationRetention(), getGatewayOrigin(), getBilling()]),
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
  const [keys, retention, gatewayOrigin] = Route.useLoaderData();
  const router = useRouter();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [returned, setReturned] = useState<CheckoutReturn | null>(null);
  // The webhook may land after Creem's redirect, so the return asks Creem itself.
  // Once: the parameters then leave the URL, and a reload does not ask again.
  useEffect(() => {
    if (search.billing !== "success") return;
    let current = true;
    void (async () => {
      const confirmed = search.subscription_id
        ? await confirmCheckout({ data: { subscriptionId: search.subscription_id } }).catch(() => null)
        : null;
      if (!current) return;
      setReturned({ status: confirmed?.ok ? confirmed.data : null });
      await navigate({ search: {}, replace: true });
      await invalidatePage(router);
    })();
    return () => {
      current = false;
    };
  }, [search.billing, search.subscription_id, navigate, router]);
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
      gatewayOrigin={gatewayOrigin.ok ? gatewayOrigin.data : null}
      twoFactorEnabled={scope.user?.twoFactorEnabled}
      onKeysChanged={() => void invalidatePage(router)}
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
  gatewayOrigin,
  twoFactorEnabled,
  onKeysChanged,
}: {
  accountId?: string;
  keys?: Result<AccountKeyResource[]>;
  retention?: Result<number | null>;
  wabaId?: string;
  gatewayOrigin?: string | null;
  twoFactorEnabled?: boolean;
  onKeysChanged?: () => void;
}) {
  return (
    <Page title="Settings" kicker="Configuration">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {accountId ? <WorkspacePanel accountId={accountId} /> : null}
        {accountId && retention ? (
          <ConversationRetentionPanel retention={retention} onChanged={onKeysChanged} />
        ) : null}
        {accountId && billing ? <BillingPanel billing={billing} returned={billingReturned} /> : null}
        {accountId && keys ? (
          <div className="lg:col-span-2">
            <ApiKeysPanel keys={keys} wabaId={wabaId} gatewayOrigin={gatewayOrigin} onChanged={onKeysChanged} />
          </div>
        ) : null}
        {twoFactorEnabled === undefined ? null : (
          <div className="lg:col-span-2">
            <TwoFactorPanel enabled={twoFactorEnabled} />
          </div>
        )}
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
