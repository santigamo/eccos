import type { AgentAction } from "@eccos/console-contract";
import { LEAST_ROLE, SCOPE_OF } from "../permissions";
import type { ToolDeps } from "./registry";

/** The tools a result can point at, with the action each needs (design § 4). */
const TOOL_ACTION = {
  api_key_create: "administer",
  billing_checkout_link: "administer",
  connect_link_create: "administer",
  connect_status: "view",
  number_recheck: "configure",
  numbers_list: "view",
  template_create: "configure",
  webhook_set: "configure",
} as const satisfies Record<string, AgentAction>;

export type NextTool = keyof typeof TOOL_ACTION;

/** Who can grant `action`, in words. */
export const holders = (action: AgentAction) => {
  const role = LEAST_ROLE[action];
  if (role === "admin") return "an owner or admin";
  return role === "viewer" ? "a viewer or above" : `an ${role} or above`;
};

/**
 * `fact` says where things stand; `call` says how `tool` moves them on. The tool is named only when
 * this connection may call it; otherwise the agent is told which scope the step needs and who can grant it.
 */
export function offer(deps: ToolDeps, fact: string, next?: { tool: NextTool; call?: string }): { detail: string; nextTool: NextTool | null } {
  if (!next) return { detail: fact, nextTool: null };
  const action = TOOL_ACTION[next.tool];
  if (deps.can(action)) return { detail: next.call ? `${fact} ${next.call}` : fact, nextTool: next.tool };
  return {
    detail: `${fact} This connection cannot do it: it needs the ${SCOPE_OF[action]} scope, which ${holders(action)} can grant, or they can do it in the Eccos console.`,
    nextTool: null,
  };
}
