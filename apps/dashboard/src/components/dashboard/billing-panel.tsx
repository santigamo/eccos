import type { BillingState } from "../../server/gateway";
import { buttonVariants } from "@/components/ui/button";
import { Row, Rows, SectionFrame, SettingsSection } from "./settings-section";

const STATUS_LABELS: Record<Exclude<BillingState["billingStatus"], "open">, string> = {
  setup: "No subscription yet",
  active: "Active",
  past_due: "Payment failed, retrying",
  cancelled: "Cancelled, active until the period ends",
  paused: "Paused",
  closed: "No active subscription",
};

/** No subscription is running: the page offers a checkout. */
export function needsSubscription({ billingStatus }: BillingState): boolean {
  return billingStatus === "setup" || billingStatus === "paused" || billingStatus === "closed";
}

export function billingStatusLabel(billing: BillingState): string {
  if (billing.billingStatus !== "open") return STATUS_LABELS[billing.billingStatus];
  if (billing.hasCustomer) return "Active";
  // Opened by the operator with no Creem customer: someone else pays, e.g. a reseller.
  return billing.explicitStatus ? "Billed separately" : "No subscription needed";
}

/** What /billing says on the way back from a Creem checkout, whose webhook may not have landed yet. */
export function checkoutReturnNote(billing: BillingState): string {
  if (needsSubscription(billing)) return "Creem is still confirming the checkout. Reload this page in a few seconds.";
  return "Your subscription is active. You can add numbers now.";
}

/** The billing summary on Settings; the subscription itself lives on /billing. */
export function BillingPanel({ billing }: { billing: BillingState }) {
  return (
    <SettingsSection
      id="billing"
      title="Billing"
      description="Eccos Cloud is billed per connected number, never per message."
    >
      <SectionFrame flush>
        <Rows>
          <Row
            label="Status"
            action={
              <a href="/billing" className={buttonVariants({ variant: "outline" })}>
                Open billing
              </a>
            }
          >
            {billingStatusLabel(billing)}
          </Row>
          <Row label="Connected numbers">
            <span className="tabular-nums">{billing.numbers}</span>
          </Row>
        </Rows>
      </SectionFrame>
    </SettingsSection>
  );
}
