import type { Client } from "@modelcontextprotocol/client";
import type { AccountResources } from "@eccos/gateway-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { activeWaba, connect, consoleStub, gatewayStub, grantToken, makeActor, resetStubs } from "./helpers";

beforeEach(resetStubs);

const OPEN = {
  ok: true,
  billing: { connectPolicy: "open", numbers: 1, monthlyEuros: 15, hasCustomer: true, explicitPolicy: false },
} as const;
const CLOSED = {
  ok: true,
  billing: { connectPolicy: "closed", numbers: 0, monthlyEuros: 0, hasCustomer: false, explicitPolicy: false },
} as const;

const account = (accountId: string, resources: Partial<AccountResources> = {}): AccountResources => ({
  account: { accountId, name: "Acme", createdAt: 1, connectPolicy: "open" },
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
  it("reports an empty workspace and the next tool for every missing step", async () => {
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
            detail: "No forwarding target can be set until a WhatsApp Business account is connected.",
            nextTool: "webhook_set",
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
            detail: "No message template can be created until a WhatsApp Business account is connected.",
            nextTool: "template_create",
            blockedBy: "number",
          },
        ],
      },
    });
  });

  it("reports a fully set-up workspace", async () => {
    const until = Date.UTC(2026, 10, 24, 12, 0, 0);
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

    expect(result.structuredContent).toMatchObject({ elevatedUntil: "2026-11-24T12:00:00.000Z" });
    expect((result.structuredContent as { setup: unknown }).setup).toEqual({
      complete: true,
      steps: [
        { id: "subscription", state: "done", count: null, detail: "Billing is active: numbers can be added.", nextTool: null, blockedBy: null },
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

  it("says billing is for owners and admins when the role may not see it, and still reports the rest", async () => {
    await gatewayStub.seed("acct-a", { resources: account("acct-a") });
    await consoleStub.setBilling("acct-a", { ok: false, code: "forbidden" });
    const client = await connect(await grantToken(makeActor({ role: "viewer", actions: ["view"] })));
    const result = await workspaceGet(client);
    await client.close();

    const steps = (result.structuredContent as { setup: { steps: { id: string; blockedBy: unknown }[] } }).setup.steps;
    expect(result.isError).toBeFalsy();
    expect(steps[0]).toEqual({
      id: "subscription",
      state: "unknown",
      count: null,
      detail: "Billing is visible only to owners and admins of this workspace. Ask one of them whether a subscription is active.",
      nextTool: null,
      blockedBy: null,
    });
    expect(steps.map((step) => step.id)).toEqual(["subscription", "number", "webhook", "api_key", "template"]);
    expect(steps[1]?.blockedBy).toBeNull();
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
