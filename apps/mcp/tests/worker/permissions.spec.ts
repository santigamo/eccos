import type { AgentAction, ConsoleApi, MemberRole } from "@eccos/console-contract";
import { AGENT_SCOPES } from "@eccos/console-contract";
import type { GatewayApi } from "@eccos/gateway-contract";
import { roles } from "@eccos/auth-baseline/permissions";
import consoleGateway from "../../../dashboard/src/server/gateway.ts?raw";
import consoleStepUp from "../../../dashboard/src/auth/step-up.ts?raw";
import { describe, expect, it, vi } from "vitest";
import { CONSOLE_METHODS, GATEWAY_METHODS, LEAST_ROLE, SCOPE_OF, forbiddenMessage } from "../../src/permissions";
import { ForbiddenError, ToolError, capabilities } from "../../src/tools/registry";

const listAccountResources = vi.fn(async () => "resources");
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
    expect(await view.gateway.listAccountResources("acct-a")).toBe("resources");
    expect(listAccountResources).toHaveBeenCalledWith("acct-a");
    expect(await administer.console.getBilling({ userId: "u", organizationId: "o", accountId: "a", clientId: "c" })).toBe("billing");
    expect("listAccountResources" in administer.gateway).toBe(false);
  });

  it("hands out no method the table leaves out, to any action", () => {
    const deps = capabilities({ role: "owner", actions: [...owner.actions] }, clients);
    for (const action of owner.actions) {
      const { gateway, console } = deps.for(action);
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
      evidence: [[consoleGateway, `requireGatewayPermission(auth, request, "view"); const state = await gateway.readDashboardState(`]],
    },
    getSubscriberConfig: {
      action: "view",
      evidence: [[consoleGateway, `withScopedRead({ action: "view", wabaId: data?.wabaId, scope: "any" }, (gateway, org) => gateway.readSubscriberConfig(org),`]],
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
