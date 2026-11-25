import { beforeEach, describe, expect, it } from "vitest";
import {
  METADATA_URL,
  call,
  connect,
  consoleStub,
  errorOf,
  gatewayStub,
  grantToken,
  listedTools,
  makeActor,
  postMcp,
  resetStubs,
  toolsCall,
} from "./helpers";

beforeEach(resetStubs);

const admin = () => makeActor({ role: "admin", actions: ["view", "configure", "administer"] });
const CLOSED = {
  ok: true,
  billing: { billingStatus: "setup", canAddNumber: false, numbers: 0, monthlyEuros: 0, hasCustomer: false, explicitStatus: false },
} as const;
const OPEN = {
  ok: true,
  billing: { billingStatus: "active", canAddNumber: true, numbers: 2, monthlyEuros: 30, hasCustomer: true, explicitStatus: false },
} as const;

describe("billing_get", () => {
  it("says a subscription is needed and names billing_checkout_link", async () => {
    await consoleStub.setBilling("acct-a", CLOSED);
    const client = await connect(await grantToken(admin()));
    const result = await call(client, "billing_get");
    await client.close();

    expect(result.structuredContent).toEqual({
      enabled: true,
      connectPolicy: "closed",
      status: "setup",
      numbers: 0,
      monthlyEuros: 0,
      hasBillingAccount: false,
      detail:
        "A subscription is required before a number can be added; numbers already connected keep sending. 0 numbers are billed, 0 euros a month. Call billing_checkout_link and give the person the link.",
      nextTool: "billing_checkout_link",
    });
  });

  it("reports an open workspace and its price", async () => {
    await consoleStub.setBilling("acct-a", OPEN);
    const client = await connect(await grantToken(admin()));
    const result = await call(client, "billing_get");
    await client.close();

    expect(result.structuredContent).toMatchObject({
      enabled: true,
      connectPolicy: "open",
      status: "active",
      detail: "Numbers can be added. 2 numbers are billed, 30 euros a month.",
      nextTool: null,
    });
  });

  it("answers plainly when the deployment runs without billing", async () => {
    const client = await connect(await grantToken(admin()));
    const result = await call(client, "billing_get");
    await client.close();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      enabled: false,
      connectPolicy: null,
      status: null,
      numbers: null,
      monthlyEuros: null,
      hasBillingAccount: null,
      detail: "This deployment runs without billing, so no subscription is needed.",
      nextTool: null,
    });
  });

  it.each([
    ["forbidden", /^Billing is visible only to owners and admins/],
    ["revoked", /^This agent's connection to Eccos was revoked/],
    ["not_a_member", /no longer a member of the workspace/],
  ] as const)("explains a %s refusal", async (code, text) => {
    await consoleStub.setBilling("acct-a", { ok: false, code });
    const client = await connect(await grantToken(admin()));
    expect(errorOf(await call(client, "billing_get"))).toMatch(text);
    await client.close();
  });

  it("is not listed for an operator, and challenges a grant without eccos:administer", async () => {
    const operator = await connect(await grantToken(makeActor({ role: "operator", actions: ["view", "operate", "send"] })));
    const names = await listedTools(operator);
    await operator.close();
    expect(names).not.toContain("billing_get");
    expect(names).not.toContain("billing_checkout_link");

    for (const tool of ["billing_get", "billing_checkout_link"]) {
      const response = await postMcp(toolsCall(tool), { token: await grantToken(admin(), ["eccos:view", "eccos:configure"]) });
      expect(response.status).toBe(403);
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer realm="OAuth", error="insufficient_scope", scope="eccos:administer", resource_metadata="${METADATA_URL}"`,
      );
    }
    expect(await consoleStub.billingCalls()).toEqual([]);
    expect(await consoleStub.billingLinkCalls()).toEqual([]);
  });

  it("asks the console about the actor's own account only", async () => {
    await consoleStub.setBilling("acct-a", CLOSED);
    await consoleStub.setBilling("acct-b", OPEN);
    const actor = admin();
    const client = await connect(await grantToken(actor));
    const result = await call(client, "billing_get");
    await client.close();

    expect(result.structuredContent).toMatchObject({ connectPolicy: "closed" });
    expect(await consoleStub.billingCalls()).toEqual([
      { userId: actor.userId, organizationId: "org-a", accountId: "acct-a", clientId: "client-1" },
    ]);
    expect(await gatewayStub.calls()).toEqual([]);
  });
});

describe("billing_checkout_link", () => {
  it("returns the checkout for a person to open", async () => {
    await consoleStub.setBillingLink("acct-a", "startCheckout", { ok: true, kind: "checkout", url: "https://creem.example/checkout/ch_1" });
    const client = await connect(await grantToken(admin()));
    const result = await call(client, "billing_checkout_link");
    await client.close();

    expect(result.structuredContent).toEqual({
      kind: "checkout",
      url: "https://creem.example/checkout/ch_1",
      detail:
        "Give this checkout link to the person; they open it in a browser and pay by card. Then call billing_get to confirm numbers can be added.",
      nextTool: "billing_get",
    });
    expect((await consoleStub.billingLinkCalls()).map((entry) => entry.method)).toEqual(["startCheckout"]);
  });

  it("returns the portal when a subscription is live, and for manage", async () => {
    const portal = { ok: true, kind: "portal", url: "https://creem.example/portal/cus_1" } as const;
    await consoleStub.setBillingLink("acct-a", "startCheckout", portal);
    await consoleStub.setBillingLink("acct-a", "openBillingPortal", portal);
    const client = await connect(await grantToken(admin()));
    const subscribe = await call(client, "billing_checkout_link", { purpose: "subscribe" });
    const manage = await call(client, "billing_checkout_link", { purpose: "manage" });
    await client.close();

    expect(subscribe.structuredContent).toMatchObject({ kind: "portal", nextTool: null });
    expect(manage.structuredContent).toEqual(subscribe.structuredContent);
    expect((await consoleStub.billingLinkCalls()).map((entry) => entry.method)).toEqual(["startCheckout", "openBillingPortal"]);
  });

  it("says there is no portal before the first checkout", async () => {
    await consoleStub.setBillingLink("acct-a", "openBillingPortal", { ok: false, code: "no_billing_account" });
    const client = await connect(await grantToken(admin()));
    const text = errorOf(await call(client, "billing_checkout_link", { purpose: "manage" }));
    await client.close();

    expect(text).toBe(
      'This workspace has never subscribed, so it has no billing portal yet. Call billing_checkout_link with purpose: "subscribe" to start a subscription.',
    );
  });

  it("says no subscription is needed when the deployment runs without billing", async () => {
    const client = await connect(await grantToken(admin()));
    const text = errorOf(await call(client, "billing_checkout_link"));
    await client.close();

    expect(text).toBe(
      "This Eccos deployment runs without billing, so no subscription is needed and there is no checkout. Call connect_link_create to connect a number.",
    );
  });

  it("explains a refusal from the console", async () => {
    await consoleStub.setBillingLink("acct-a", "startCheckout", { ok: false, code: "forbidden" });
    const client = await connect(await grantToken(admin()));
    expect(errorOf(await call(client, "billing_checkout_link"))).toMatch(/^Billing is visible only to owners and admins/);
    await client.close();
  });

  it("opens a checkout for the actor's own account only", async () => {
    await consoleStub.setBillingLink("acct-b", "startCheckout", { ok: true, kind: "checkout", url: "https://creem.example/checkout/b" });
    const client = await connect(await grantToken(admin()));
    const text = errorOf(await call(client, "billing_checkout_link"));
    await client.close();

    expect(text).toMatch(/runs without billing/);
    expect((await consoleStub.billingLinkCalls()).map((entry) => entry.actor.accountId)).toEqual(["acct-a"]);
  });
});
