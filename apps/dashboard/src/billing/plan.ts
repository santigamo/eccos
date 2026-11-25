import type { BillingStatus } from "@eccos/gateway-contract";

/** Monthly price in euros for a count of connected numbers. An account pays for at least one. */
export function monthlyPriceEuros(numbers: number): number {
  const n = Math.max(1, Math.floor(numbers));
  if (n <= 5) return 5 + 3 * (n - 1);
  if (n <= 15) return 19;
  if (n <= 50) return 49;
  return 49 + (n - 50);
}

/** An ended subscription is forgotten; one that still exists is managed in its portal, never paid for twice. */
export function subscriptionEnded(status: string): boolean {
  return status === "canceled" || status === "expired";
}

/**
 * The account's status for a Creem subscription status; null for one Creem has not
 * documented, which leaves the stored status as it is. A failed payment is retried
 * (`past_due`, `unpaid`) and never blocks: Creem cancels once the retries run out.
 */
export function statusForSubscription(status: string): BillingStatus | null {
  switch (status) {
    case "active":
    case "paid":
    // No trial is offered any more; one started before still counts as paid.
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "scheduled_cancel":
      return "cancelled";
    case "paused":
      return "paused";
    case "canceled":
    case "expired":
      return "closed";
    default:
      return null;
  }
}
