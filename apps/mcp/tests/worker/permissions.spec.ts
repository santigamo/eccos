import type { AgentAction, ConsoleApi, MemberRole } from "@eccos/console-contract";
import { AGENT_SCOPES } from "@eccos/console-contract";
import type { GatewayApi } from "@eccos/gateway-contract";
import { roles } from "@eccos/auth-baseline/permissions";
import consoleGateway from "../../../dashboard/src/server/gateway.ts?raw";
import consoleStepUp from "../../../dashboard/src/auth/step-up.ts?raw";
import { describe, expect, it, vi } from "vitest";
import { CONSOLE_METHODS, GATEWAY_METHODS, LEAST_ROLE, SCOPE_OF, forbiddenMessage } from "../../src/permissions";
import { ForbiddenError, ToolError, capabilities } from "../../src/tools/registry";

const listAccountResources = vi.fn(async () => ({ account: null, keys: [], wabas: [], phones: [] }));
const getBilling = vi.fn(async () => "billing");
const clients = {
  gateway: { listAccountResources, issueApiKey: vi.fn(), eraseByPhone: vi.fn() } as unknown as GatewayApi,
  console: { getBilling, requestElevation: vi.fn(), authorize: vi.fn() } as unknown as ConsoleApi,
};

const owner = { role: "owner", actions: ["view", "operate", "send", "configure", "administer"] } as const;

describe("capabilities", () => {
  it("hands out only the methods bound to the action asked for", async () => {
    const deps = capabilities({ role: "owner", actions: [...owner.actions] }, clients);
    const view = deps.for("view");
    const administer = deps.for("administer");

    expect(Object.keys(view.gateway).sort()).toEqual(
      Object.entries(GATEWAY_METHODS)
        .filter(([, action]) => action === "view")
        .map(([method]) => method)
        .sort(),
    );
    expect(Object.keys(view.console)).toEqual([]);
    expect("getBilling" in view.console).toBe(false);
    expect("issueApiKey" in view.gateway).toBe(false);
    expect(await view.gateway.listAccountResources("acct-a")).toEqual({ account: null, wabas: [], phones: [] });
    expect(listAccountResources).toHaveBeenCalledWith("acct-a");
    expect(await administer.console.getBilling({ userId: "u", organizationId: "o", accountId: "a", clientId: "c" })).toBe("billing");
    expect("listAccountResources" in administer.gateway).toBe(false);
  });

  it("hands out no method the table leaves out, to any action", () => {
    const deps = capabilities({ role: "owner", actions: [...owner.actions] }, clients);
    for (const action of owner.actions) {
      // One action at a time; the loop variable's type is the union deps.for refuses.
      const { gateway, console } = deps.for(action as never) as unknown as Record<"gateway" | "console", object>;
      expect("eraseByPhone" in gateway).toBe(false);
      expect("requestElevation" in console).toBe(false);
      expect("authorize" in console).toBe(false);
    }
  });

  it("types each action's clients to its methods only", () => {
    const deps = capabilities({ role: "owner", actions: [...owner.actions] }, clients);
    // @ts-expect-error getBilling is administer, not view.
    expect(deps.for("view").console.getBilling).toBeUndefined();
    // @ts-expect-error issueApiKey is administer, not view.
    expect(deps.for("view").gateway.issueApiKey).toBeUndefined();
    // @ts-expect-error eraseByPhone is in no tool's table.
    expect(deps.for("administer").gateway.eraseByPhone).toBeUndefined();
    expect(typeof deps.for("administer").gateway.issueApiKey).toBe("function");
  });

  it("refuses the clients for an action the actor lacks, saying what is missing", () => {
    const deps = capabilities({ role: "admin", actions: ["view", "operate"] }, clients);

    expect(deps.can("administer")).toBe(false);
    expect(() => deps.for("administer")).toThrow(ForbiddenError);
    expect(() => deps.for("administer")).toThrow(
      "This connection was not granted the eccos:administer scope that administer needs. Ask the person to connect the agent again and grant it.",
    );
    try {
      deps.for("send");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ForbiddenError).action).toBe("send");
    }
  });
});

