import type { AccountResources, BillingStatus, GatewayApi } from "@eccos/gateway-contract";
import type { Billing } from "./context";
import { monthlyPriceEuros, subscriptionEnded } from "./plan";

export interface BillingState {
  billingStatus: BillingStatus;
  /** Numbers on active WABAs: what the subscription is priced for. */
  numbers: number;
  monthlyEuros: number;
  hasCustomer: boolean;
  /** The status is stored on this workspace; false while it follows the deployment default. */
  explicitStatus: boolean;
  /** The gateway would register one more number now. */
  canAddNumber: boolean;
}

export const BILLING_RETURN_PATH = "/settings?billing=success";

/** Where Creem sends the customer back: the console's own origin, never the request's. */
export function billingReturnUrl(consoleOrigin: string | undefined, requestUrl: string): string {
  return new URL(BILLING_RETURN_PATH, consoleOrigin?.trim() || new URL(requestUrl).origin).href;
}

/** Numbers on active WABAs: what the subscription is priced for. */
export function billableCount(wabas: AccountResources["wabas"]): number {
  return wabas.filter((waba) => waba.status === "active").reduce((sum, waba) => sum + waba.phones.length, 0);
}

async function billableNumbers(gateway: GatewayApi, accountId: string): Promise<number> {
  return billableCount((await gateway.listAccountResources(accountId)).wabas);
}

async function storedBilling(gateway: GatewayApi, accountId: string) {
  const stored = await gateway.getAccountBilling(accountId);
  if (!stored) throw new Error(`account "${accountId}" does not exist`);
  return stored;
}

/** Read from the control plane only: Settings never waits on Creem. */
export async function billingState(gateway: GatewayApi, accountId: string): Promise<BillingState> {
  const [billing, resources] = await Promise.all([
    storedBilling(gateway, accountId),
    gateway.listAccountResources(accountId),
  ]);
  const numbers = billableCount(resources.wabas);
  return {
    billingStatus: billing.billingStatus,
    canAddNumber: resources.account?.canAddNumber === true,
    numbers,
    monthlyEuros: monthlyPriceEuros(numbers),
    hasCustomer: billing.customerId !== null,
    explicitStatus: billing.explicitStatus === true,
  };
}

/** A checkout for a new subscription, or the portal while one still exists. */
export async function checkoutUrl(
  { creem, gateway }: Billing,
  input: { accountId: string; email: string; successUrl: string },
): Promise<string> {
  const stored = await storedBilling(gateway, input.accountId);
  if (stored.subscriptionId && stored.customerId) {
    const subscription = await creem.subscription(stored.subscriptionId);
    if (!subscriptionEnded(subscription.status)) return creem.portalUrl(stored.customerId);
  }
  return creem.checkoutUrl({ ...input, numbers: await billableNumbers(gateway, input.accountId) });
}

export async function portalUrl({ creem, gateway }: Billing, accountId: string): Promise<string> {
  const { customerId } = await storedBilling(gateway, accountId);
  if (!customerId) throw new Error("This workspace has no billing account yet");
  return creem.portalUrl(customerId);
}
