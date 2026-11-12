import { describe, expect, test } from "bun:test";
import { signPayload } from "@eccos/core/signature";
import type { AccountBilling, AccountBillingInput, GatewayApi } from "@eccos/gateway-contract";
import { billingReturnUrl, billingState, checkoutUrl } from "../src/billing/account";
import { billingConfig } from "../src/billing/config";
import { billingFor } from "../src/billing/context";
import { creemClient, type Creem, type Subscription } from "../src/billing/creem";
import { monthlyPriceEuros, policyForStatus } from "../src/billing/plan";
import { reconcileBilling } from "../src/billing/reconcile";
import { BILLING_WEBHOOK_PATH, billingWebhook, handleBillingWebhook, syncSubscription } from "../src/billing/webhook";

const ENV = { CREEM_API_KEY: "creem_test_key", CREEM_WEBHOOK_SECRET: "whsec", CREEM_PRODUCT_ID: "prod_1" };
const config = billingConfig(ENV);
if (!config) throw new Error("expected billing on");

function subscription(over: Partial<Subscription> = {}): Subscription {
  return { id: "sub_1", status: "active", customerId: "cust_1", accountId: "acc_1", itemId: "item_1", units: 5, ...over };
}

/** Creem as a table of subscriptions; never the real API. */
function fakeCreem(subscriptions: Subscription[]) {
  const updates: Array<{ id: string; numbers: number }> = [];
  const creem: Creem = {
    checkoutUrl: async ({ accountId, numbers }) => `https://creem.test/checkout/${accountId}/${numbers}`,
    portalUrl: async (customerId) => `https://creem.test/portal/${customerId}`,
    subscription: async (id) => {
      const found = subscriptions.find((item) => item.id === id);
      if (!found) throw new Error(`no subscription ${id}`);
      return found;
    },
    setNumbers: async (sub, numbers) => {
      updates.push({ id: sub.id, numbers });
      return true;
    },
  };
  return { creem, updates };
}

function fakeGateway(initial: Record<string, AccountBilling> = {}, numbers: Record<string, number> = {}) {
  const stored: Record<string, AccountBilling> = { ...initial };
  const read = (accountId: string) =>
    stored[accountId] ?? { connectPolicy: "closed" as const, customerId: null, subscriptionId: null };
  const gateway = {
    getAccountBilling: async (accountId: string) => read(accountId),
    setAccountBilling: async (accountId: string, input: AccountBillingInput) => {
      const before = read(accountId);
      stored[accountId] = {
        connectPolicy: input.connectPolicy,
        customerId: input.customerId ?? before.customerId,
        subscriptionId: input.subscriptionId ?? before.subscriptionId,
      };
      return read(accountId);
    },
    listBilledAccounts: async () =>
      Object.entries(stored).flatMap(([accountId, billing]) =>
        billing.subscriptionId
          ? [{ accountId, subscriptionId: billing.subscriptionId, billableNumbers: numbers[accountId] ?? 0 }]
          : [],
      ),
    listAccountResources: async (accountId: string) => ({
      account: null,
      keys: [],
      phones: [],
      wabas: [{ status: "active", phones: Array.from({ length: numbers[accountId] ?? 0 }, () => ({})) }],
    }),
  } as unknown as GatewayApi;
  return { gateway, stored };
}

async function event(body: unknown, secret = "whsec"): Promise<Request> {
  const raw = JSON.stringify(body);
  const signature = (await signPayload(raw, secret)).slice("sha256=".length);
  return new Request(`https://app.test${BILLING_WEBHOOK_PATH}`, {
    method: "POST",
    headers: { "creem-signature": signature },
    body: raw,
  });
}

const subscriptionEvent = (status: string, id = "sub_1") => ({
  eventType: `subscription.${status}`,
  object: { object: "subscription", id, status, metadata: { accountId: "acc_1" } },
});

