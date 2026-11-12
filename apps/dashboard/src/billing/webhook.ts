import { constantTimeEqual, signPayload } from "@eccos/core/signature";
import * as Sentry from "@sentry/cloudflare";
import { billingFor, type Billing } from "./context";
import type { Subscription } from "./creem";
import { policyForStatus, subscriptionEnded } from "./plan";

export const BILLING_WEBHOOK_PATH = "/api/billing/webhook";

/** Null when the request is not the billing webhook, or billing is off. */
export function billingWebhook(
  request: Request,
  pathname: string,
  env: Parameters<typeof billingFor>[0],
): Promise<Response> | null {
  if (pathname !== BILLING_WEBHOOK_PATH) return null;
  const billing = billingFor(env);
  return billing ? handleBillingWebhook(request, billing) : null;
}

function subscriptionIdOf(event: unknown): string | null {
  const object = (event as { object?: Record<string, unknown> } | null)?.object;
  if (!object) return null;
  const subscription = object.object === "subscription" ? object : object.subscription;
  const id = typeof subscription === "string" ? subscription : (subscription as { id?: unknown } | null)?.id;
  return typeof id === "string" && id ? id : null;
}

type Sync = Pick<Billing, "creem"> & {
  gateway: Pick<Billing["gateway"], "getAccountBilling" | "setAccountBilling">;
};

/**
 * Stores what Creem says about a subscription now, and returns it; null when it
 * was not stored. An event or a checkout return is only a signal to look, so
 * duplicates and late ones end in the same place. `accountId` limits the write
 * to that account.
 */
export async function syncSubscription(
  { creem, gateway }: Sync,
  subscriptionId: string,
  accountId?: string,
): Promise<Subscription | null> {
  const subscription = await creem.subscription(subscriptionId);
  if (!subscription.accountId || (accountId && subscription.accountId !== accountId)) return null;
  const stored = await gateway.getAccountBilling(subscription.accountId);
  if (!stored) {
    console.warn("billing: unknown account", { accountId: subscription.accountId, subscriptionId });
    return null;
  }
  const ended = subscriptionEnded(subscription.status);
  if (stored.subscriptionId !== subscription.id) {
    // A late event of a subscription that is over says nothing about the account now.
    if (ended) return null;
    if (stored.subscriptionId && !subscriptionEnded((await creem.subscription(stored.subscriptionId)).status)) {
      // Two checkouts for one account: the first stays, the second needs a refund by hand.
      Sentry.captureMessage(
        `billing: account ${subscription.accountId} has subscription ${stored.subscriptionId}; ignored ${subscription.id}`,
      );
      return null;
    }
  }
  await gateway.setAccountBilling(subscription.accountId, {
    connectPolicy: policyForStatus(subscription.status),
    ...(subscription.customerId ? { customerId: subscription.customerId } : {}),
    subscriptionId: ended ? null : subscription.id,
    ifSubscriptionId: stored.subscriptionId,
  });
  return subscription;
}

export async function handleBillingWebhook(
  request: Request,
  { config, creem, gateway }: Pick<Billing, "config"> & Sync,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const raw = await request.text();
  const expected = (await signPayload(raw, config.webhookSecret)).slice("sha256=".length);
  if (!constantTimeEqual(request.headers.get("creem-signature") ?? "", expected)) {
    return new Response(null, { status: 401 });
  }
  let subscriptionId: string | null = null;
  try {
    subscriptionId = subscriptionIdOf(JSON.parse(raw));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (subscriptionId) await syncSubscription({ creem, gateway }, subscriptionId);
  return new Response(null, { status: 200 });
}
