import { AGENT_SCOPES, type AgentAction, type AgentScope, type MemberRole } from "@eccos/console-contract";

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

/** What an agent is told when its connection lacks an action: what it needs and who has it. */
export function forbiddenMessage(action: AgentAction): string {
  return `This connection cannot ${action}: that needs the ${SCOPE_OF[action]} scope, granted by a person who is ${LEAST_ROLE[action] === "viewer" ? "a viewer" : `an ${LEAST_ROLE[action]}`} or above in this workspace. Ask such a person to connect the agent with that scope, or to do this in the Eccos console.`;
}