describe("billing off", () => {
  test("no CREEM_API_KEY means no config and no billing", () => {
    expect(billingConfig({})).toBeNull();
    expect(billingFor({ GATEWAY: {} as GatewayApi })).toBeNull();
  });

  test("the webhook path is not handled", async () => {
    expect(billingWebhook(await event(subscriptionEvent("active")), BILLING_WEBHOOK_PATH, { GATEWAY: {} as GatewayApi })).toBeNull();
  });
});

describe("billing config", () => {
  test("a key without its secret and product fails closed", () => {
    expect(() => billingConfig({ CREEM_API_KEY: "creem_key" })).toThrow("CREEM_WEBHOOK_SECRET");
  });

  test("a test key talks to the test API, a live key to the live one", () => {
    expect(config.apiUrl).toBe("https://test-api.creem.io");
    expect(billingConfig({ ...ENV, CREEM_API_KEY: "creem_live" })?.apiUrl).toBe("https://api.creem.io");
  });
});

describe("plan", () => {
  test("price table", () => {
    const table: Array<[number, number]> = [
      [1, 5], [2, 8], [5, 17], [6, 19], [15, 19], [16, 49], [50, 49], [51, 50],
    ];
    for (const [numbers, euros] of table) expect(monthlyPriceEuros(numbers)).toBe(euros);
  });

  test("an account pays for at least one number", () => {
    expect(monthlyPriceEuros(0)).toBe(5);
  });

  test("status to policy", () => {
    for (const status of ["trialing", "active", "paid", "scheduled_cancel"]) {
      expect(policyForStatus(status)).toBe("open");
    }
    for (const status of ["canceled", "unpaid", "paused", "past_due", "expired", "anything-else"]) {
      expect(policyForStatus(status)).toBe("closed");
    }
  });
});

describe("creem client", () => {
  function client(answer: unknown = {}) {
    const calls: Array<{ url: string; method: string; body: unknown; key: string | null }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: String(init?.method),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        key: new Headers(init?.headers).get("x-api-key"),
      });
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
    return { creem: creemClient(config as NonNullable<typeof config>, fetcher), calls };
  }

  test("a checkout carries the account and the price as units", async () => {
    const { creem, calls } = client({ checkout_url: "https://creem.test/c" });
    const url = await creem.checkoutUrl({ accountId: "acc_1", email: "a@b.test", numbers: 5, successUrl: "https://app.test/settings" });
    expect(url).toBe("https://creem.test/c");
    expect(calls[0]).toEqual({
      url: "https://test-api.creem.io/v1/checkouts",
      method: "POST",
      key: "creem_test_key",
      body: {
        product_id: "prod_1",
        units: 17,
        customer: { email: "a@b.test" },
        success_url: "https://app.test/settings",
        metadata: { accountId: "acc_1" },
      },
    });
  });

  test("reads a subscription, whether the customer is an object or an id", async () => {
    const body = { id: "sub_1", status: "trialing", items: [{ id: "item_1", units: 8 }], metadata: { accountId: "acc_1" } };
    const expected = subscription({ status: "trialing", units: 8 });
    expect(await client({ ...body, customer: { id: "cust_1" } }).creem.subscription("sub_1")).toEqual(expected);
    const { creem, calls } = client({ ...body, customer: "cust_1" });
    expect(await creem.subscription("sub_1")).toEqual(expected);
    expect(calls[0]?.url).toBe("https://test-api.creem.io/v1/subscriptions?subscription_id=sub_1");
  });

  test("going up charges the proration, going down does not, and no change makes no call", async () => {
    const { creem, calls } = client();
    expect(await creem.setNumbers(subscription({ units: 5 }), 6)).toBe(true);
    expect(await creem.setNumbers(subscription({ units: 19 }), 2)).toBe(true);
    expect(await creem.setNumbers(subscription({ units: 19 }), 15)).toBe(false);
    expect(calls.map((call) => call.body)).toEqual([
      { items: [{ id: "item_1", units: 19 }], update_behavior: "proration-charge" },
      { items: [{ id: "item_1", units: 8 }], update_behavior: "proration-none" },
    ]);
    expect(calls[0]?.url).toBe("https://test-api.creem.io/v1/subscriptions/sub_1");
  });

  test("a refusal from Creem throws", async () => {
    const fetcher = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(creemClient(config as NonNullable<typeof config>, fetcher).subscription("sub_1")).rejects.toThrow("401");
  });
});

