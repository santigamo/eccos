import { describe, expect, test } from "bun:test";
import type { BillingStatus } from "@eccos/gateway-contract";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderInRouter } from "./helpers/router";

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { BillingScreen } = await import("../src/routes/billing");
const { billingStage, paymentStatusWord } = await import("../src/components/dashboard/billing-view");
const { SetupWindowStrip, stripMessage } = await import("../src/components/dashboard/setup-window-strip");
const { setupWindowFor } = await import("../src/routes/__root");
const { NAV_MAIN } = await import("../src/components/blocks/app-shell-7/components/data");
const { navItems } = await import("../src/components/blocks/app-shell-7/components/nav-main");
const { nextNumberNote, numberPriceEuros, tierNote } = await import("../src/billing/plan");
const { creemClient } = await import("../src/billing/creem");
const { billingConfig } = await import("../src/billing/config");
type BillingPage = import("../src/server/gateway").BillingPage;

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 25, 10, 42);
const DEC_25 = Date.UTC(2026, 11, 25, 9, 0);

function page(billingStatus: BillingStatus, over: Partial<BillingPage> = {}): BillingPage {
  const phones = over.phones ?? ["+34 612 345 678", "+34 611 222 333"];
  const subscribed = ["active", "past_due", "cancelled"].includes(billingStatus);
  return {
    billing: {
      billingStatus,
      numbers: phones.length,
      monthlyEuros: phones.length === 1 ? 5 : 8,
      hasCustomer: subscribed,
      explicitStatus: true,
      canAddNumber: ["active", "past_due", "open"].includes(billingStatus),
    },
    phones,
    canManage: true,
    window: { activatedAt: null, pausesAt: null, pauseReason: null },
    charge: subscribed ? { nextChargeAt: DEC_25, periodEndsAt: DEC_25 } : null,
    payments: subscribed
      ? [{ id: "tran_1", at: Date.UTC(2026, 10, 25), amountCents: 968, currency: "EUR", status: "paid" }]
      : null,
    ...over,
  };
}

const render = (data: BillingPage, returned = false) =>
  renderInRouter(<BillingScreen page={{ ok: true, data }} returned={returned} now={NOW} />);

