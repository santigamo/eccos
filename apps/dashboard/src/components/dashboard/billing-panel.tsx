import { openPortal, startCheckout, type BillingState } from "../../server/gateway";
import { BillingError, useBillingRedirect } from "./billing-redirect";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Button } from "@/components/ui/button";

const MACHINE_CLASS = "text-[11px] font-medium tracking-wider text-muted-foreground uppercase";
const ROW_CLASS = "flex items-center justify-between gap-4 px-(--frame-panel-px) py-2.5";
const NOTE_CLASS = "mt-4 mb-0 block border-l-2 px-3 py-2 text-sm text-foreground";

export function billingStatusLabel(billing: BillingState): string {
  if (billing.connectPolicy === "closed") return "No active subscription";
  if (billing.hasCustomer) return "Active";
  // Opened by the operator with no Creem customer: someone else pays, e.g. a reseller.
  return billing.explicitPolicy ? "Billed separately" : "No subscription needed";
}

/** What Creem said about the subscription a checkout just returned with; null when it did not say. */
export type CheckoutReturn = { status: string | null };

/** What the page says on the way back from a Creem checkout, whose webhook may not have landed yet. */
export function checkoutReturnNote(billing: BillingState, { status }: CheckoutReturn): string {
  if (billing.connectPolicy === "closed") {
    return "Creem is still confirming the checkout. Reload this page in a few seconds.";
  }
  return status === "trialing"
    ? "Your trial has started. You can add numbers now."
    : "Your subscription is active. You can add numbers now.";
}

/** Billing for the workspace. Rendered only while billing is on. */
export function BillingPanel({ billing, returned }: { billing: BillingState; returned?: CheckoutReturn | null }) {
  const { busy, error, leaveTo } = useBillingRedirect();
  const closed = billing.connectPolicy === "closed";
  // With no subscription of its own, a price would read as a charge.
  const priced = closed || billing.hasCustomer;

  return (
    <Frame variant="default" spacing="lg">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-sm font-semibold">Billing</FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            Eccos Cloud is billed per connected number, never per message.
            {closed ? " Messaging keeps working without a subscription; adding a number needs one." : ""}
          </FrameDescription>
        </FrameHeader>
        {returned ? (
          <output className={`${NOTE_CLASS} ${closed ? "border-l-warning" : "border-l-(--mark)"}`}>
            {checkoutReturnNote(billing, returned)}
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
          {priced ? (
            <div className={ROW_CLASS}>
              <dt className={MACHINE_CLASS}>Monthly price</dt>
              <dd className="m-0 text-sm text-foreground tabular-nums">{billing.monthlyEuros} EUR + VAT</dd>
            </div>
          ) : null}
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
        <BillingError error={error} />
      </FramePanel>
    </Frame>
  );
}
