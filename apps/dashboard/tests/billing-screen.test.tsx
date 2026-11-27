import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountResources, BillingStatus } from "@eccos/gateway-contract";
import { blocksSends, mayAddNumber } from "@eccos/gateway-contract/billing-status";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { SettingsView } = await import("../src/routes/settings");
const { FirstRunConnect, NumbersView } = await import("../src/routes/numbers");
const { closedNotice, sendingPausedNotice } = await import("../src/billing/notice");
const { SendingNotice, SubscriptionNotice } = await import("../src/components/dashboard/subscription-notice");
const { sendingPaused } = await import("../src/lib/sends-paused");
const { sendTestFailureCopy, sendTextFailureCopy } = await import("../src/lib/failure");
const { billingStatusLabel, checkoutReturnNote } = await import("../src/components/dashboard/billing-panel");
const { normalizeConnectError } = await import("../src/components/dashboard/connect-outcome");
const { returnPathFor } = await import("../src/lib/connect-result");
const { validateConfirmCheckoutInput } = await import("../src/server/gateway");

const base = { numbers: 2, monthlyEuros: 8, explicitStatus: true };
const closed = { ...base, billingStatus: "closed" as const, canAddNumber: false, hasCustomer: false };
const setup = { ...closed, billingStatus: "setup" as const, explicitStatus: false };
const trial = { ...base, billingStatus: "active" as const, canAddNumber: true, hasCustomer: true };

/** A workspace with one number, as the gateway reports it. */
function resources(billingStatus: BillingStatus): AccountResources {
  return {
    account: {
      accountId: "account-a",
      name: "Account A",
      createdAt: 1,
      billingStatus,
      canAddNumber: mayAddNumber(billingStatus, 1),
    },
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
      const html = renderToStaticMarkup(<SettingsView accountId="account-a" canAdminister billing={billing} />);
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
    expect(html).not.toContain("Start subscription");
  });

  test("first run on a closed workspace keeps the wizard, with the reason (Open Meta is off: connect-wizard.test)", () => {
    const html = renderToStaticMarkup(<FirstRunConnect closed billing={false} />);
    expect(html).toContain("This workspace cannot add new numbers.");
    expect(html).not.toContain("subscription");
    expect(html).toContain("Let&#x27;s connect your WhatsApp number");
  });

  test("Numbers has no banner and the add button works", () => {
    const html = renderToStaticMarkup(<NumbersView resources={resources("open")} />);
    expect(html).not.toContain("subscription");
    expect(html).not.toMatch(/<button[^>]*\sdisabled=/);
  });
});

