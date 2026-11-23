import { McpServer } from "@modelcontextprotocol/server";
import { numberRecheck, numbersList, statusGet } from "./numbers";
import { type McpActor, type ToolDefinition, type ToolDeps, registerTool } from "./registry";
import { workspaceGet } from "./workspace-get";

/** Every tool the server ships, one table. */
export const TOOLS: readonly ToolDefinition[] = [
  workspaceGet,
  numbersList,
  numberRecheck,
  statusGet,
];

/**
 * The MCP server for one request: only the tools whose action the actor has (live role ∩
 * granted scopes, design § 2.1). The registry is a parameter so tests can add fixture tools.
 */
export function createServer(actor: McpActor, deps: ToolDeps, registry: readonly ToolDefinition[] = TOOLS): McpServer {
  const server = new McpServer({ name: "eccos", version: "0.1.0" });
  for (const tool of registry) {
    if (actor.actions.includes(tool.action)) registerTool(server, tool, actor, deps);
  }
  return server;
}