describe("/billing states", () => {
  test("active: running, the per-number plan, the next charge and the payments, with the portal for the rest", async () => {
    const html = await render(page("active"));
    expect(html).toContain("Your subscription is active. Everything is running.");
    expect(html).toContain("2 numbers, 8 € per month + VAT. Next charge on 25 Dec 2026.");
    expect(html).toContain("+34 612 345 678");
    expect(html).toContain("First number");
    expect(html).toContain("Extra number");
    expect(html).toMatch(/5 €.*3 €.*Total per month/);
    expect(html).toContain("Adding a third number would add 3 €, so 11 € per month.");
    expect(html).toContain("From six numbers the price stops growing: 19 € per month for up to fifteen.");
    expect(html).toContain('href="/numbers"');
    expect(html).toContain("Charged once a month, on the same day.");
    expect(html).toContain("9.68 €");
    expect(html).toContain("Paid");
    expect(html).toContain("Your card is kept by Creem");
    for (const action of ["Update card", "Download invoices", "Cancel subscription"]) expect(html).toContain(action);
    expect(html).toContain("everything keeps running until 25 Dec 2026");
  });

  test("setup, connected but not activated: finish the setup, subscribing is optional", async () => {
    const html = await render(page("setup", { phones: ["+34 612 345 678"] }));
    expect(html).toContain("Not set up yet");
    expect(html).toContain("Your number is connected, but no message has gone through yet");
    expect(html).toContain("Finish setup");
    expect(html).toContain("Subscribing now is optional.");
    expect(html).toContain("A second number needs the subscription first.");
    expect(html).toContain("They appear here once you subscribe.");
    expect(html).not.toContain("days left");
    expect(html).not.toContain("Cancel subscription");
  });

  test("setup with its day-14 deadline counts the days down", async () => {
    const window = { activatedAt: null, pausesAt: NOW + 9 * 24 * HOUR, pauseReason: "never_activated" as const };
    const html = await render(page("setup", { phones: ["+34 612 345 678"], window }));
    expect(html).toContain("9 days left");
    expect(html).toContain("Fri 4 Dec");
  });

  test("activated within the 72h window: the countdown and a subscribe button, no extension", async () => {
    const window = { activatedAt: NOW, pausesAt: NOW + 71 * HOUR, pauseReason: "window_ended" as const };
    const data = page("setup", { phones: ["+34 612 345 678"], window });
    expect(billingStage(data, NOW)).toBe("window");
    const html = await render(data);
    expect(html).toContain("Setup window");
    expect(html).toContain("2 d 23 h left");
    expect(html).toContain("Your number works. Subscribe to keep it running.");
    expect(html).toContain("Sat 28 Nov at 09:42 UTC");
    expect(html).toContain("cannot be made longer");
    expect(html).toContain("Start subscription · 5 €/month");
    expect(html).not.toMatch(/extend/i);
  });

  test("past_due: update the card, nothing is paused", async () => {
    const html = await render(page("past_due"));
    expect(html).toContain("Payment failed");
    expect(html).toContain("Your last payment did not go through");
    expect(html).toContain("Nothing is paused: your numbers keep working.");
    expect(html).toContain("Update card");
    expect(html).toContain("We try again in a few days");
  });

  test("cancelled: everything works until the period ends, and it can be undone", async () => {
    const html = await render(page("cancelled"));
    expect(html).toContain("Cancelled. Everything works until 25 Dec 2026.");
    expect(html).toContain("Keep my subscription");
    expect(html).toContain("None. The subscription ends on 25 Dec 2026");
    expect(html).toContain("Nothing more will be charged");
    expect(html).toContain("Price changes");
    expect(html).not.toContain("Cancel subscription");
  });

  test("paused: what stopped, what still works, and where the stored messages wait", async () => {
    const html = await render(page("paused", { phones: ["+34 612 345 678"] }));
    expect(html).toContain("Your number is paused. Nothing was deleted.");
    expect(html).toContain("Stopped for now:");
    expect(html).toContain("Still working:");
    expect(html).toContain("Start subscription · 5 €/month");
    expect(html).toContain("After you subscribe");
    expect(html).toContain('href="/numbers"');
    expect(html).not.toContain("Replay");
  });

  test("operator-open: billed separately, no price and nothing to pay", async () => {
    const data = page("open", { phones: ["+34 612 345 678"] });
    data.billing.hasCustomer = false;
    const html = await render(data);
    expect(html).toContain("Billed separately");
    expect(html).toContain("This workspace is not charged here");
    expect(html).toContain("Adding a number does not create a charge on this page.");
    expect(html).not.toContain("Total per month");
    expect(html).not.toContain("Start subscription");
  });

  test("a member reads status, plan and next charge, and is sent to an owner or admin for the rest", async () => {
    const html = await render(page("active", { canManage: false, payments: null }));
    expect(html).toContain("Active · view only");
    expect(html).toContain("The subscription is active. Everything is running.");
    expect(html).toContain("Ask an owner or admin");
    expect(html).toContain("Total per month");
    expect(html).toContain("25 Dec 2026");
    expect(html).toContain("You cannot see the card, the invoices or the option to cancel.");
    for (const hidden of ["Update card", "Download invoices", "Cancel subscription", "Add a number", "Start subscription"]) {
      expect(html).not.toContain(hidden);
    }
  });

  test("the checkout return is said above the page", async () => {
    expect(await render(page("active"), true)).toContain("Your subscription is active. You can add numbers now.");
  });
});

describe("plan prices", () => {
  test("per-number up to five, then the flat tiers", () => {
    expect([0, 1, 4].map((i) => numberPriceEuros(i, 5))).toEqual([5, 3, 3]);
    expect(numberPriceEuros(0, 6)).toBeNull();
    expect(nextNumberNote(0)).toBe("Your first number costs 5 € per month.");
    expect(nextNumberNote(5)).toBe("Adding a sixth number would add 2 €, so 19 € per month.");
    expect(nextNumberNote(6)).toBe("Adding a seventh number keeps the price at 19 € per month.");
    expect(tierNote(50)).toBeNull();
  });

  test("Creem transaction statuses in the console's words", () => {
    expect(paymentStatusWord("paid")).toEqual({ word: "Paid", warn: false });
    expect(paymentStatusWord("declined")).toEqual({ word: "Not paid", warn: true });
  });

  test("the Creem client reads the next charge and the customer's payments", async () => {
    const config = billingConfig({ CREEM_API_KEY: "creem_test_key", CREEM_WEBHOOK_SECRET: "w", CREEM_PRODUCT_ID: "p" });
    if (!config) throw new Error("expected billing on");
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      const body = url.includes("transactions")
        ? { items: [{ id: "t1", amount: 800, amount_paid: 968, currency: "EUR", status: "paid", created_at: 1_764_000_000 }] }
        : { id: "s1", status: "active", items: [], next_transaction_date: "2026-12-25T09:00:00Z", current_period_end_date: "2026-12-25T09:00:00Z" };
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const creem = creemClient(config, fetcher);
    expect((await creem.subscription("s1")).nextChargeAt).toBe(DEC_25);
    expect(await creem.payments("cus_1")).toEqual([
      { id: "t1", at: 1_764_000_000_000, amountCents: 968, currency: "EUR", status: "paid" },
    ]);
    expect(urls[1]).toBe("https://test-api.creem.io/v1/transactions/search?customer_id=cus_1&page_size=12");
  });
});

