import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
import { invalidatePage } from "../lib/invalidate";
import { Page } from "../ui";
import { getGatewayOrigin, listApiKeys, type AccountKeyResource, type Failure, type Result } from "../server/gateway";
import { FailureView } from "../components/dashboard/failure";
import { SectionsSkeleton } from "../components/dashboard/settings-section";
import { ApiKeysPanel } from "../components/dashboard/api-keys";
import { RoleNote } from "../components/dashboard/role-note";
import { adminOnlyCopy } from "../lib/failure";
import { rootRole } from "../lib/root-role";
import { CONFIG_STALE_MS } from "../lib/route-stale";

/** Account API keys, for whoever integrates a server. `requires: "none"`: a key does not wait on a number. */
export const Route = createFileRoute("/api-keys")({
  staleTime: CONFIG_STALE_MS,
  // Not gated on the role: the root may still be loading or stale. A role the
  // page refuses gets a cheap refusal here, and the view does not render it.
  loader: () => Promise.all([listApiKeys(), getGatewayOrigin()]),
  component: ApiKeysPage,
  pendingComponent: () => (
    <Page title="API keys" kicker="Integration">
      <SectionsSkeleton heights={["h-64", "h-40"]} />
    </Page>
  ),
});

function ApiKeysPage() {
  const root = useLoaderData({ from: "__root__" });
  const [keys, gatewayOrigin] = Route.useLoaderData();
  const router = useRouter();
  const state = root.ok ? root.data : null;
  const wabaId =
    state?.stage === "ready"
      ? state.scope.selectedWabaId
      : state?.stage === "account-ready"
        ? state.resources.wabas[0]?.wabaId
        : undefined;
  return (
    <ApiKeysView
      rootFailure={root.ok ? null : root}
      canAdminister={rootRole(root)?.canAdminister ?? false}
      keys={keys}
      wabaId={wabaId}
      gatewayOrigin={gatewayOrigin.ok ? gatewayOrigin.data : null}
      onChanged={() => void invalidatePage(router)}
    />
  );
}

/** The page itself, free of router hooks (`tests/api-keys-screen.test.tsx`). */
export function ApiKeysView({
  rootFailure,
  canAdminister,
  keys,
  wabaId,
  gatewayOrigin,
  onChanged,
}: {
  /** The root read failed: its failure is the page, not a role refusal. */
  rootFailure?: Failure | null;
  canAdminister: boolean;
  keys: Result<AccountKeyResource[]>;
  wabaId?: string;
  gatewayOrigin?: string | null;
  onChanged?: () => void;
}) {
  return (
    <Page title="API keys" kicker="Integration">
      {rootFailure ? (
        <FailureView failure={rootFailure} />
      ) : canAdminister ? (
        <div className="flex flex-col gap-6">
          <ApiKeysPanel keys={keys} wabaId={wabaId} gatewayOrigin={gatewayOrigin} onChanged={onChanged} />
        </div>
      ) : (
        <RoleNote copy={adminOnlyCopy("api-keys")} />
      )}
    </Page>
  );
}
