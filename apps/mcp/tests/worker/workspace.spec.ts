import type { Client } from "@modelcontextprotocol/client";
import type { AccountResources } from "@eccos/gateway-contract";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentAction, MemberRole } from "@eccos/console-contract";
import { ALL_SCOPES, activeWaba, connect, consoleStub, gatewayStub, grantToken, makeActor, resetStubs } from "./helpers";

beforeEach(resetStubs);

const OPEN = {
  ok: true,
  billing: { billingStatus: "active", canAddNumber: true, numbers: 1, monthlyEuros: 15, hasCustomer: true, explicitStatus: false },
} as const;
const CLOSED = {
  ok: true,
  billing: { billingStatus: "setup", canAddNumber: false, numbers: 0, monthlyEuros: 0, hasCustomer: false, explicitStatus: false },
} as const;

const account = (accountId: string, resources: Partial<AccountResources> = {}): AccountResources => ({
  account: { accountId, name: "Acme", createdAt: 1, billingStatus: "open", canAddNumber: true },
  keys: [],
  wabas: [],
  phones: [],
  ...resources,
});

async function workspaceGet(client: Client) {
  const result = await client.callTool({ name: "workspace_get", arguments: {} });
  const [block] = result.content as { type: string; text: string }[];
  expect(JSON.parse(block?.text ?? "null")).toEqual(result.structuredContent);
  return result;
}

