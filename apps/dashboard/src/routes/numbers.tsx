import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
import type { AccountResources, DashboardState } from "../server/gateway";
import { Page } from "../ui";
import { FailureView } from "../components/dashboard/failure";
import { ConnectNumberPanel } from "../components/dashboard/connect-number";
import { NumbersTable } from "../components/dashboard/numbers-table";
import {
  ConnectOutcome,
  normalizeConnectError,
  normalizeConnectSkipped,
  type ConnectOutcomeSearch,
} from "../components/dashboard/connect-outcome";
import { normalizeSearchWabaId } from "../lib/search";

/** Scope selector plus the Embedded Signup outcome the gateway redirects with. */
type NumbersSearch = ConnectOutcomeSearch & { wabaId?: string };

export const Route = createFileRoute("/numbers")({
  validateSearch: (search: Record<string, unknown>): NumbersSearch => ({
    wabaId: normalizeSearchWabaId(search.wabaId),
    connectError: normalizeConnectError(search.connectError),
    connectSkipped: normalizeConnectSkipped(search.connectSkipped),
  }),
  component: NumbersPage,
});

/**
 * The account's WhatsApp numbers, and the one place they get connected.
 *
 * This is also the first screen of a new workspace: with no number yet, the
 * page IS the connect flow, inside the normal app chrome. There is no separate
 * first-run route, because "attach a number" is a recurring operation and an
 * onboarding wizard would only exist for the first one.
 */
function NumbersPage() {
  const root = useLoaderData({ from: "__root__" });
  const router = useRouter();
  const { connectError, connectSkipped } = Route.useSearch();
  if (!root.ok) {
    return (
      <Page title="Numbers" kicker="Connection">
        <FailureView failure={root} />
      </Page>
    );
  }
  const resources = resourcesFor(root.data);
  const wabas = resources?.wabas ?? [];
  const outcome = (
    <ConnectOutcome connectError={connectError} connectSkipped={connectSkipped} />
  );

  // No account registry, or no number yet: both land on the connect flow, and
  // narrowing here is what lets the table below take a non-null registry.
  if (!resources || wabas.length === 0) {
    return (
      <Page title="Connect WhatsApp" kicker="First run">
        {/* Centred horizontally, but held high: vertically centring it in the
            content area dropped it past the middle of the viewport and cut it
            loose from its own heading. Top-aligned with a deliberate gap keeps
            it in the upper half at any viewport height, and never clips. */}
        <div className="flex justify-center pt-16">
          <div className="w-full max-w-3xl">
            {outcome}
            <ConnectNumberPanel heading="Meta Embedded Signup" />
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Numbers" kicker="Connection">
      {outcome}
      <div className="flex flex-col gap-6">
        {/* The table owns the re-check action; re-reading the loader after one
            lands is the route's job, since the route owns the data. */}
        <NumbersTable resources={resources} onRefresh={() => router.invalidate()} />
        <ConnectNumberPanel heading="Add another number" />
      </div>
    </Page>
  );
}

/** Both post-organization stages carry the account registry, in two shapes. */
function resourcesFor(state: DashboardState): AccountResources | null {
  if (state.stage === "ready") return state.scope.resources;
  if (state.stage === "account-ready") return state.resources;
  return null;
}
