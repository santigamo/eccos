import { useEffect, useState } from "react";
import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
import { invalidatePage, invalidateRoutes, rootRouteId } from "../lib/invalidate";
import { Page } from "../ui";
import {
  confirmCheckout,
  getBilling,
  getConversationRetention,
  type BillingState,
  type Failure,
  type Result,
} from "../server/gateway";
import { FailureView } from "../components/dashboard/failure";
import { SectionsSkeleton } from "../components/dashboard/settings-section";
import { activeWorkspace } from "../lib/workspaces";
import { adminOnlyCopy } from "../lib/failure";
import { rootRole } from "../lib/root-role";
import { BillingPanel, type CheckoutReturn } from "../components/dashboard/billing-panel";
import { ConversationRetentionPanel } from "../components/dashboard/conversation-retention";
import { TwoFactorPanel } from "../components/dashboard/two-factor";
import { WorkspacePanel, type WorkspaceView } from "../components/dashboard/workspace-panel";
import { RoleNote } from "../components/dashboard/role-note";
import { CONFIG_STALE_MS } from "../lib/route-stale";

/**
 * Settings: the workspace itself, then billing and conversation history for a
 * role that may administer them, then the signed-in user's own two-factor
 * authentication, for every role. `requires: "none"`, because nothing here
 * waits on a number.
 */
export const Route = createFileRoute("/settings")({
  staleTime: CONFIG_STALE_MS,
  // Creem returns the customer here with the subscription it created.
  validateSearch: (search: Record<string, unknown>): { billing?: "success"; subscription_id?: string } => ({
    billing: search.billing === "success" ? "success" : undefined,
    subscription_id: typeof search.subscription_id === "string" ? search.subscription_id : undefined,
  }),
  // Not gated on the role: the root may still be loading or stale. A role the
  // page refuses gets cheap refusals here, and the view does not render them.
  loader: () => Promise.all([getConversationRetention(), getBilling()]),
  component: SettingsPage,
  pendingComponent: () => (
    <Page title="Settings" kicker="Configuration">
      <SectionsSkeleton heights={["h-44", "h-40", "h-36"]} />
    </Page>
  ),
});

function SettingsPage() {
  const root = useLoaderData({ from: "__root__" });
  const [retention, billing] = Route.useLoaderData();
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
  const state = root.ok ? root.data : null;
  const accountId =
    state?.stage === "ready"
      ? state.scope.accountId
      : state?.stage === "account-ready"
        ? state.resources.account?.accountId
        : undefined;
  const role = rootRole(root);
  const workspace = root.user ? activeWorkspace(root.user.workspaces, root.user.activeWorkspaceId) : null;
  return (
    <SettingsView
      rootFailure={root.ok ? null : root}
      accountId={accountId}
      workspace={workspace ? { id: workspace.id, name: workspace.name, role: role?.role ?? "" } : null}
      canAdminister={role?.canAdminister}
      billingOn={role?.billing}
      retention={retention}
      twoFactorEnabled={root.user?.twoFactorEnabled}
      billing={billing.ok ? billing.data : null}
      billingReturned={returned}
      onChanged={() => void invalidatePage(router)}
      // The root holds the name the workspace switcher shows.
      onRenamed={() => void invalidateRoutes(router, rootRouteId)}
    />
  );
}

/** The page itself, free of router hooks so it can be rendered directly (`tests/settings-screen.test.tsx`). */
export function SettingsView({
  rootFailure,
  accountId,
  workspace,
  canAdminister = false,
  billingOn = false,
  retention,
  twoFactorEnabled,
  billing,
  billingReturned,
  onChanged,
  onRenamed,
}: {
  /** The root read failed: its failure is the page, not a role refusal. */
  rootFailure?: Failure | null;
  accountId?: string;
  workspace?: WorkspaceView | null;
  canAdminister?: boolean;
  /** Billing is on for this deployment, whatever this role may do with it. */
  billingOn?: boolean;
  retention?: Result<number | null>;
  /** The signed-in user's own; undefined while the root has no user. */
  twoFactorEnabled?: boolean;
  /** Null while billing is off, and for a role that may not administer it. */
  billing?: BillingState | null;
  billingReturned?: CheckoutReturn | null;
  onChanged?: () => void;
  onRenamed?: () => void;
}) {
  return (
    <Page title="Settings" kicker="Configuration">
      {rootFailure ? (
        <FailureView failure={rootFailure} />
      ) : (
        <div className="flex flex-col gap-6">
          {accountId ? (
            <>
              <WorkspacePanel accountId={accountId} workspace={workspace} canRename={canAdminister} onRenamed={onRenamed} />
              {canAdminister ? (
                <>
                  {billing ? <BillingPanel billing={billing} returned={billingReturned} /> : null}
                  {retention ? <ConversationRetentionPanel retention={retention} onChanged={onChanged} /> : null}
                </>
              ) : (
                <RoleNote copy={adminOnlyCopy("settings", billingOn)} />
              )}
            </>
          ) : null}
          {twoFactorEnabled === undefined ? null : <TwoFactorPanel enabled={twoFactorEnabled} />}
        </div>
      )}
    </Page>
  );
}
