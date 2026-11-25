import type { BillingStatus } from "@eccos/gateway-contract";

/** Monthly price in euros for a count of connected numbers. An account pays for at least one. */
export function monthlyPriceEuros(numbers: number): number {
  const n = Math.max(1, Math.floor(numbers));
  if (n <= 5) return 5 + 3 * (n - 1);
  if (n <= 15) return 19;
  if (n <= 50) return 49;
  return 49 + (n - 50);
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** What one number costs inside the per-number tier (up to five); null once a flat tier prices them together. */
export function numberPriceEuros(index: number, numbers: number): number | null {
  if (numbers > 5) return null;
  return index === 0 ? 5 : 3;
}

/** "Adding a third number would add 3 €, so 11 € per month." */
export function nextNumberNote(numbers: number): string {
  if (numbers === 0) return `Your first number costs ${monthlyPriceEuros(1)} € per month.`;
  const next = monthlyPriceEuros(numbers + 1);
  const added = next - monthlyPriceEuros(numbers);
  const which = ORDINALS[numbers] ? `a ${ORDINALS[numbers]} number` : "another number";
  if (added === 0) return `Adding ${which} keeps the price at ${next} € per month.`;
  return `Adding ${which} would add ${added} €, so ${next} € per month.`;
}

/** Where the price stops growing next; null past the last flat tier. */
export function tierNote(numbers: number): string | null {
  if (numbers <= 5) return "From six numbers the price stops growing: 19 € per month for up to fifteen.";
  if (numbers < 15) return "Up to fifteen numbers stay at 19 € per month; from sixteen it is 49 € for up to fifty.";
  if (numbers < 50) return "Up to fifty numbers stay at 49 € per month; past fifty each one adds 1 €.";
  return null;
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
