import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountResources, ConnectPolicy } from "@eccos/gateway-contract";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { SettingsView } = await import("../src/routes/settings");
const { NumbersView } = await import("../src/routes/numbers");
const { billingStatusLabel, checkoutReturnNote } = await import("../src/components/dashboard/billing-panel");
const { validateConfirmCheckoutInput } = await import("../src/server/gateway");

const closed = { connectPolicy: "closed" as const, numbers: 2, monthlyEuros: 8, hasCustomer: false, status: null };
const trial = { connectPolicy: "open" as const, numbers: 2, monthlyEuros: 8, hasCustomer: true, status: "trialing" };

function resources(connectPolicy: ConnectPolicy): AccountResources {
  return {
    account: { accountId: "account-a", name: "Account A", createdAt: 1, connectPolicy },
    keys: [],
    wabas: [
      {
        accountId: "account-a",
        wabaId: "WABA_1",
        callbackUrl: null,
        createdAt: 1,
        provisionedAt: 2,
        status: "active",
        provisioningError: null,
        phones: [{ phoneNumberId: "PN_1", displayPhoneNumber: "+34 600 000 000" }],
        coexistence: {
          onboardingType: "standard",
          verifiedOnboardingType: null,
          status: "not_applicable",
          deadlineAt: null,
          contactsStartedAt: null,
          contactsRequestId: null,
          historyStartedAt: null,
          historyRequestId: null,
          error: null,
        },
      },
    ],
    phones: [],
  };
}

describe("billing off", () => {
  test("Settings has no billing section", () => {
    for (const billing of [undefined, null]) {
      const html = renderToStaticMarkup(<SettingsView accountId="account-a" billing={billing} />);
      expect(html).not.toContain("Billing");
      expect(html).not.toContain("subscription");
    }
  });

  test("Numbers has no banner and the add button works", () => {
    const html = renderToStaticMarkup(<NumbersView resources={resources("open")} />);
    expect(html).not.toContain("subscription");
    expect(html).not.toMatch(/<button[^>]*\sdisabled=/);
  });
});

describe("billing on", () => {
  test("a closed workspace is offered the subscription and told messaging keeps working", () => {
    const html = renderToStaticMarkup(<SettingsView accountId="account-a" billing={closed} />);
    expect(html).toContain("Billing");
    expect(html).toContain("No active subscription");
    expect(html).toContain("8 EUR");
    expect(html).toContain("Messaging keeps working");
    expect(html).toContain("Start subscription");
    expect(html).not.toContain("Manage billing");
  });

  test("a subscribed workspace manages its billing and is not offered a second subscription", () => {
    const html = renderToStaticMarkup(<SettingsView accountId="account-a" billing={trial} />);
    expect(html).toContain("Manage billing");
    expect(html).not.toContain("Start subscription");
  });

  test("status labels", () => {
    expect(billingStatusLabel(trial)).toBe("Trial");
    expect(billingStatusLabel({ ...trial, status: "active" })).toBe("Active");
    expect(billingStatusLabel({ ...closed, hasCustomer: true, status: "past_due" })).toBe("Payment failed");
    expect(billingStatusLabel({ ...trial, hasCustomer: false, status: null })).toBe("No subscription needed");
  });

  test("the checkout return says what happened, and waits when the webhook has not landed", () => {
    expect(checkoutReturnNote(trial)).toContain("trial has started");
    expect(checkoutReturnNote({ ...trial, status: "active" })).toContain("subscription is active");
    expect(checkoutReturnNote(closed)).toContain("still confirming");
    const html = renderToStaticMarkup(<SettingsView accountId="account-a" billing={trial} billingReturned />);
    expect(html).toContain("trial has started");
    expect(renderToStaticMarkup(<SettingsView accountId="account-a" billing={trial} />)).not.toContain("trial has started");
  });

  test("Numbers shows the banner and disables adding while closed", () => {
    const html = renderToStaticMarkup(<NumbersView resources={resources("closed")} />);
    expect(html).toContain("Adding a number needs an active subscription");
    expect(html).toContain('href="/settings"');
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>\+ Add number/);
  });

  test("the checkout return only accepts an id-shaped subscription", () => {
    expect(validateConfirmCheckoutInput({ subscriptionId: "sub_1AbC" })).toEqual({ subscriptionId: "sub_1AbC" });
    expect(() => validateConfirmCheckoutInput({ subscriptionId: "sub 1/../x" })).toThrow();
    expect(() => validateConfirmCheckoutInput({})).toThrow();
  });
});