describe("billing webhook", () => {
  test("a bad signature is a 401 and writes nothing", async () => {
    const { creem } = fakeCreem([subscription()]);
    const { gateway, stored } = fakeGateway();
    const response = await handleBillingWebhook(await event(subscriptionEvent("active"), "wrong"), { config, creem, gateway });
    expect(response.status).toBe(401);
    expect(stored).toEqual({});
  });

  test("stores what Creem says now", async () => {
    const { creem } = fakeCreem([subscription({ status: "trialing" })]);
    const { gateway, stored } = fakeGateway();
    const response = await handleBillingWebhook(await event(subscriptionEvent("trialing")), { config, creem, gateway });
    expect(response.status).toBe(200);
    expect(stored.acc_1).toEqual({ connectPolicy: "open", customerId: "cust_1", subscriptionId: "sub_1" });
  });

  test("a checkout.completed event resolves its subscription", async () => {
    const { creem } = fakeCreem([subscription()]);
    const { gateway, stored } = fakeGateway();
    const body = { eventType: "checkout.completed", object: { object: "checkout", subscription: { id: "sub_1" } } };
    await handleBillingWebhook(await event(body), { config, creem, gateway });
    expect(stored.acc_1?.connectPolicy).toBe("open");
  });

  test("a duplicate or stale event ends in the current Creem state", async () => {
    const { creem } = fakeCreem([subscription({ status: "active" })]);
    const { gateway, stored } = fakeGateway();
    // Late delivery of an old cancellation, twice, after the subscription is active again.
    for (const status of ["canceled", "canceled", "active"]) {
      await handleBillingWebhook(await event(subscriptionEvent(status)), { config, creem, gateway });
      expect(stored.acc_1).toEqual({ connectPolicy: "open", customerId: "cust_1", subscriptionId: "sub_1" });
    }
  });

  test("a cancellation closes the account", async () => {
    const { creem } = fakeCreem([subscription({ status: "canceled" })]);
    const { gateway, stored } = fakeGateway({ acc_1: { connectPolicy: "open", customerId: "cust_1", subscriptionId: "sub_1" } });
    await handleBillingWebhook(await event(subscriptionEvent("canceled")), { config, creem, gateway });
    expect(stored.acc_1?.connectPolicy).toBe("closed");
  });

  test("a dead subscription that is not the stored one is ignored; a live one replaces it", async () => {
    const { creem } = fakeCreem([
      subscription({ id: "sub_old", status: "canceled" }),
      subscription({ id: "sub_new", status: "active", customerId: "cust_2" }),
    ]);
    const current = { connectPolicy: "open" as const, customerId: "cust_1", subscriptionId: "sub_1" };
    const { gateway, stored } = fakeGateway({ acc_1: current });
    await handleBillingWebhook(await event(subscriptionEvent("canceled", "sub_old")), { config, creem, gateway });
    expect(stored.acc_1).toEqual(current);
    await handleBillingWebhook(await event(subscriptionEvent("active", "sub_new")), { config, creem, gateway });
    expect(stored.acc_1).toEqual({ connectPolicy: "open", customerId: "cust_2", subscriptionId: "sub_new" });
  });

  test("a subscription Eccos did not start is acknowledged and ignored", async () => {
    const { creem } = fakeCreem([subscription({ accountId: null })]);
    const { gateway, stored } = fakeGateway();
    const response = await handleBillingWebhook(await event(subscriptionEvent("active")), { config, creem, gateway });
    expect(response.status).toBe(200);
    expect(stored).toEqual({});
  });
});

