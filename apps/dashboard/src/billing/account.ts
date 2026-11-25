import type { AccountBilling, AccountResources, BillingStatus, GatewayApi } from "@eccos/gateway-contract";
import { setupWindowOf, type SetupWindow } from "../lib/setup-window";
import type { Billing } from "./context";
import type { Payment } from "./creem";
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

export const BILLING_RETURN_PATH = "/billing?billing=success";

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

function stateOf(billing: AccountBilling, resources: AccountResources): BillingState {
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

/** Read from the control plane only: Settings never waits on Creem. */
export async function billingState(gateway: GatewayApi, accountId: string): Promise<BillingState> {
  const [billing, resources] = await Promise.all([
    storedBilling(gateway, accountId),
    gateway.listAccountResources(accountId),
  ]);
  return stateOf(billing, resources);
}

/** What /billing shows. The Creem half is null when there is nothing to read or Creem did not answer. */
export interface BillingPage {
  billing: BillingState;
  /** Display numbers on active WABAs, in the order they are billed. */
  phones: string[];
  /** Owner or admin: sees the payments and the ways into the portal. */
  canManage: boolean;
  window: SetupWindow;
  charge: { nextChargeAt: number | null; periodEndsAt: number | null } | null;
  /** Never read for a member. */
  payments: Payment[] | null;
}

export async function billingPage(
  { creem, gateway }: Billing,
  accountId: string,
  canManage: boolean,
): Promise<BillingPage> {
  const [stored, resources] = await Promise.all([storedBilling(gateway, accountId), gateway.listAccountResources(accountId)]);
  const { subscriptionId, customerId } = stored;
  const [charge, payments] = await Promise.all([
    subscriptionId
      ? creem.subscription(subscriptionId).then(
          ({ nextChargeAt, periodEndsAt }) => ({ nextChargeAt, periodEndsAt }),
          () => null,
        )
      : null,
    canManage && customerId ? creem.payments(customerId).catch(() => null) : null,
  ]);
  return {
    billing: stateOf(stored, resources),
    phones: resources.wabas
      .filter((waba) => waba.status === "active")
      .flatMap((waba) => waba.phones.map((phone) => phone.displayPhoneNumber)),
    canManage,
    window: setupWindowOf(resources.account),
    charge,
    payments,
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
