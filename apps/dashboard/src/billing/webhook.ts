import { constantTimeEqual, signPayload } from "@eccos/core/signature";
import { billingFor, type Billing } from "./context";
import { policyForStatus } from "./plan";

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
 * Stores what Creem says about a subscription now. An event or a checkout return
 * is only a signal to look, so duplicates and late ones end in the same place.
 * `accountId` limits the write to that account.
 */
export async function syncSubscription({ creem, gateway }: Sync, subscriptionId: string, accountId?: string): Promise<void> {
  const subscription = await creem.subscription(subscriptionId);
  if (!subscription.accountId || (accountId && subscription.accountId !== accountId)) return;
  const connectPolicy = policyForStatus(subscription.status);
  const stored = await gateway.getAccountBilling(subscription.accountId);
  // A dead subscription that is not the stored one must not close the account.
  const foreign = stored.subscriptionId !== null && stored.subscriptionId !== subscription.id;
  if (foreign && connectPolicy === "closed") return;
  await gateway.setAccountBilling(subscription.accountId, {
    connectPolicy,
    customerId: subscription.customerId,
    subscriptionId: subscription.id,
  });
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
