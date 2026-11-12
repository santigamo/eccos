import type { BillingConfig } from "./config";
import { monthlyPriceEuros } from "./plan";

export interface Subscription {
  id: string;
  status: string;
  customerId: string;
  /** From the checkout metadata; null on a subscription Eccos did not start. */
  accountId: string | null;
  itemId: string;
  units: number;
}

export interface Creem {
  checkoutUrl(input: { accountId: string; email: string; numbers: number; successUrl: string }): Promise<string>;
  portalUrl(customerId: string): Promise<string>;
  subscription(id: string): Promise<Subscription>;
  /** Moves the subscription to the price of `numbers`. False when nothing changed. */
  setNumbers(subscription: Subscription, numbers: number): Promise<boolean>;
}

/** One product at 1 EUR per unit: the units of a subscription are its monthly price in euros. */
function unitsFor(numbers: number): number {
  return monthlyPriceEuros(numbers);
}

type Json = Record<string, unknown>;

function idOf(value: unknown): string {
  if (typeof value === "string") return value;
  return String((value as Json | null)?.id ?? "");
}

function subscriptionOf(body: Json): Subscription {
  const item = ((body.items as Json[] | undefined) ?? [])[0] ?? {};
  const accountId = (body.metadata as Json | null)?.accountId;
  return {
    id: String(body.id),
    status: String(body.status),
    customerId: idOf(body.customer),
    accountId: typeof accountId === "string" ? accountId : null,
    itemId: String(item.id ?? ""),
    units: Number(item.units ?? 0),
  };
}

export function creemClient(config: BillingConfig, fetcher: typeof fetch = fetch): Creem {
  async function call(method: "GET" | "POST", path: string, body?: Json): Promise<Json> {
    const response = await fetcher(`${config.apiUrl}${path}`, {
      method,
      headers: { "x-api-key": config.apiKey, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`Creem ${method} ${path.split("?")[0]} answered ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as Json;
  }

  return {
    async checkoutUrl({ accountId, email, numbers, successUrl }) {
      const checkout = await call("POST", "/v1/checkouts", {
        product_id: config.productId,
        units: unitsFor(numbers),
        customer: { email },
        success_url: successUrl,
        metadata: { accountId },
      });
      return String(checkout.checkout_url);
    },
    async portalUrl(customerId) {
      const portal = await call("POST", "/v1/customers/billing", { customer_id: customerId });
      return String(portal.customer_portal_link);
    },
    async subscription(id) {
      return subscriptionOf(await call("GET", `/v1/subscriptions?subscription_id=${encodeURIComponent(id)}`));
    },
    async setNumbers(subscription, numbers) {
      const units = unitsFor(numbers);
      if (units === subscription.units) return false;
      try {
        await call("POST", `/v1/subscriptions/${encodeURIComponent(subscription.id)}`, {
          items: [{ id: subscription.itemId, units }],
          update_behavior: units > subscription.units ? "proration-charge" : "proration-none",
        });
      } catch (error) {
        // It stopped being active since it was read; the next run prices it.
        if (String(error).includes("subscription_not_active")) return false;
        throw error;
      }
      return true;
    },
  };
}
