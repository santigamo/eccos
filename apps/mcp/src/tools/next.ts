import type { AgentAction } from "@eccos/console-contract";
import { forbiddenMessage } from "../permissions";
import type { McpActor, ToolDeps } from "./registry";

/** The tools a result can point at, with the action each needs (design § 4). */
const TOOL_ACTION = {
  api_key_create: "administer",
  billing_checkout_link: "administer",
  connect_link_create: "administer",
  connect_status: "administer",
  number_recheck: "configure",
  numbers_list: "view",
  template_create: "configure",
  template_send_test: "send",
  templates_list: "view",
  webhook_set: "configure",
} as const satisfies Record<string, AgentAction>;

export type NextTool = keyof typeof TOOL_ACTION;

/**
 * `fact` says where things stand; `call` says how `tool` moves them on. The tool is named only when
 * this connection may call it; otherwise the agent is told what the connection lacks.
 */
export function offer(
  deps: ToolDeps,
  actor: McpActor,
  fact: string,
  next?: { tool: NextTool; call?: string },
): { detail: string; nextTool: NextTool | null } {
  if (!next) return { detail: fact, nextTool: null };
  const action = TOOL_ACTION[next.tool];
  if (deps.can(action)) return { detail: next.call ? `${fact} ${next.call}` : fact, nextTool: next.tool };
  return { detail: `${fact} ${forbiddenMessage(action, actor)}`, nextTool: null };
}
