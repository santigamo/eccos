import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountResources, ConnectPolicy } from "@eccos/gateway-contract";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { SettingsView } = await import("../src/routes/settings");
const { NumbersView } = await import("../src/routes/numbers");
const { billingStatusLabel, checkoutReturnNote } = await import("../src/components/dashboard/billing-panel");
const { normalizeConnectError } = await import("../src/components/dashboard/connect-outcome");
const { returnPathFor } = await import("../src/lib/connect-result");
const { validateConfirmCheckoutInput } = await import("../src/server/gateway");

const closed = { connectPolicy: "closed" as const, numbers: 2, monthlyEuros: 8, hasCustomer: false };
const trial = { connectPolicy: "open" as const, numbers: 2, monthlyEuros: 8, hasCustomer: true };

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

  test("a gateway that refuses new numbers is explained without pointing at a billing page", () => {
    const html = renderToStaticMarkup(
      <NumbersView resources={resources("closed")} connectError="subscription_required" />,
    );
    expect(html).toContain("This workspace cannot add new numbers");
    expect(html).not.toContain("subscription");
    expect(html).not.toContain('href="/settings"');
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

  test("status labels come from the stored policy", () => {
    expect(billingStatusLabel(trial)).toBe("Active");
    expect(billingStatusLabel(closed)).toBe("No active subscription");
    expect(billingStatusLabel({ ...trial, hasCustomer: false })).toBe("No subscription needed");
  });

  test("the checkout return says what happened, and waits when the webhook has not landed", () => {
    expect(checkoutReturnNote(trial, { status: "trialing" })).toContain("trial has started");
    expect(checkoutReturnNote(trial, { status: "active" })).toContain("subscription is active");
    expect(checkoutReturnNote(closed, { status: null })).toContain("still confirming");
    const html = renderToStaticMarkup(
      <SettingsView accountId="account-a" billing={trial} billingReturned={{ status: "trialing" }} />,
    );
    expect(html).toContain("trial has started");
    expect(renderToStaticMarkup(<SettingsView accountId="account-a" billing={trial} />)).not.toContain("trial has started");
  });

  test("Numbers warns while closed and never blocks connecting", () => {
    // A closed workspace must still be able to reconnect a number it already has.
    const html = renderToStaticMarkup(<NumbersView resources={resources("closed")} billing />);
    expect(html).toContain("Adding a new number needs an active subscription");
    expect(html).toContain('href="/settings"');
    expect(html).toContain("+ Add number");
    expect(html).not.toMatch(/<button[^>]*\sdisabled=/);
  });

  test("a refused new number says why and links to billing", () => {
    const html = renderToStaticMarkup(
      <NumbersView resources={resources("closed")} billing connectError="subscription_required" />,
    );
    expect(html).toContain("needs an active subscription, so the new ones were left out");
    expect(html).toContain("Open billing</a>");
    expect(normalizeConnectError("subscription_required")).toBe("subscription_required");
  });

  test("a connect that left new numbers out lands on Numbers saying so", () => {
    expect(returnPathFor("/numbers", 0)).toBe("/numbers");
    expect(returnPathFor("/numbers", 2)).toBe("/numbers?connectSkipped=2");
    expect(returnPathFor("/numbers", 1, true)).toBe("/numbers?connectSkipped=1&connectError=subscription_required");
  });

  test("the checkout return only accepts an id-shaped subscription", () => {
    expect(validateConfirmCheckoutInput({ subscriptionId: "sub_1AbC" })).toEqual({ subscriptionId: "sub_1AbC" });
    expect(() => validateConfirmCheckoutInput({ subscriptionId: "sub 1/../x" })).toThrow();
    expect(() => validateConfirmCheckoutInput({})).toThrow();
  });
});
