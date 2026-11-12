import type { ConnectPolicy, GatewayApi } from "@eccos/gateway-contract";
import type { Billing } from "./context";
import { monthlyPriceEuros, subscriptionEnded } from "./plan";

export interface BillingState {
  connectPolicy: ConnectPolicy;
  /** Numbers on active WABAs: what the subscription is priced for. */
  numbers: number;
  monthlyEuros: number;
  hasCustomer: boolean;
  /** The subscription's status at Creem; null without one, or when Creem did not answer. */
  status: string | null;
}

export const BILLING_RETURN_PATH = "/settings?billing=success";

/** Where Creem sends the customer back: the console's own origin, never the request's. */
export function billingReturnUrl(consoleOrigin: string | undefined, requestUrl: string): string {
  return new URL(BILLING_RETURN_PATH, consoleOrigin?.trim() || new URL(requestUrl).origin).href;
}

async function billableNumbers(gateway: GatewayApi, accountId: string): Promise<number> {
  const { wabas } = await gateway.listAccountResources(accountId);
  return wabas.filter((waba) => waba.status === "active").reduce((sum, waba) => sum + waba.phones.length, 0);
}

export async function billingState({ creem, gateway }: Billing, accountId: string): Promise<BillingState> {
  const [billing, numbers] = await Promise.all([
    gateway.getAccountBilling(accountId),
    billableNumbers(gateway, accountId),
  ]);
  const status = billing.subscriptionId
    ? await creem.subscription(billing.subscriptionId).then(
        (subscription) => subscription.status,
        () => null,
      )
    : null;
  return {
    status,
    connectPolicy: billing.connectPolicy,
    numbers,
    monthlyEuros: monthlyPriceEuros(numbers),
    hasCustomer: billing.customerId !== null,
  };
}

/** A checkout for a new subscription, or the portal while one still exists. */
export async function checkoutUrl(
  { creem, gateway }: Billing,
  input: { accountId: string; email: string; successUrl: string },
): Promise<string> {
  const stored = await gateway.getAccountBilling(input.accountId);
  if (stored.subscriptionId && stored.customerId) {
    const subscription = await creem.subscription(stored.subscriptionId);
    if (!subscriptionEnded(subscription.status)) return creem.portalUrl(stored.customerId);
  }
  return creem.checkoutUrl({ ...input, numbers: await billableNumbers(gateway, input.accountId) });
}

export async function portalUrl({ creem, gateway }: Billing, accountId: string): Promise<string> {
  const { customerId } = await gateway.getAccountBilling(accountId);
  if (!customerId) throw new Error("This workspace has no billing account yet");
  return creem.portalUrl(customerId);
}