describe("what each action's methods return", () => {
  const resources = {
    account: { accountId: "a", name: "Acme", createdAt: 1, billingStatus: "open", canAddNumber: true },
    keys: [{ keyId: "k1", label: "ci", createdAt: 1, revokedAt: null }],
    wabas: [],
    phones: [],
  };
  const gateway = { listAccountResources: vi.fn(async () => resources), hasSubscriber: vi.fn(async () => true) } as unknown as GatewayApi;

  it("strips API keys from listAccountResources under view", async () => {
    const deps = capabilities({ role: "owner", actions: [...owner.actions] }, { gateway, console: clients.console });
    const read = await deps.for("view").gateway.listAccountResources("a");

    expect(read).toEqual({ account: resources.account, wabas: [], phones: [] });
    expect("keys" in read).toBe(false);
    // @ts-expect-error keys are administer: the view read's type has none.
    expect(read.keys).toBeUndefined();
  });

  it("answers hasSubscriber with a bare boolean under view", async () => {
    const deps = capabilities({ role: "viewer", actions: ["view"] }, { gateway, console: clients.console });

    expect(await deps.for("view").gateway.hasSubscriber("w", "a")).toBe(true);
    // @ts-expect-error the subscriber config (its URL) is operate.
    expect(deps.for("view").gateway.getSubscriberConfig).toBeUndefined();
  });
});

describe("deps.for edge cases", () => {
  it("does not accept a union of actions", () => {
    const deps = capabilities({ role: "owner", actions: [...owner.actions] }, clients);
    const either = (Math.random() > 2 ? "view" : "administer") as "view" | "administer";
    // @ts-expect-error a union would hand out both actions' methods.
    expect(() => deps.for(either)).not.toThrow();
  });

  it("refuses a made-up action with a sane message", () => {
    const deps = capabilities({ role: "owner", actions: [...owner.actions] }, clients);

    expect(deps.can("teleport" as never)).toBe(false);
    expect(() => deps.for("teleport" as never)).toThrow(ForbiddenError);
    expect(() => deps.for("teleport" as never)).toThrow('This connection cannot "teleport": Eccos has no such action.');
    expect(forbiddenMessage("teleport" as never, { role: "owner" })).not.toMatch(/undefined/);
  });
});

describe("forbiddenMessage", () => {
  it("names the role when the role falls short", () => {
    expect(forbiddenMessage("configure", { role: "viewer" })).toBe(
      "This connection acts for a viewer, and configure needs an admin or above in this workspace. Ask such a person to do this in the Eccos console.",
    );
    expect(forbiddenMessage("administer", { role: "operator" })).toBe(
      "This connection acts for an operator, and administer needs an admin or above in this workspace. Ask such a person to do this in the Eccos console.",
    );
  });

  it("names the scope when the role allows it and the grant does not", () => {
    expect(forbiddenMessage("send", { role: "operator" })).toBe(
      "This connection was not granted the eccos:send scope that send needs. Ask the person to connect the agent again and grant it.",
    );
    expect(forbiddenMessage("view", { role: "viewer" })).toBe(
      "This connection was not granted the eccos:view scope that view needs. Ask the person to connect the agent again and grant it.",
    );
  });
});

