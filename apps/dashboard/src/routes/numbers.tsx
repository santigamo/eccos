import { useState } from "react";
import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
import type { AccountResources, DashboardState } from "../server/gateway";
import { Page } from "../ui";
import { FailureView } from "../components/dashboard/failure";
import { ConnectNumberPanel } from "../components/dashboard/connect-number";
import { NumbersTable } from "../components/dashboard/numbers-table";
import { Button } from "@/components/ui/button";
import {
  ConnectOutcome,
  normalizeConnectError,
  normalizeConnectSkipped,
  type ConnectOutcomeSearch,
} from "../components/dashboard/connect-outcome";
import type { ConnectFailureCode } from "@eccos/gateway-contract";
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

  // No account registry, or no number yet: both land on the connect flow, and
  // narrowing here is what lets the populated view below take a non-null
  // registry.
  if (!resources || wabas.length === 0) {
    const outcome = (
      <ConnectOutcome connectError={connectError} connectSkipped={connectSkipped} />
    );
    return (
      <Page title="Connect WhatsApp" kicker="First run">
        {/* Centred and LIFTED, the house treatment for a single-purpose frame
            — the same one `/workspaces/new` uses, and for the same reason: on a
            tall viewport a top-anchored panel leaves the eye and the cursor far
            apart. `pb-[10vh]` is what raises it; `items-center` alone would
            sink it to the true middle, which reads as floating, and the old
            `pt-16` pinned it to the top of a mostly empty column instead.

            This applies ONLY to first run. Below, "Add another number" sits
            under the table in the populated view, because there it is one section
            of a page rather than the whole point of the screen. Same component,
            two placements, and the difference between them is real: this screen
            exists to be acted on, that one is a thing you scroll past. */}
        <div className="flex flex-1 items-center justify-center pb-[10vh]">
          <div className="flex w-full max-w-3xl flex-col gap-6">
            {outcome}
            <ConnectNumberPanel heading="Meta Embedded Signup" />
            {/* NOTHING POINTS AT THE PASTED-TOKEN PATH FROM HERE, on purpose.
                A sentence used to send operators to it in Settings; it is now
                an unlisted route (`numbers_.attach-token.tsx`) precisely so the
                customers it can never serve — every token not issued by this
                deployment's own Meta app — stop being offered a form that can
                only refuse them. Re-pointing that sentence at the new URL would
                make the route discoverable again and undo the decision, so it
                was removed rather than moved. */}
          </div>
        </div>
      </Page>
    );
  }

  return (
    <NumbersView
      resources={resources}
      connectError={connectError}
      connectSkipped={connectSkipped}
      onRefresh={() => router.invalidate()}
    />
  );
}

/**
 * The populated /numbers page — the table, and the connect panel folded behind
 * a disclosure.
 *
 * On first run the panel is the whole point of the screen and sits centred and
 * alone (`NumbersPage` above). Once numbers exist, adding another is an
 * occasional act, not a standing part of the page, so the same
 * `ConnectNumberPanel` collapses behind a ghost "+ Add number" button instead
 * of sitting open under every table. Same component, one more state — the
 * disclosure and the panel are the same surface, so there is no mystery about
 * which number form this opens.
 *
 * Router-free so the disclosure's two states render directly in the tests
 * (`tests/numbers-screen.test.tsx`), the same split `SettingsView` uses.
 */
export function NumbersView({
  resources,
  connectError,
  connectSkipped,
  onRefresh,
}: {
  resources: AccountResources;
  connectError?: ConnectFailureCode;
  connectSkipped?: number;
  /** Re-read the loader after the table's re-check changed something. */
  onRefresh?: () => void | Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const outcome = (
    <ConnectOutcome connectError={connectError} connectSkipped={connectSkipped} />
  );
  return (
    <Page title="Numbers" kicker="Connection">
      {outcome}
      <div className="flex flex-col gap-6">
        {/* The table owns the re-check action; re-reading the loader after one
            lands is the view's job, since the page owns the data. */}
        <NumbersTable resources={resources} onRefresh={onRefresh} />
        <AddNumberDisclosure expanded={adding} onToggle={setAdding} />
      </div>
    </Page>
  );
}

/**
 * The "add another number" affordance under the populated table: the connect
 * panel itself once unfolded, or the ghost disclosure that unfolds it.
 *
 * The panel is the whole point of the screen on first run, so it stays open and
 * centred there (`NumbersPage` above); under a populated table it would read as
 * a standing part of the page rather than an occasional act, so this is where
 * the one extra state lives. `expanded` is a prop so the two states render
 * directly in the tests without a DOM (`tests/numbers-screen.test.tsx`) — the
 * same split the webhooks panels use.
 */
export function AddNumberDisclosure({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
}) {
  if (expanded) {
    return <ConnectNumberPanel heading="Add another number" />;
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="w-fit rounded-none"
      aria-expanded={false}
      onClick={() => onToggle(true)}
    >
      + Add number
    </Button>
  );
}

/** Both post-organization stages carry the account registry, in two shapes. */
function resourcesFor(state: DashboardState): AccountResources | null {
  if (state.stage === "ready") return state.scope.resources;
  if (state.stage === "account-ready") return state.resources;
  return null;
}