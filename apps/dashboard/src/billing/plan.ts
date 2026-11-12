import type { ConnectPolicy } from "@eccos/gateway-contract";

/** Monthly price in euros for a count of connected numbers. An account pays for at least one. */
export function monthlyPriceEuros(numbers: number): number {
  const n = Math.max(1, Math.floor(numbers));
  if (n <= 5) return 5 + 3 * (n - 1);
  if (n <= 15) return 19;
  if (n <= 50) return 49;
  return 49 + (n - 50);
}

const OPEN_STATUSES = new Set(["trialing", "active", "paid", "scheduled_cancel"]);

/** A subscription that still exists at the provider is managed in its portal, never paid for twice. */
export function subscriptionEnded(status: string): boolean {
  return status === "canceled" || status === "expired";
}

export function policyForStatus(status: string): ConnectPolicy {
  return OPEN_STATUSES.has(status) ? "open" : "closed";
}
