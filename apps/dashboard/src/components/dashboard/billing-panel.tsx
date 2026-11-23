import { openPortal, startCheckout, type BillingState } from "../../server/gateway";
import { BillingError, useBillingRedirect } from "./billing-redirect";
import { Button } from "@/components/ui/button";
import { Row, Rows, SectionFrame, SettingsSection } from "./settings-section";

const NOTE_CLASS = "m-0 block border-l-2 px-3 py-2 text-sm text-foreground";

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
    <SettingsSection
      id="billing"
      title="Billing"
      description={`Eccos Cloud is billed per connected number, never per message.${closed ? " Messaging keeps working without a subscription; adding a number needs one." : ""}`}
    >
      <SectionFrame flush>
        {returned ? (
          <div className="px-5 pt-4">
            <output className={`${NOTE_CLASS} ${closed ? "border-l-warning" : "border-l-(--mark)"}`}>
              {checkoutReturnNote(billing, returned)}
            </output>
          </div>
        ) : null}
        <Rows>
          <Row label="Status">{billingStatusLabel(billing)}</Row>
          <Row label="Connected numbers">
            <span className="tabular-nums">{billing.numbers}</span>
          </Row>
          {priced ? (
            <Row label="Monthly price">
              <span className="tabular-nums">{billing.monthlyEuros} EUR + VAT</span>
            </Row>
          ) : null}
        </Rows>
        {closed || billing.hasCustomer ? (
          <div className="border-t border-(--line) px-5 py-4">
            <div className="flex flex-wrap gap-2">
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
          </div>
        ) : null}
      </SectionFrame>
    </SettingsSection>
  );
}