describe("billing on", () => {
  test("Settings keeps a summary of billing and sends the rest to /billing", () => {
    const html = renderToStaticMarkup(<SettingsView accountId="account-a" canAdminister billing={closed} />);
    expect(html).toContain("Billing");
    expect(html).toContain("No active subscription");
    expect(html).toContain('href="/billing"');
    expect(html).toContain("Open billing");
    expect(html).not.toContain("Start subscription");
    expect(html).not.toContain("Manage billing");
  });

  test("status labels come from the stored status", () => {
    expect(billingStatusLabel(trial)).toBe("Active");
    expect(billingStatusLabel(closed)).toBe("No active subscription");
    expect(billingStatusLabel(setup)).toBe("No subscription yet");
    expect(billingStatusLabel({ ...trial, billingStatus: "past_due" })).toBe("Payment failed, retrying");
    expect(billingStatusLabel({ ...trial, billingStatus: "cancelled" })).toBe("Cancelled, active until the period ends");
    const open = { ...trial, billingStatus: "open" as const };
    expect(billingStatusLabel(open)).toBe("Active");
    // Opened by the operator with no Creem customer: a reseller pays.
    expect(billingStatusLabel({ ...open, hasCustomer: false })).toBe("Billed separately");
    // Open only because the deployment default is open.
    expect(billingStatusLabel({ ...open, hasCustomer: false, explicitStatus: false })).toBe("No subscription needed");
  });

  test("the checkout return says what happened, and waits when the webhook has not landed", () => {
    expect(checkoutReturnNote(trial)).toContain("subscription is active");
    expect(checkoutReturnNote(closed)).toContain("still confirming");
    expect(checkoutReturnNote(setup)).toContain("still confirming");
  });

  test("the first number needs no subscription; a second needs a live one; only paused and closed stop sends", () => {
    expect(mayAddNumber("setup", 0)).toBe(true);
    expect(mayAddNumber("setup", 1)).toBe(false);
    for (const status of ["active", "past_due", "open"] as const) expect(mayAddNumber(status, 3)).toBe(true);
    for (const status of ["cancelled", "paused", "closed"] as const) expect(mayAddNumber(status, 0)).toBe(false);
    expect(["setup", "active", "past_due", "cancelled", "paused", "closed", "open"].filter((s) => blocksSends(s as BillingStatus))).toEqual([
      "paused",
      "closed",
    ]);
  });

  test("right after connecting, Numbers does not lead with the second-number subscription", () => {
    const html = renderToStaticMarkup(<NumbersView resources={resources("setup")} billing />);
    expect(html).not.toContain("needs an active subscription");
    expect(html).not.toContain("Start subscription");
    expect(html).toContain("+ Add number");
  });

  test("adding a number says a second one needs a subscription, and the first keeps working", () => {
    const html = renderToStaticMarkup(<SubscriptionNotice billing numbers={1} reconnect />);
    expect(html).toContain("Adding a new number needs an active subscription: 5 € per month + VAT for 1 number. The price follows");
    expect(html).toContain("keep working and can be reconnected");
    expect(html).toContain("new number left out");
    expect(html).toContain("Start subscription");
  });

  test("a closed workspace still reaches the connect fork, and the pause banner is its one CTA", () => {
    // A closed workspace must still be able to reconnect a number it already has.
    const html = renderToStaticMarkup(<NumbersView resources={resources("closed")} billing />);
    expect(html).toContain("+ Add number");
    expect(html).not.toContain("Start subscription");
    expect(html).not.toMatch(/<button[^>]*\sdisabled=/);
  });

  test("first run on a closed workspace offers the subscription instead of Meta's window", () => {
    const html = renderToStaticMarkup(<FirstRunConnect closed billing />);
    expect(html).toContain("needs an active subscription: 5 € per month + VAT for 1 number.");
    expect(html).toContain("Start subscription");
    expect(html).not.toContain("connect your WhatsApp number");
    const pastDue = renderToStaticMarkup(<FirstRunConnect closed billing subscribed />);
    expect(pastDue).toContain("Manage billing");
    expect(pastDue).not.toContain("Start subscription");
    const open = renderToStaticMarkup(<FirstRunConnect closed={false} billing />);
    expect(open).toContain("connect your WhatsApp number");
    expect(open).not.toContain("subscription");
    expect(open).not.toMatch(/<button[^>]*\sdisabled=/);
  });

  test("a member who cannot manage billing is told who can, with no button and no price", () => {
    const ASK = "Adding a new number needs an active subscription. Ask an owner or admin of this workspace to start it.";
    const views = [
      renderToStaticMarkup(<FirstRunConnect closed billing canManageBilling={false} />),
      renderToStaticMarkup(<FirstRunConnect closed billing subscribed canManageBilling={false} />),
      renderToStaticMarkup(<SubscriptionNotice billing numbers={1} reconnect canManage={false} />),
      renderToStaticMarkup(<SubscriptionNotice billing subscribed numbers={1} reconnect canManage={false} />),
    ];
    for (const html of views) {
      expect(html).toContain(ASK);
      expect(html).not.toContain("Start subscription");
      expect(html).not.toContain("Manage billing");
      expect(html).not.toContain("€");
    }
    // Reconnecting what the workspace already has stays open to them.
    expect(renderToStaticMarkup(<NumbersView resources={resources("closed")} billing canManageBilling={false} />)).toContain("+ Add number");
    const refused = renderToStaticMarkup(
      <NumbersView resources={resources("closed")} billing canManageBilling={false} connectError="subscription_required" />,
    );
    expect(refused).not.toContain("Open billing");
  });

  test("an owner or admin keeps the price and the button", () => {
    const gate = renderToStaticMarkup(<FirstRunConnect closed billing canManageBilling />);
    expect(gate).toContain("5 € per month + VAT for 1 number.");
    expect(gate).toContain("Start subscription");
    const notice = renderToStaticMarkup(<SubscriptionNotice billing numbers={1} reconnect canManage />);
    expect(notice).toContain("Start subscription");
    expect(closedNotice(true, 3, false)).not.toContain("€");
    expect(closedNotice(false, 3, false)).toBe("This workspace cannot add new numbers.");
  });

  test("the notice quotes what a checkout started now charges", () => {
    // `checkoutUrl` prices the numbers connected today, and at least one.
    expect(closedNotice(true, 0)).toContain("5 € per month + VAT for 1 number.");
    expect(closedNotice(true, 5)).toContain("17 € per month + VAT for 5 numbers.");
    expect(closedNotice(true, 6)).toContain("19 € per month + VAT for 6 numbers.");
    expect(closedNotice(true, 16)).toContain("49 € per month + VAT for 16 numbers.");
    expect(closedNotice(true, 3)).toContain("The price follows the numbers you connect.");
  });

  test("a closed workspace whose subscription still exists is sent to manage it", () => {
    const html = renderToStaticMarkup(<SubscriptionNotice billing subscribed numbers={1} reconnect />);
    expect(html).toContain("Manage billing");
    expect(html).not.toContain("Start subscription");
  });

  test("the reconnect sentence follows owning a WABA, not having a number", () => {
    expect(renderToStaticMarkup(<SubscriptionNotice billing numbers={0} reconnect />)).toContain("can be reconnected");
    expect(renderToStaticMarkup(<SubscriptionNotice billing numbers={0} reconnect={false} />)).not.toContain("reconnected");
  });

  test("a workspace opened by the operator with no Creem customer is billed separately and shown no price", () => {
    const free = renderToStaticMarkup(
      <SettingsView accountId="account-a" canAdminister billing={{ ...trial, billingStatus: "open", hasCustomer: false }} />,
    );
    expect(free).toContain("Billed separately");
    expect(free).not.toContain("No subscription needed");
    expect(free).not.toContain("EUR");
  });

  test("a refused new number says why and links to billing", () => {
    const html = renderToStaticMarkup(
      <NumbersView resources={resources("closed")} billing connectError="subscription_required" />,
    );
    expect(html).toContain("needs an active subscription, so the new ones were left out");
    expect(html).toContain("Open billing</a>");
    expect(normalizeConnectError("subscription_required")).toBe("subscription_required");
  });

  test("a workspace whose sends are blocked is told so on every page, Numbers included", () => {
    const ready = { stage: "account-ready" as const, canAdminister: true, role: "owner" };
    const flag = { subscribed: true, canManage: true };
    expect(sendingPaused({ ...ready, resources: resources("closed"), billing: flag })).toEqual({
      billing: true,
      ...flag,
    });
    expect(sendingPaused({ ...ready, resources: resources("paused"), billing: flag })).not.toBeNull();
    for (const status of ["setup", "past_due", "cancelled", "active", "open"] as const) {
      expect(sendingPaused({ ...ready, resources: resources(status), billing: flag })).toBeNull();
    }
    expect(sendingPaused({ ...ready, resources: { ...resources("closed"), wabas: [] } })).toBeNull();
    expect(sendingPaused({ ...ready, resources: resources("closed") })).toEqual({
      billing: false,
      subscribed: false,
      canManage: false,
    });

    const html = renderToStaticMarkup(<SendingNotice billing subscribed heldMessages={37} />);
    expect(html).toContain("Sending and forwarding are paused. 37 incoming messages are stored safely. Subscribe to resume.");
    expect(html).toContain("Manage billing");
    expect(renderToStaticMarkup(<SendingNotice billing />)).toContain("Start subscription");
    const member = renderToStaticMarkup(<SendingNotice billing canManage={false} heldMessages={1} />);
    expect(member).toContain("1 incoming message is stored safely.");
    expect(member).toContain("Ask an owner or admin");
    expect(member).not.toContain("<button");
    expect(sendingPausedNotice(true, true, null)).toContain("Incoming messages are stored safely.");
    expect(sendingPausedNotice(false)).not.toContain("ubscri");
    expect(renderToStaticMarkup(<SubscriptionNotice billing numbers={1} reconnect canSend={false} />)).toContain(
      "they keep receiving but cannot send",
    );
  });

  test("after payment Numbers offers to replay what the pause held, with the late-reply warning", () => {
    const held = { events: 37, messages: 30 };
    const owner = renderToStaticMarkup(<NumbersView resources={resources("active")} billing held={held} />);
    expect(owner).toContain("37 events are stored and your tool has not seen them");
    expect(owner).toContain("Replay 37 stored events");
    expect(owner).toContain("they may get late replies");
    const member = renderToStaticMarkup(<NumbersView resources={resources("active")} billing canConnect={false} held={held} />);
    expect(member).not.toContain("Replay 37");
    expect(member).toContain("Ask an owner or admin of this workspace to replay them.");
    // Not while still paused, and not with nothing held.
    expect(renderToStaticMarkup(<NumbersView resources={resources("paused")} billing held={held} />)).not.toContain("Replay");
    expect(renderToStaticMarkup(<NumbersView resources={resources("active")} billing held={{ events: 0, messages: 0 }} />)).not.toContain(
      "Replay",
    );
  });

  test("a send refused for the subscription says so in the composer and the test send", () => {
    expect(sendTestFailureCopy("subscription_required", null).title).toBe("Sending is paused");
    expect(sendTextFailureCopy("subscription_required", null).detail).toContain("no active subscription");
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
