import type { BillingConfig } from "./config";
import { monthlyPriceEuros } from "./plan";

export interface Subscription {
  id: string;
  status: string;
  customerId: string | null;
  /** From the checkout metadata; null on a subscription Eccos did not start. */
  accountId: string | null;
  itemId: string;
  units: number;
  /** Unix ms of the next charge (`next_transaction_date`); null when Creem did not say. */
  nextChargeAt: number | null;
  /** Unix ms the paid period ends (`current_period_end_date`): where a cancelled one stops. */
  periodEndsAt: number | null;
}

/** One Creem transaction of a customer: a charge, paid or not. Amounts in cents. */
export interface Payment {
  id: string;
  at: number;
  amountCents: number;
  currency: string;
  status: string;
}

export interface Creem {
  checkoutUrl(input: { accountId: string; email: string; numbers: number; successUrl: string }): Promise<string>;
  portalUrl(customerId: string): Promise<string>;
  subscription(id: string): Promise<Subscription>;
  /** The customer's latest transactions, newest first. */
  payments(customerId: string): Promise<Payment[]>;
  /** Moves the subscription to the price of `numbers`. False when nothing changed. */
  setNumbers(subscription: Subscription, numbers: number): Promise<boolean>;
}

type Json = Record<string, unknown>;

function idOf(value: unknown): string | null {
  const id = typeof value === "string" ? value : (value as Json | null)?.id;
  return typeof id === "string" && id ? id : null;
}

function dateOf(value: unknown): number | null {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : at;
}

/** Creem documents transaction timestamps as numbers without a unit; seconds are read as such. */
function timestampOf(value: unknown): number {
  const at = Number(value ?? 0);
  return at > 0 && at < 1e12 ? at * 1000 : at;
}

function paymentOf(body: Json): Payment {
  return {
    id: String(body.id),
    at: timestampOf(body.created_at),
    // What was paid; a charge that failed paid nothing, so it shows what was asked.
    amountCents: Number(body.amount_paid) || Number(body.amount ?? 0),
    currency: String(body.currency ?? "EUR"),
    status: String(body.status ?? ""),
  };
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
    nextChargeAt: dateOf(body.next_transaction_date),
    periodEndsAt: dateOf(body.current_period_end_date),
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
        // One product at 1 EUR per unit: the units are the monthly price in euros.
        units: monthlyPriceEuros(numbers),
        customer: { email },
        success_url: successUrl,
        metadata: { accountId },
      });
      return String(checkout.checkout_url);
    },
    async portalUrl(customerId) {
      if (!customerId) throw new Error("a customer id is required for the billing portal");
      const portal = await call("POST", "/v1/customers/billing", { customer_id: customerId });
      return String(portal.customer_portal_link);
    },
    async subscription(id) {
      return subscriptionOf(await call("GET", `/v1/subscriptions?subscription_id=${encodeURIComponent(id)}`));
    },
    async payments(customerId) {
      const query = `customer_id=${encodeURIComponent(customerId)}&page_size=12`;
      const page = await call("GET", `/v1/transactions/search?${query}`);
      return ((page.items as Json[] | undefined) ?? []).map(paymentOf).sort((a, b) => b.at - a.at);
    },
    async setNumbers(subscription, numbers) {
      const units = monthlyPriceEuros(numbers);
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