describe("workspace_get", () => {
  it("reports an empty workspace, naming the next tool only where this connection may call it", async () => {
    const actor = makeActor({ role: "admin", actions: ["view", "administer"] });
    await gatewayStub.seed("acct-a", { resources: account("acct-a") });
    await consoleStub.setBilling("acct-a", CLOSED);
    const client = await connect(await grantToken(actor, ["eccos:view", "eccos:administer", "offline_access"]));
    const result = await workspaceGet(client);
    await client.close();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      actingAs: { userId: actor.userId, role: "admin" },
      workspace: { organizationId: "org-a" },
      scopes: ["eccos:view", "eccos:administer", "offline_access"],
      actions: ["view", "administer"],
      elevatedUntil: null,
      setup: {
        complete: false,
        steps: [
          {
            id: "subscription",
            state: "todo",
            count: null,
            detail:
              "A subscription is required before a number can be connected. Call billing_checkout_link and give the person the link.",
            nextTool: "billing_checkout_link",
            blockedBy: null,
          },
          {
            id: "number",
            state: "todo",
            count: 0,
            detail:
              "No WhatsApp number is connected. Call connect_link_create and give the person the link; they connect a number through Embedded Signup.",
            nextTool: "connect_link_create",
            blockedBy: "subscription",
          },
          {
            id: "webhook",
            state: "todo",
            count: null,
            detail: "No forwarding target can be set until a WhatsApp Business account is connected. This connection was not granted the eccos:configure scope that configure needs. Ask the person to connect the agent again and grant it.",
            nextTool: null,
            blockedBy: "number",
          },
          {
            id: "api_key",
            state: "todo",
            count: 0,
            detail: "No active API key. Call api_key_create to issue one for the /v1 API.",
            nextTool: "api_key_create",
            blockedBy: null,
          },
          {
            id: "template",
            state: "todo",
            count: 0,
            detail: "No message template can be created until a WhatsApp Business account is connected. This connection was not granted the eccos:configure scope that configure needs. Ask the person to connect the agent again and grant it.",
            nextTool: null,
            blockedBy: "number",
          },
        ],
      },
    });
  });

  it("reports a fully set-up workspace", async () => {
    // In the future, or the console reads the elevation as expired and reports null.
    const until = Date.now() + 60 * 60 * 1000;
    const actor = makeActor({ elevatedUntil: until });
    await gatewayStub.seed("acct-a", {
      resources: account("acct-a", {
        wabas: [activeWaba("waba-1", "acct-a", ["111", "222"])],
        keys: [
          { keyId: "k1", label: "ci", createdAt: 1, revokedAt: null },
          { keyId: "k0", label: "old", createdAt: 1, revokedAt: 2 },
        ],
      }),
      subscriber: { "waba-1": { url: "https://hooks.acme.example/wa", hasSecret: true, lastForward: null } },
      templates: {
        "waba-1": {
          ok: true,
          data: { data: [{ name: "hello", status: "APPROVED" }, { name: "promo", status: "PENDING" }] },
        },
      },
    });
    await consoleStub.setBilling("acct-a", OPEN);
    const client = await connect(await grantToken(actor));
    const result = await workspaceGet(client);
    await client.close();

    expect(result.structuredContent).toMatchObject({ elevatedUntil: new Date(until).toISOString() });
    expect((result.structuredContent as { setup: unknown }).setup).toEqual({
      complete: true,
      steps: [
        { id: "subscription", state: "done", count: null, detail: "A number can be added.", nextTool: null, blockedBy: null },
        { id: "number", state: "done", count: 2, detail: "2 numbers are connected and active.", nextTool: null, blockedBy: null },
        {
          id: "webhook",
          state: "done",
          count: null,
          detail: "Events from WABA waba-1 are forwarded to its subscriber URL.",
          nextTool: null,
          blockedBy: null,
        },
        { id: "api_key", state: "done", count: 1, detail: "1 active API key.", nextTool: null, blockedBy: null },
        { id: "template", state: "done", count: 1, detail: "1 approved template on WABA waba-1.", nextTool: null, blockedBy: null },
      ],
    });
  });

  it("marks billing not applicable when the deployment runs without it", async () => {
    await gatewayStub.seed("acct-a", { resources: account("acct-a") });
    await consoleStub.setBilling("acct-a", { ok: false, code: "billing_disabled" });
    const client = await connect(await grantToken(makeActor()));
    const result = await workspaceGet(client);
    await client.close();

    expect((result.structuredContent as { setup: { steps: unknown[] } }).setup.steps[0]).toEqual({
      id: "subscription",
      state: "not_applicable",
      count: null,
      detail: "This deployment runs without billing, so no subscription is needed.",
      nextTool: null,
      blockedBy: null,
    });
    expect((result.structuredContent as { setup: { steps: { blockedBy: unknown }[] } }).setup.steps[1]?.blockedBy).toBeNull();
  });

  it("does not ask for billing without administer, says who can see it, and still reports the rest", async () => {
    await gatewayStub.seed("acct-a", { resources: account("acct-a") });
    await consoleStub.setBilling("acct-a", OPEN);
    const client = await connect(await grantToken(makeActor({ role: "viewer", actions: ["view"] }), ["eccos:view"]));
    const result = await workspaceGet(client);
    await client.close();

    const steps = (result.structuredContent as { setup: { steps: { id: string; blockedBy: unknown }[] } }).setup.steps;
    expect(result.isError).toBeFalsy();
    expect(steps[0]).toEqual({
      id: "subscription",
      state: "unknown",
      count: null,
      detail:
        "Billing is not shown to this connection. This connection acts for a viewer, and administer needs an admin or above in this workspace. Ask such a person to do this in the Eccos console.",
      nextTool: null,
      blockedBy: null,
    });
    expect(steps.map((step) => step.id)).toEqual(["subscription", "number", "webhook", "api_key", "template"]);
    expect(steps[1]?.blockedBy).toBeNull();
    expect(await consoleStub.billingCalls()).toEqual([]);
  });

  it("reads only view-level facts for a viewer: whether a forwarding target exists, never its config or the keys", async () => {
    await gatewayStub.seed("acct-a", {
      resources: account("acct-a", {
        wabas: [activeWaba("waba-1", "acct-a", ["111"])],
        keys: [{ keyId: "k1", label: "ci-secret-label", createdAt: 1, revokedAt: null }],
      }),
      subscriber: { "waba-1": { url: "https://hooks.acme.example/wa", hasSecret: true, lastForward: null } },
    });
    const client = await connect(await grantToken(makeActor({ role: "viewer", actions: ["view"] }), ["eccos:view"]));
    const result = await workspaceGet(client);
    await client.close();

    const methods = (await gatewayStub.calls()).map((call) => call.method);
    const steps = (result.structuredContent as { setup: { steps: { id: string; state: string }[] } }).setup.steps;
    expect(methods).toContain("hasSubscriber");
    expect(methods).not.toContain("getSubscriberConfig");
    expect(methods).not.toContain("listApiKeys");
    expect(steps.find((step) => step.id === "webhook")?.state).toBe("done");
    expect(steps.find((step) => step.id === "api_key")?.state).toBe("unknown");
    expect(JSON.stringify(result)).not.toMatch(/hooks\.acme|ci-secret-label|k1/);
  });

  it("explains the console's own billing refusal to a connection that holds administer", async () => {
    await gatewayStub.seed("acct-a", { resources: account("acct-a") });
    await consoleStub.setBilling("acct-a", { ok: false, code: "forbidden" });
    const client = await connect(await grantToken(makeActor({ role: "admin" })));
    const result = await workspaceGet(client);
    await client.close();

    expect((result.structuredContent as { setup: { steps: unknown[] } }).setup.steps[0]).toEqual({
      id: "subscription",
      state: "unknown",
      count: null,
      detail: "Billing is visible only to owners and admins of this workspace. Ask one of them whether a subscription is active.",
      nextTool: null,
      blockedBy: null,
    });
  });

  it("names every next tool for an owner holding every scope", async () => {
    await gatewayStub.seed("acct-a", { resources: account("acct-a") });
    await consoleStub.setBilling("acct-a", CLOSED);
    const client = await connect(await grantToken(makeActor()));
    const steps = ((await workspaceGet(client)).structuredContent as { setup: { steps: { nextTool: unknown }[] } }).setup.steps;
    await client.close();

    expect(steps.map((step) => step.nextTool)).toEqual([
      "billing_checkout_link",
      "connect_link_create",
      "webhook_set",
      "api_key_create",
      "template_create",
    ]);
  });

  it("names no tool an operator cannot call, and says who can", async () => {
    await gatewayStub.seed("acct-a", { resources: account("acct-a") });
    const client = await connect(
      await grantToken(makeActor({ role: "operator", actions: ["view", "operate", "send"] }), ["eccos:view", "eccos:operate", "eccos:send"]),
    );
    const steps = ((await workspaceGet(client)).structuredContent as { setup: { steps: { id: string; nextTool: unknown; detail: string }[] } })
      .setup.steps;
    await client.close();

    expect(steps.map((step) => step.nextTool)).toEqual([null, null, null, null, null]);
    expect(steps.find((step) => step.id === "number")?.detail).toBe(
      "No WhatsApp number is connected. This connection acts for an operator, and administer needs an admin or above in this workspace. Ask such a person to do this in the Eccos console.",
    );
    expect(steps.find((step) => step.id === "api_key")).toMatchObject({ state: "unknown", count: null });
    expect(steps.find((step) => step.id === "api_key")?.detail).toBe(
      "API keys are not shown to this connection. This connection acts for an operator, and administer needs an admin or above in this workspace. Ask such a person to do this in the Eccos console.",
    );
  });

  it("advertises itself as read-only and idempotent", async () => {
    const client = await connect(await grantToken(makeActor()));
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.find((tool) => tool.name === "workspace_get")?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("follows a WABA that is connected and not active yet, and a template read that failed", async () => {
    const pending = { ...activeWaba("waba-1", "acct-a", []), status: "pending" as const, provisionedAt: null };
    await gatewayStub.seed("acct-a", {
      resources: account("acct-a", { wabas: [pending] }),
      templates: { "waba-1": { ok: false, error: { message: "Meta is down" } } },
    });
    await consoleStub.setBilling("acct-a", OPEN);
    const client = await connect(await grantToken(makeActor()));
    const steps = ((await workspaceGet(client)).structuredContent as { setup: { steps: { id: string }[] } }).setup.steps;
    await client.close();

    expect(steps.find((step) => step.id === "number")).toEqual({
      id: "number",
      state: "in_progress",
      count: 0,
      detail: "A WhatsApp Business account is connected but no number is active yet. Call numbers_list to see its provisioning status.",
      nextTool: "numbers_list",
      blockedBy: null,
    });
    expect(steps.find((step) => step.id === "webhook")).toMatchObject({ state: "todo", nextTool: "webhook_set", blockedBy: null });
    expect(steps.find((step) => step.id === "template")).toEqual({
      id: "template",
      state: "unknown",
      count: null,
      detail: "Templates could not be read from Meta just now. Call workspace_get again later.",
      nextTool: null,
      blockedBy: null,
    });
  });

  it("reaches only the actor's own account", async () => {
    await gatewayStub.seed("acct-a", { resources: account("acct-a", { wabas: [activeWaba("waba-a", "acct-a", ["1"])] }) });
    await gatewayStub.seed("acct-b", {
      resources: account("acct-b", {
        wabas: [activeWaba("waba-b", "acct-b", ["2"])],
        keys: [{ keyId: "kb", label: "b", createdAt: 1, revokedAt: null }],
      }),
    });
    await consoleStub.setBilling("acct-b", OPEN);
    const client = await connect(await grantToken(makeActor({ organizationId: "org-a", accountId: "acct-a" })));
    const result = await workspaceGet(client);
    await client.close();

    const calls = await gatewayStub.calls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.accountId === "acct-a")).toBe(true);
    expect(JSON.stringify(result.structuredContent)).not.toMatch(/acct-b|waba-b|org-b/);
    expect(result.structuredContent).toMatchObject({ workspace: { organizationId: "org-a" } });
  });
});

