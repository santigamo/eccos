import { type BillingStatus, isBillingStatus } from "@eccos/gateway-contract/billing-status";

export const SUBSCRIPTION_REQUIRED_ERROR = "subscription required to add numbers";

/** The code of everything a billing status refuses: adding numbers and sending. */
export const SUBSCRIPTION_REQUIRED = "subscription_required";

export const SEND_REFUSED_ERROR = "this workspace has no active subscription, so it cannot send messages";

/** By message: an error crosses the Durable Object boundary without its class. */
export function isSubscriptionRequired(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).includes(SUBSCRIPTION_REQUIRED_ERROR);
}

/**
 * The account's own status, else the deployment default: `CONNECT_POLICY_DEFAULT=closed`
 * (billing on) starts an account in `setup`, anything else leaves it `open`. Neither blocks.
 */
export function effectiveBillingStatus(stored: unknown, fallback: string | undefined): BillingStatus {
  if (isBillingStatus(stored)) return stored;
  return fallback === "closed" ? "setup" : "open";
}
