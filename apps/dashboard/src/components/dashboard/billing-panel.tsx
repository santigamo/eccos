import { isRedirect } from "@tanstack/react-router";
import { useState } from "react";
import { openPortal, startCheckout, type BillingState, type Result } from "../../server/gateway";
import { failureCopy } from "../../lib/failure";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Button } from "@/components/ui/button";

const MACHINE_CLASS = "text-[11px] font-medium tracking-wider text-muted-foreground uppercase";
const ROW_CLASS = "flex items-center justify-between gap-4 px-(--frame-panel-px) py-2.5";
const NOTE_CLASS = "mt-4 mb-0 block border-l-2 px-3 py-2 text-sm text-foreground";

export function billingStatusLabel(billing: BillingState): string {
  if (billing.status === "trialing") return "Trial";
  if (billing.status === "scheduled_cancel") return "Active until the period ends";
  if (billing.connectPolicy === "open") return billing.hasCustomer ? "Active" : "No subscription needed";
  return billing.status === "past_due" || billing.status === "unpaid" ? "Payment failed" : "No active subscription";
}

/** What the page says on the way back from a Creem checkout, whose webhook may not have landed yet. */
export function checkoutReturnNote(billing: BillingState): string {
  if (billing.connectPolicy === "closed") {
    return "Creem is still confirming the checkout. Reload this page in a few seconds.";
  }
  return billing.status === "trialing"
    ? "Your trial has started. You can add numbers now."
    : "Your subscription is active. You can add numbers now.";
}

/** Billing for the workspace. Rendered only while billing is on. */
export function BillingPanel({ billing, returned }: { billing: BillingState; returned?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closed = billing.connectPolicy === "closed";

  async function leaveTo(target: () => Promise<Result<{ url: string }>>) {
    setBusy(true);
    setError(null);
    try {
      const res = await target();
      if (res.ok) {
        window.location.assign(res.data.url);
        return;
      }
      setError(res.kind === "unreachable" ? "Billing could not be opened. Try again." : failureCopy(res).detail);
    } catch (thrown) {
      if (isRedirect(thrown)) throw thrown;
      setError("Billing could not be opened. Try again.");
    }
    setBusy(false);
  }

  return (
    <Frame variant="default" spacing="lg">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-sm font-semibold">Billing</FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            Eccos Cloud is billed per connected number. Messages are never billed.
            {closed ? " Messaging keeps working without a subscription; adding a number needs one." : ""}
          </FrameDescription>
        </FrameHeader>
        {returned ? (
          <output className={`${NOTE_CLASS} ${closed ? "border-l-warning" : "border-l-(--mark)"}`}>
            {checkoutReturnNote(billing)}
          </output>
        ) : null}
        <dl className="my-0 -mx-(--frame-panel-px) mt-5 divide-y divide-(--line) border-y border-(--line)">
          <div className={ROW_CLASS}>
            <dt className={MACHINE_CLASS}>Status</dt>
            <dd className="m-0 text-sm text-foreground">{billingStatusLabel(billing)}</dd>
          </div>
          <div className={ROW_CLASS}>
            <dt className={MACHINE_CLASS}>Connected numbers</dt>
            <dd className="m-0 text-sm text-foreground tabular-nums">{billing.numbers}</dd>
          </div>
          <div className={ROW_CLASS}>
            <dt className={MACHINE_CLASS}>Monthly price</dt>
            <dd className="m-0 text-sm text-foreground tabular-nums">{billing.monthlyEuros} EUR</dd>
          </div>
        </dl>
        <div className="mt-5 flex flex-wrap gap-2">
          {closed ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void leaveTo(() => startCheckout())}>
              Start subscription
            </Button>
          ) : null}
          {billing.hasCustomer ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void leaveTo(() => openPortal())}>
              Manage billing
            </Button>
          ) : null}
        </div>
        {error ? (
          <output
            aria-live="polite"
            className="bg-destructive/10 text-destructive-foreground mt-3 block border border-destructive/20 p-3 text-xs"
          >
            {error}
          </output>
        ) : null}
      </FramePanel>
    </Frame>
  );
}