describe("billing reconcile", () => {
  test("prices each live subscription for its numbers and re-derives every policy", async () => {
    const { creem, updates } = fakeCreem([
      subscription({ id: "sub_a", status: "active" }),
      subscription({ id: "sub_b", status: "past_due" }),
    ]);
    const { gateway, stored } = fakeGateway(
      {
        acc_a: { connectPolicy: "open", customerId: "c", subscriptionId: "sub_a" },
        acc_b: { connectPolicy: "open", customerId: "c", subscriptionId: "sub_b" },
        acc_gone: { connectPolicy: "open", customerId: "c", subscriptionId: "sub_missing" },
        acc_free: { connectPolicy: "open", customerId: null, subscriptionId: null },
      },
      { acc_a: 7, acc_b: 3 },
    );
    await reconcileBilling({ creem, gateway });
    expect(updates).toEqual([{ id: "sub_a", numbers: 7 }]);
    expect(stored.acc_a?.connectPolicy).toBe("open");
    expect(stored.acc_b?.connectPolicy).toBe("closed");
    // Creem failing for one account neither stops the run nor changes that account.
    expect(stored.acc_gone?.connectPolicy).toBe("open");
  });
});

describe("checkout", () => {
  const input = { accountId: "acc_1", email: "a@b.test", successUrl: "https://app.test/settings" };

  test("a workspace with no subscription gets a checkout priced for its numbers", async () => {
    const { creem } = fakeCreem([]);
    const { gateway } = fakeGateway({}, { acc_1: 3 });
    expect(await checkoutUrl({ config, creem, gateway }, input)).toBe("https://creem.test/checkout/acc_1/3");
  });

  test("a subscription that still exists goes to the portal, an ended one to a new checkout", async () => {
    const stored = { acc_1: { connectPolicy: "closed" as const, customerId: "cust_1", subscriptionId: "sub_1" } };
    const pastDue = fakeCreem([subscription({ status: "past_due" })]);
    expect(await checkoutUrl({ config, creem: pastDue.creem, gateway: fakeGateway(stored).gateway }, input)).toBe(
      "https://creem.test/portal/cust_1",
    );
    const ended = fakeCreem([subscription({ status: "canceled" })]);
    expect(await checkoutUrl({ config, creem: ended.creem, gateway: fakeGateway(stored).gateway }, input)).toBe(
      "https://creem.test/checkout/acc_1/0",
    );
  });
});

describe("checkout return", () => {
  test("returns to the console origin, not to wherever the request came from", () => {
    expect(billingReturnUrl("https://app.eccos.chat", "https://other.test/_serverFn/x")).toBe(
      "https://app.eccos.chat/settings?billing=success",
    );
    expect(billingReturnUrl(undefined, "http://localhost:3000/_serverFn/x")).toBe(
      "http://localhost:3000/settings?billing=success",
    );
  });

  test("confirming a return stores the subscription without its webhook, for the caller's account only", async () => {
    const { creem } = fakeCreem([subscription({ status: "trialing" })]);
    const { gateway, stored } = fakeGateway();
    await syncSubscription({ creem, gateway }, "sub_1", "acc_other");
    expect(stored).toEqual({});
    await syncSubscription({ creem, gateway }, "sub_1", "acc_1");
    expect(stored.acc_1).toEqual({ connectPolicy: "open", customerId: "cust_1", subscriptionId: "sub_1" });
  });

  test("the billing state carries the status Creem reports, and survives Creem not answering", async () => {
    const billing = { acc_1: { connectPolicy: "open" as const, customerId: "cust_1", subscriptionId: "sub_1" } };
    const { gateway } = fakeGateway(billing, { acc_1: 5 });
    const state = await billingState({ config, creem: fakeCreem([subscription({ status: "trialing" })]).creem, gateway }, "acc_1");
    expect(state).toEqual({ connectPolicy: "open", numbers: 5, monthlyEuros: 17, hasCustomer: true, status: "trialing" });
    expect((await billingState({ config, creem: fakeCreem([]).creem, gateway }, "acc_1")).status).toBeNull();
  });
});
