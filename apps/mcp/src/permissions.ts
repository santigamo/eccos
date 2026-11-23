import type { ConsoleApi } from "@eccos/console-contract";
import { AGENT_SCOPES, type AgentAction, type AgentScope, type MemberRole } from "@eccos/console-contract";
import type { GatewayApi } from "@eccos/gateway-contract";

/** The scope that grants each action (design § 3.2). */
export const SCOPE_OF = Object.fromEntries(Object.entries(AGENT_SCOPES).map(([scope, action]) => [action, scope])) as Record<
  AgentAction,
  AgentScope
>;

/**
 * The least role that holds each action: the role matrix in @eccos/auth-baseline/permissions,
 * with `send` at operator+ (contract § 4). Restated here because that module imports
 * better-auth at runtime and must stay out of this Worker; tests/worker/permissions.spec.ts
 * fails if the two drift.
 */
export const LEAST_ROLE = {
  view: "viewer",
  operate: "operator",
  send: "operator",
  configure: "admin",
  administer: "admin",
} as const satisfies Record<AgentAction, MemberRole>;

/**
 * Every `GatewayRPC` method a tool may call, bound to the action the console gates it with
 * (apps/dashboard/src/server/gateway.ts; the console sends under `operate`, which is `send`
 * here). A method left out is reachable by no tool. tests/worker/permissions.spec.ts quotes the
 * console's gating for each entry.
 */
export const GATEWAY_METHODS = {
  listAccountResources: "view",
  getSubscriberConfig: "view",
  listTemplates: "view",
  getStatus: "view",
  getConnectLink: "administer",
  issueConnectLink: "administer",
  reconcileWaba: "configure",
  setSubscriberConfig: "configure",
  resubscribe: "configure",
  listApiKeys: "administer",
  issueApiKey: "administer",
  revokeApiKey: "administer",
  createTemplate: "configure",
  editTemplate: "configure",
  deleteTemplate: "configure",
  sendTemplateTest: "send",
} as const satisfies { [K in keyof GatewayApi]?: AgentAction };

/** The same for `ConsoleRPC`. `authorize` and `requestElevation` belong to the server, not a tool. */
export const CONSOLE_METHODS = {
  getBilling: "administer",
  startCheckout: "administer",
  openBillingPortal: "administer",
} as const satisfies { [K in keyof ConsoleApi]?: AgentAction };

type MethodsOf<Table, A extends AgentAction> = { [K in keyof Table]: Table[K] extends A ? K : never }[keyof Table];

/** What `deps.for(action)` hands out: only the methods bound to `action`. */
export interface ClientsFor<A extends AgentAction> {
  gateway: Pick<GatewayApi, MethodsOf<typeof GATEWAY_METHODS, A> & keyof GatewayApi>;
  console: Pick<ConsoleApi, MethodsOf<typeof CONSOLE_METHODS, A> & keyof ConsoleApi>;
}

/** An object carrying only `table`'s methods bound to `action`, each calling through `binding`. */
export function methodsFor(binding: object, table: Record<string, AgentAction>, action: AgentAction): Record<string, unknown> {
  const target = binding as Record<string, (...args: unknown[]) => unknown>;
  return Object.fromEntries(
    Object.entries(table)
      .filter(([, bound]) => bound === action)
      .map(([method]) => [method, (...args: unknown[]) => target[method]?.(...args)]),
  );
}

const ROLE_RANK: Record<MemberRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

const withArticle = (role: MemberRole) => `${role === "viewer" ? "a" : "an"} ${role}`;

/**
 * What an agent is told when its connection lacks an action: the role, when the person's role
 * falls short; otherwise the scope the grant left out.
 */
export function forbiddenMessage(action: AgentAction, actor: { role: MemberRole }): string {
  const least = LEAST_ROLE[action];
  if (ROLE_RANK[actor.role] < ROLE_RANK[least]) {
    return `This connection acts for ${withArticle(actor.role)}, and ${action} needs ${withArticle(least)} or above in this workspace. Ask such a person to do this in the Eccos console.`;
  }
  return `This connection was not granted the ${SCOPE_OF[action]} scope that ${action} needs. Ask the person to connect the agent again and grant it.`;
}
