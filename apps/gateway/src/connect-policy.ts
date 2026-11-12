import type { ConnectPolicy } from "@eccos/gateway-contract";

export const SUBSCRIPTION_REQUIRED_ERROR = "subscription required to add numbers";

/** By message: an error crosses the Durable Object boundary without its class. */
export function isSubscriptionRequired(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).includes(SUBSCRIPTION_REQUIRED_ERROR);
}

/** The account's own policy, else the deployment default, else open. */
export function effectiveConnectPolicy(stored: unknown, fallback: string | undefined): ConnectPolicy {
  if (stored === "open" || stored === "closed") return stored;
  return fallback === "closed" ? "closed" : "open";
}