describe("72h strip", () => {
  const window = (left: number) => ({ activatedAt: NOW - HOUR, pausesAt: NOW + left, pauseReason: "window_ended" as const });

  test("neutral with more than a day left, amber inside the last day, nothing without the timers", async () => {
    const neutral = await renderInRouter(<SetupWindowStrip window={window(71 * HOUR)} canManage now={NOW} />);
    expect(neutral).toContain("2 d 23 h left");
    expect(neutral).toContain("unless you subscribe");
    expect(neutral).not.toContain("border-l-warning");
    const amber = await renderInRouter(<SetupWindowStrip window={window(23 * HOUR)} canManage now={NOW} />);
    expect(amber).toContain("23 h left");
    expect(amber).toContain("border-l-warning");
    expect(stripMessage(NOW + 48 * 60_000, NOW)).toBe("Subscribe now to avoid a pause.");
    expect(await renderInRouter(<SetupWindowStrip window={{ activatedAt: null, pausesAt: null, pauseReason: null }} canManage now={NOW} />)).toBe("");
    expect(await renderInRouter(<SetupWindowStrip window={window(-1)} canManage now={NOW} />)).toBe("");
  });

  test("a member sees the countdown without the button", async () => {
    const html = await renderInRouter(<SetupWindowStrip window={window(5 * HOUR)} canManage={false} now={NOW} />);
    expect(html).toContain("5 h left");
    expect(html).not.toContain("Start subscription");
  });

  test("the root reads the timers only for a workspace in setup with billing on", () => {
    const resources = (billingStatus: BillingStatus) => ({
      account: { accountId: "a", name: "A", createdAt: 1, billingStatus, canAddNumber: false, funnel: { connectedAt: NOW - HOUR, activatedAt: NOW, pausesAt: NOW + HOUR, pauseReason: "window_ended", warningDueAt: null } },
      keys: [],
      wabas: [],
      phones: [],
    });
    const state = (billingStatus: BillingStatus, billing = true) => ({
      stage: "account-ready" as const,
      resources: resources(billingStatus),
      canAdminister: true,
      role: "owner",
      ...(billing ? { billing: { subscribed: false, canManage: true } } : {}),
    });
    expect(setupWindowFor(state("setup"))).toEqual({
      window: { activatedAt: NOW, pausesAt: NOW + HOUR, pauseReason: "window_ended" },
      canManage: true,
    });
    expect(setupWindowFor(state("active"))).toBeNull();
    expect(setupWindowFor(state("setup", false))).toBeNull();
  });
});

describe("early access end", () => {
  const early = { activatedAt: null, pausesAt: NOW + 9 * 24 * HOUR, pauseReason: "early_access_ended" as const };

  test("the strip and /billing count the days down to the scheduled pause", async () => {
    const strip = await renderInRouter(<SetupWindowStrip window={early} canManage now={NOW} />);
    expect(strip).toContain("Early access ends in 9 days. Subscribe to keep sending.");
    expect(strip).toContain("Start subscription");
    const data = page("open", { phones: ["+34 612 345 678"], window: early });
    expect(billingStage(data, NOW)).toBe("early-access");
    const html = await render(data);
    expect(html).toContain("Early access ends in 9 days. Subscribe to keep sending.");
    expect(html).toContain("Fri 4 Dec");
    expect(html).toContain("Start subscription · 5 €/month");
  });

  test("the root shows the strip for an early-access workspace outside setup", () => {
    const account = { accountId: "a", name: "A", createdAt: 1, billingStatus: "open" as const, canAddNumber: true, funnel: { connectedAt: null, activatedAt: null, pausesAt: NOW + HOUR, pauseReason: "early_access_ended" as const, warningDueAt: null } };
    const state = { stage: "account-ready" as const, resources: { account, keys: [], wabas: [], phones: [] }, canAdminister: true, role: "owner", billing: { subscribed: false, canManage: true } };
    expect(setupWindowFor(state)?.window.pauseReason).toBe("early_access_ended");
  });
});

describe("nav entry", () => {
  const workspace = NAV_MAIN.find((group) => group.id === "workspace");
  if (!workspace) throw new Error("expected the Workspace group");

  test("Billing sits in the Workspace group, for every role while billing is on", () => {
    expect(navItems(workspace, { canAdminister: true, billing: true }).map((item) => item.href)).toEqual([
      "/members",
      "/billing",
      "/settings",
    ]);
    expect(navItems(workspace, { canAdminister: false, billing: true }).map((item) => item.href)).toEqual([
      "/billing",
      "/settings",
    ]);
    expect(navItems(workspace, { canAdminister: true, billing: false }).map((item) => item.href)).toEqual([
      "/members",
      "/settings",
    ]);
  });
});
