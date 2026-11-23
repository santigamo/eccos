import type { AgentAction } from "@eccos/console-contract";
import { LEAST_ROLE, SCOPE_OF } from "../permissions";
import type { ToolDeps } from "./registry";

/** The tools a setup result can point at, with the action each needs (design § 4). */
const TOOL_ACTION = {
  billing_checkout_link: "administer",
  connect_link_create: "administer",
  connect_status: "view",
  number_recheck: "configure",
  numbers_list: "view",
} as const satisfies Record<string, AgentAction>;

export type NextTool = keyof typeof TOOL_ACTION;

const holders = (action: AgentAction) => (LEAST_ROLE[action] === "admin" ? "an owner or admin" : `an ${LEAST_ROLE[action]} or above`);

/**
 * `fact` says where things stand; `call` says how `tool` moves them on. The tool is named only when
 * this connection may call it, as workspace_get's checklist does; otherwise the agent is told who can.
 */
export function offer(deps: ToolDeps, fact: string, next?: { tool: NextTool; call: string }): { detail: string; nextTool: NextTool | null } {
  if (!next) return { detail: fact, nextTool: null };
  const action = TOOL_ACTION[next.tool];
  if (deps.can(action)) return { detail: `${fact} ${next.call}`, nextTool: next.tool };
  return {
    detail: `${fact} This connection cannot do the next step: it needs the ${SCOPE_OF[action]} scope, which ${holders(action)} can grant, or they can do it in the Eccos console.`,
    nextTool: null,
  };
}
