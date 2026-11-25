/**
 * An account's billing status. Stored on the account; an account with none
 * follows the deployment default, which is `setup` with billing on and `open`
 * without it, so a default never blocks.
 *
 * - `setup`: no subscription yet. It may connect its first number and send.
 * - `active`: a paid subscription.
 * - `past_due`: a payment failed and is being retried. Never blocks.
 * - `cancelled`: cancelled, usable until the period ends.
 * - `paused`: sends refused until it pays.
 * - `closed`: the subscription ended. Sends refused.
 * - `open`: opened by the operator, billed separately or not at all.
 */
export const BILLING_STATUSES = ["setup", "active", "past_due", "cancelled", "paused", "closed", "open"] as const;

export type BillingStatus = (typeof BILLING_STATUSES)[number];

export function isBillingStatus(value: unknown): value is BillingStatus {
  return (BILLING_STATUSES as readonly unknown[]).includes(value);
}

/** Only these refuse sends (`subscription_required`); neither is ever a default. */
export function blocksSends(status: BillingStatus): boolean {
  return status === "closed" || status === "paused";
}

/** Whether an account that has `numbers` may add one more: a second number needs a live subscription. */
export function mayAddNumber(status: BillingStatus, numbers: number): boolean {
  if (status === "open" || status === "active" || status === "past_due") return true;
  return status === "setup" && numbers === 0;
}