/** What the console's actions resolve to: the role's actions (contract § 4) ∩ the granted scopes. */
const ROLE_ACTIONS: Record<MemberRole, AgentAction[]> = {
  owner: ["view", "operate", "send", "configure", "administer"],
  admin: ["view", "operate", "send", "configure", "administer"],
  operator: ["view", "operate", "send"],
  viewer: ["view"],
};

describe("workspace_get billing gate", () => {
  const WITHOUT_ADMINISTER = ALL_SCOPES.filter((scope) => scope !== "eccos:administer");

  it.each(
    (["owner", "admin", "operator", "viewer"] as const).flatMap((role) => [
      [role, true, role === "owner" || role === "admin"] as const,
      [role, false, false] as const,
    ]),
  )("%s, eccos:administer granted: %s → getBilling called: %s", async (role, administer, called) => {
    const scope = administer ? ALL_SCOPES : WITHOUT_ADMINISTER;
    const actions = ROLE_ACTIONS[role].filter((action) => scope.includes(`eccos:${action}`));
    await gatewayStub.seed("acct-a", { resources: account("acct-a") });
    await consoleStub.setBilling("acct-a", OPEN);
    const client = await connect(await grantToken(makeActor({ role, actions }), scope));
    const result = await workspaceGet(client);
    await client.close();

    const subscription = (result.structuredContent as { setup: { steps: { state: string }[] } }).setup.steps[0];
    expect((await consoleStub.billingCalls()).length).toBe(called ? 1 : 0);
    expect(subscription?.state).toBe(called ? "done" : "unknown");
  });

  it("never reads another account's billing, and without administer reads none", async () => {
    await gatewayStub.seed("acct-a", { resources: account("acct-a") });
    await gatewayStub.seed("acct-b", { resources: account("acct-b") });
    await consoleStub.setBilling("acct-a", CLOSED);
    await consoleStub.setBilling("acct-b", OPEN);
    const admin = makeActor({ role: "admin", organizationId: "org-a", accountId: "acct-a" });
    const operator = makeActor({ role: "operator", actions: ["view", "operate", "send"], organizationId: "org-b", accountId: "acct-b" });

    const adminClient = await connect(await grantToken(admin));
    const adminSteps = ((await workspaceGet(adminClient)).structuredContent as { setup: { steps: { state: string }[] } }).setup.steps;
    await adminClient.close();
    const operatorClient = await connect(await grantToken(operator, WITHOUT_ADMINISTER));
    const operatorResult = await workspaceGet(operatorClient);
    await operatorClient.close();

    expect((await consoleStub.billingCalls()).map((ref) => ref.accountId)).toEqual(["acct-a"]);
    expect(adminSteps[0]?.state).toBe("todo");
    expect((operatorResult.structuredContent as { setup: { steps: { state: string }[] } }).setup.steps[0]?.state).toBe("unknown");
    expect(JSON.stringify(operatorResult.structuredContent)).not.toMatch(/monthlyEuros|connectPolicy|A number can be added/);
  });
});