describe("permissions table", () => {
  it("maps each action to the scope that grants it", () => {
    for (const [scope, action] of Object.entries(AGENT_SCOPES)) expect(SCOPE_OF[action as AgentAction]).toBe(scope);
  });

  const order: MemberRole[] = ["viewer", "operator", "admin", "owner"];
  const least = (action: string) =>
    order.find((role) => (roles[role].statements.gateway as readonly string[] | undefined)?.includes(action));

  it("matches the role matrix in @eccos/auth-baseline (send is operator+, contract § 4)", () => {
    expect(LEAST_ROLE).toEqual({
      view: least("view"),
      operate: least("operate"),
      send: least("operate"),
      configure: least("configure"),
      administer: least("administer"),
    });
  });

  /**
   * How the console gates each method, quoted from apps/dashboard so a change there fails here.
   * The console has no `send` action: it sends under `operate`, the same least role.
   */
  const CONSOLE_GATING: Record<string, { action: "view" | "operate" | "configure" | "administer"; evidence: [string, string][] }> = {
    listAccountResources: {
      action: "view",
      evidence: [
        [consoleGateway, `const account = await resolveOrganizationAccount(gateway); return account.resources; }, "view"),`],
        // Keys are the API keys page's, which is administer; under view they are stripped.
        [consoleGateway, `/** Key metadata for the caller's account. \`administer\`, like issuing: which * keys exist is part of managing them. */`],
      ],
    },
    getSubscriberConfig: {
      action: "operate",
      evidence: [[consoleGateway, `withScopedData({ action: "operate", wabaId: data?.wabaId, scope: "any" }, (gateway, org) => gateway.readSubscriberConfig(org),`]],
    },
    hasSubscriber: {
      action: "view",
      evidence: [
        [
          consoleGateway,
          `withScopedRead({ action: "view", wabaId: data?.wabaId, scope: "any" }, (gateway, org) => gateway.readSubscriberConfig(org), ); return res.ok ? res.data.data.url !== null : null;`,
        ],
      ],
    },
    listTemplates: {
      action: "view",
      evidence: [[consoleGateway, `{ action: "view", wabaId: data?.wabaId, scope: "any" }, async (gateway, scope) => (await gateway.listTemplates(`]],
    },
    getStatus: {
      action: "view",
      evidence: [[consoleGateway, `withScopedData({ action: "view", wabaId: data?.wabaId }, (gateway, org) => gateway.readStatus(org),`]],
    },
    getConnectLink: {
      action: "administer",
      evidence: [[consoleGateway, "`administer` to read, and the `connect` step-up row to * make one"]],
    },
    issueConnectLink: {
      action: "administer",
      evidence: [
        [consoleGateway, `await requireActor("connect"); // Without \`replace\` the gateway keeps a live link, so two dialogs opening at once share one. const issued = await gateway.issueConnectLink(`],
        [consoleStepUp, `connect: "administer",`],
      ],
    },
    reconcileWaba: { action: "configure", evidence: [[consoleGateway, `return gateway.reconcileWaba(data.wabaId, account.accountId); }, "configure"),`]] },
    setSubscriberConfig: {
      action: "configure",
      evidence: [
        [consoleGateway, `{ action: "subscriber-config", wabaId: data.wabaId, rejectUnknown: true, scope: "any" }, (gateway, scope) => {`],
        [consoleStepUp, `"subscriber-config": "configure",`],
      ],
    },
    resubscribe: {
      action: "configure",
      evidence: [
        [consoleGateway, `{ action: "resubscribe", wabaId: data?.wabaId, rejectUnknown: true }, (gateway, scope) => gateway.resubscribe(`],
        [consoleStepUp, `resubscribe: "configure",`],
      ],
    },
    listApiKeys: {
      action: "administer",
      evidence: [
        [consoleGateway, `const { accountId } = await adminActorAccount(gateway); return gateway.listApiKeys(accountId);`],
        [consoleGateway, `grant: Grant = "administer",`],
      ],
    },
    issueApiKey: {
      action: "administer",
      evidence: [
        [consoleGateway, `await adminActorAccount(gateway, "api-keys"); const issued = await gateway.issueApiKey(`],
        [consoleStepUp, `"api-keys": "administer",`],
      ],
    },
    revokeApiKey: {
      action: "administer",
      evidence: [[consoleGateway, `await adminActorAccount(gateway, "api-keys"); const revoked = await gateway.revokeApiKey(`]],
    },
    createTemplate: {
      action: "configure",
      evidence: [[consoleGateway, `requireActor("configure"); const scope = await resolveScope(gateway, data.wabaId, true, "any"); const result = await gateway.createTemplate(`]],
    },
    editTemplate: {
      action: "configure",
      evidence: [[consoleGateway, `requireActor("configure"); const scope = await resolveScope(gateway, data.wabaId, true, "any"); const result = await gateway.editTemplate(`]],
    },
    deleteTemplate: {
      action: "configure",
      evidence: [[consoleGateway, `requireActor("configure"); const scope = await resolveScope(gateway, data.wabaId, true, "any"); const result = await gateway.deleteTemplate(`]],
    },
    sendTemplateTest: {
      action: "operate",
      evidence: [[consoleGateway, `requireActor("operate"); const scope = await resolveScope(gateway, data.wabaId, true); const result = await gateway.sendTemplateTest(`]],
    },
    getBilling: {
      action: "administer",
      evidence: [[consoleGateway, `if (!billingEnabled(env)) return null; const { accountId } = await adminActorAccount(gateway); return billingState(gateway, accountId);`]],
    },
    startCheckout: {
      action: "administer",
      evidence: [[consoleGateway, `const { actor, accountId } = await adminActorAccount(gateway); const successUrl = billingReturnUrl(`]],
    },
    openBillingPortal: {
      action: "administer",
      evidence: [[consoleGateway, `const { accountId } = await adminActorAccount(gateway); return { url: await portalUrl(billing, accountId) };`]],
    },
  };

  const flat = (source: string) => source.replace(/\s+/g, " ");
  const table: Record<string, AgentAction> = { ...GATEWAY_METHODS, ...CONSOLE_METHODS };

  it("covers exactly the methods whose console gating is quoted", () => {
    expect(Object.keys(table).sort()).toEqual(Object.keys(CONSOLE_GATING).sort());
  });

  it.each(Object.keys(CONSOLE_GATING))("%s needs the same least role as in the console", (method) => {
    const gating = CONSOLE_GATING[method];
    for (const [source, snippet] of gating?.evidence ?? []) expect(flat(source)).toContain(flat(snippet));
    expect(LEAST_ROLE[table[method] as AgentAction]).toBe(least(gating?.action ?? ""));
  });
});
