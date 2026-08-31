import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import type { AccountResources, DashboardState } from "../server/gateway";
import { Page, StatusTag, Unreachable } from "../ui";
import { ConnectNumberPanel } from "../components/dashboard/connect-number";
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
  const { connectError, connectSkipped } = Route.useSearch();
  if (!root.ok) {
    return (
      <Page title="Numbers" kicker="Connection">
        <Unreachable error={root.error} />
      </Page>
    );
  }
  const resources = resourcesFor(root.data);
  const wabas = resources?.wabas ?? [];
  const outcome = (
    <ConnectOutcome connectError={connectError} connectSkipped={connectSkipped} />
  );

  if (wabas.length === 0) {
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
        <NumbersTable resources={resources!} />
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

/**
 * One row per phone number, the unit an operator actually thinks in; the WABA
 * it belongs to is the secondary column. Rail-separated rows on the shared
 * grid, per the console's data rules.
 */
function NumbersTable({ resources }: { resources: AccountResources }) {
  const rows = resources.wabas.flatMap((waba) =>
    waba.phones.map((phone) => ({
      key: `${waba.wabaId}:${phone.phoneNumberId}`,
      displayPhoneNumber: phone.displayPhoneNumber,
      phoneNumberId: phone.phoneNumberId,
      wabaId: waba.wabaId,
      status: waba.status,
    })),
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-y border-(--line)">
            <Th>Number</Th>
            <Th>Phone number ID</Th>
            <Th>WABA</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-(--line) transition-colors hover:bg-white/[.03]">
              <td className="px-3 py-2.5 font-mono text-xs text-foreground">
                {row.displayPhoneNumber || "\u2014"}
              </td>
              <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                {row.phoneNumberId}
              </td>
              <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                {row.wabaId}
              </td>
              <td className="px-3 py-2.5">
                <StatusTag status={row.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
      {children}
    </th>
  );
}
