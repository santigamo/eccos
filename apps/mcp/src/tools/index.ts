import { McpServer, createRequestStateCodec } from "@modelcontextprotocol/server";
import { type Clients, type ElevationState, type McpActor, type ToolDefinition, capabilities, registerTool } from "./registry";
import { TEMPLATE_TOOLS } from "./templates";
import { workspaceGet } from "./workspace-get";

/** Every tool the server ships, one table. */
export const TOOLS: readonly ToolDefinition[] = [workspaceGet, ...TEMPLATE_TOOLS];

const REQUEST_STATE_TTL_SECONDS = 600;

/**
 * The MCP server for one request: only the tools whose action the actor has (live role ∩
 * granted scopes, design § 2.1). With a sealing key, `requestState` is an HMAC over
 * { requestId, tool } bound to this grant, and the SDK refuses any other with -32602 before a
 * handler runs. The registry is a parameter so tests can add fixture tools.
 */
export function createServer(
  actor: McpActor,
  clients: Clients,
  registry: readonly ToolDefinition[] = TOOLS,
  requestStateKey?: string,
): McpServer {
  const codec = requestStateKey
    ? createRequestStateCodec<ElevationState>({
        key: requestStateKey,
        ttlSeconds: REQUEST_STATE_TTL_SECONDS,
        bind: () => `${actor.userId}\0${actor.clientId}\0${actor.organizationId}`,
      })
    : null;
  const server = new McpServer({ name: "eccos", version: "0.1.0" }, codec ? { requestState: { verify: codec.verify } } : {});
  const deps = capabilities(actor, clients);
  for (const tool of registry) {
    if (actor.actions.includes(tool.action)) registerTool(server, tool, actor, deps, codec);
  }
  return server;
}
