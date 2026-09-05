import { useRef, useState } from "react";
import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
import type { AccountResources, DashboardState } from "../server/gateway";
import { Page } from "../ui";
import { FailureView } from "../components/dashboard/failure";
import {
  CONNECT_FORK_DESCRIPTION,
  ConnectNumberChoices,
  ConnectNumberPanel,
} from "../components/dashboard/connect-number";
import { NumbersTable } from "../components/dashboard/numbers-table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

            This applies ONLY to first run. In the populated view below, the
            same fork opens in a centred dialog from the page's primary action,
            because there it is an occasional decision over a working page
            rather than the whole point of the screen. Same fork, two
            containers, and the difference between them is real: this screen
            exists to be acted on and has nothing behind it to go back to,
            which is also why it is the one that must NOT be dismissible. */}
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
 * The populated /numbers page — the table, and the connect fork behind the
 * page's primary action.
 *
 * On first run the fork is the whole point of the screen and sits centred and
 * alone (`NumbersPage` above). Once numbers exist, adding another is an
 * occasional act, so the same `ConnectNumberChoices` opens in a centred dialog
 * from the "+ Add number" button in the header's action slot.
 *
 * WHY A CENTRED DIALOG AND NOT A SIDE SHEET, which is what /templates uses for
 * its own header action: the overlay rule in docs/DASHBOARD-DESIGN.md splits
 * them by register, and this one is a DECISION, not a task. It has no fields
 * and no submit — the two cards ARE the actions — it leaves the page either
 * way, and its consequence copy ("Removes the number from the WhatsApp
 * Business app") is the reason the fork exists as a screen at all. The house
 * sheets are all `sm:max-w-md`, a width that wraps that line. And the list
 * behind is no help here: the number being added is not in the table yet.
 *
 * Router-free so the button's two states render directly in the tests
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
  /**
   * True between `FB.login` and its callback — Meta's popup is open and the
   * fork still owns the `message` listener and the exchange closure.
   *
   * STATE, not a ref: it feeds `disablePointerDismissal`, which is read during
   * render, so a ref would leave the backdrop dismissible for the whole time
   * it is supposed to be refused.
   */
  const [busy, setBusy] = useState(false);
  const outcome = (
    <ConnectOutcome connectError={connectError} connectSkipped={connectSkipped} />
  );
  return (
    <Page
      title="Numbers"
      kicker="Connection"
      actions={<AddNumberButton expanded={adding} onToggle={setAdding} />}
    >
      {outcome}
      <div className="flex flex-col gap-6">
        {/* The table owns the re-check action; re-reading the loader after one
            lands is the view's job, since the page owns the data. */}
        <NumbersTable resources={resources} onRefresh={onRefresh} />
      </div>
      {/* Mounted only while open, so a previous attempt's inline error never
          greets the next one — the same remount-per-opening idiom /templates
          uses for its sheets. */}
      {adding ? (
        <AddNumberDialog
          open
          onOpenChange={(next) => {
            setAdding(next);
            if (!next) setBusy(false);
          }}
          busy={busy}
          onBusyChange={setBusy}
        />
      ) : null}
    </Page>
  );
}

/**
 * The add-number fork, in the console's DECISION register
 * (docs/DASHBOARD-DESIGN.md → Overlays).
 *
 * DISMISSAL IS THE POINT OF THIS COMPONENT. A plain Base UI dialog closes on
 * Escape and on any outside press, which is right for a fork nobody has
 * committed to — and wrong the moment Meta's popup is open, because closing
 * then unmounts the component holding the `message` listener and the exchange
 * closure: the code exchange still completes, but a failure has nowhere to
 * render and the abandonment event is lost.
 *
 * So while `busy` the surface refuses both ACCIDENTAL dismissals — the
 * backdrop via `disablePointerDismissal`, the keyboard by cancelling any
 * reason that is not `close-press` — and keeps the explicit X working.
 * Refusing that too would trap the operator if Meta's popup never reported
 * back, and being unable to leave is the bug this whole surface came from.
 *
 * `initialFocus` lands on the description, not on the first card: the default
 * would put focus on an irreversible choice, and the sentence it lands on is
 * the one that says the choice locks.
 */
function AddNumberDialog({
  open,
  onOpenChange,
  busy,
  onBusyChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const description = useRef<HTMLParagraphElement>(null);
  return (
    <Dialog
      open={open}
      disablePointerDismissal={busy}
      onOpenChange={(next, details) => {
        if (!next && busy && details.reason !== "close-press") {
          details.cancel();
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent initialFocus={description}>
        <DialogHeader>
          <DialogTitle>Add another number</DialogTitle>
          <DialogDescription ref={description} tabIndex={-1}>
            {CONNECT_FORK_DESCRIPTION}
          </DialogDescription>
        </DialogHeader>
        <ConnectNumberChoices onBusyChange={onBusyChange} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The populated page's ONE primary action, in the `Page` header's action
 * slot — level with the title, top right.
 *
 * It used to be a ghost disclosure under the table, which is where an act
 * this occasional goes to be missed: the button read as page furniture, not
 * as the way in. The header slot gives it the place a primary action earns,
 * and the primary variant gives it the weight — the view's only solid
 * button, per the contract's one-primary-per-view rule (everything else on
 * this screen is ghost or outline).
 *
 * IT STAYS MOUNTED WHILE THE DIALOG IS OPEN. It used to unmount, on the
 * reasoning that two ways into one flow ask "which do I use?" — but the fork
 * was an inline panel then, sitting in the page beside its own trigger. Behind
 * a backdrop the question does not arise, and unmounting the trigger cost real
 * things: the operator lost the only affordance that could have read as a way
 * back, and Base UI lost the element to restore focus to on close.
 *
 * `expanded` is still a prop so both states render directly in the tests
 * (`tests/numbers-screen.test.tsx`); it now drives `aria-expanded` and
 * `aria-haspopup` rather than an early return.
 */
export function AddNumberButton({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
}) {
  return (
    <Button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={expanded}
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