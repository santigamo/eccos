import * as Sentry from "@sentry/cloudflare";
import { policyForStatus } from "./plan";
import type { Billing } from "./context";

/** Daily: each active subscription is priced for the numbers its account has, and every policy re-derived. */
export async function reconcileBilling({
  creem,
  gateway,
}: Pick<Billing, "creem"> & {
  gateway: Pick<Billing["gateway"], "listBilledAccounts" | "setAccountBilling">;
}): Promise<void> {
  for (const account of await gateway.listBilledAccounts()) {
    try {
      const subscription = await creem.subscription(account.subscriptionId);
      const connectPolicy = policyForStatus(subscription.status);
      // Creem refuses every change to a subscription that is not active, a trial included.
      if (subscription.status === "active") await creem.setNumbers(subscription, account.billableNumbers);
      await gateway.setAccountBilling(account.accountId, { connectPolicy });
    } catch (error) {
      Sentry.captureException(error);
    }
  }
}
