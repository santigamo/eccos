import { forbiddenMessage } from "../permissions";
import type { McpActor, ToolDeps } from "./registry";

/** The tools a result can point at. What each needs comes from the registry (`deps.toolActions`). */
export const NEXT_TOOLS = [
  "api_key_create",
  "api_keys_list",
  "billing_checkout_link",
  "connect_link_create",
  "connect_status",
  "number_recheck",
  "numbers_list",
  "template_create",
  "template_send_test",
  "templates_list",
  "webhook_set",
] as const;

export type NextTool = (typeof NEXT_TOOLS)[number];

/**
 * `fact` says where things stand; `call` says how `tool` moves them on. The tool is named only when
 * this connection holds every action it needs, its reads included; otherwise the agent is told the
 * first action the connection lacks.
 */
export function offer(
  deps: ToolDeps,
  actor: McpActor,
  fact: string,
  next?: { tool: NextTool; call?: string },
): { detail: string; nextTool: NextTool | null } {
  if (!next) return { detail: fact, nextTool: null };
  const actions = deps.toolActions[next.tool];
  if (!actions) return { detail: fact, nextTool: null };
  const missing = actions.find((action) => !deps.can(action));
  if (missing === undefined)
    return {
      detail: next.call ? `${fact} ${next.call}` : fact,
      nextTool: next.tool,
    };
  return {
    detail: `${fact} ${forbiddenMessage(missing, actor)}`,
    nextTool: null,
  };
}
