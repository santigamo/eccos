import * as Sentry from "@sentry/cloudflare";
import type { BilledAccount } from "@eccos/gateway-contract";
import type { Billing } from "./context";
import { statusForSubscription, subscriptionEnded } from "./plan";

const CONCURRENCY = 5;

type Reconcile = Pick<Billing, "creem"> & {
  gateway: Pick<Billing["gateway"], "listBilledAccounts" | "setAccountBilling">;
};

async function reconcileAccount({ creem, gateway }: Reconcile, account: BilledAccount): Promise<void> {
  const subscription = await creem.subscription(account.subscriptionId);
  // Creem refuses every change to a subscription that is not active.
  if (subscription.status === "active") await creem.setNumbers(subscription, account.billableNumbers);
  const billingStatus = statusForSubscription(subscription.status);
  if (!billingStatus) throw new Error(`subscription ${subscription.id} has unknown status ${subscription.status}`);
  await gateway.setAccountBilling(account.accountId, {
    billingStatus,
    // An ended subscription is forgotten, so it is not read again tomorrow.
    ...(subscriptionEnded(subscription.status) ? { subscriptionId: null } : {}),
    // A webhook that moved the account to another subscription meanwhile wins.
    ifSubscriptionId: account.subscriptionId,
  });
}

/** Daily: each active subscription is priced for the numbers its account has, and every status re-derived. */
export async function reconcileBilling(billing: Reconcile): Promise<void> {
  const accounts = await billing.gateway.listBilledAccounts();
  for (let start = 0; start < accounts.length; start += CONCURRENCY) {
    await Promise.all(
      accounts
        .slice(start, start + CONCURRENCY)
        .map((account) => reconcileAccount(billing, account).catch((error) => Sentry.captureException(error))),
    );
  }
}
