import { McpServer, type ServerContext, createRequestStateCodec } from "@modelcontextprotocol/server";
import { auditEvent } from "../audit";
import { type Clients, type ElevationState, type McpActor, type ToolDefinition, capabilities, registerTool } from "./registry";
import { TEMPLATE_TOOLS } from "./templates";
import { workspaceGet } from "./workspace-get";

/** Every tool the server ships, one table. */
export const TOOLS: readonly ToolDefinition[] = [workspaceGet, ...TEMPLATE_TOOLS];

const REQUEST_STATE_TTL_SECONDS = 600;
const MIN_KEY_BYTES = 32;

let shortKeyReported = false;

/**
 * The sealing key when it is usable. A key shorter than 32 bytes counts as unset, so URL
 * elicitation stays off; that is said once per isolate, never with the value.
 */
function usableKey(key: string | undefined): string | null {
  if (!key) return null;
  if (new TextEncoder().encode(key).byteLength >= MIN_KEY_BYTES) return key;
  if (!shortKeyReported) {
    shortKeyReported = true;
    console.error(
      JSON.stringify({
        level: "error",
        area: "mcp",
        event: "request_state_key_too_short",
        detail: "REQUEST_STATE_KEY must be at least 32 bytes; URL elicitation is off until it is.",
      }),
    );
  }
  return null;
}

export interface ServerOptions {
  requestStateKey?: string;
  /** The tool a `tools/call` with this JSON-RPC id names, for the audit line of a refused state. */
  toolOf?: (id: unknown) => string | undefined;
}

/**
 * The MCP server for one request: only the tools whose action the actor has (live role ∩
 * granted scopes, design § 2.1). With a sealing key, `requestState` is an HMAC over
 * { requestId, tool } bound to this grant, and the SDK refuses any other with -32602 before a
 * handler runs; each refusal writes an audit line. The registry is a parameter so tests can add
 * fixture tools.
 */
export function createServer(
  actor: McpActor,
  clients: Clients,
  registry: readonly ToolDefinition[] = TOOLS,
  { requestStateKey, toolOf = () => undefined }: ServerOptions = {},
): McpServer {
  const key = usableKey(requestStateKey);
  const codec = key
    ? createRequestStateCodec<ElevationState>({
        key,
        ttlSeconds: REQUEST_STATE_TTL_SECONDS,
        bind: () => `${actor.userId}\0${actor.clientId}\0${actor.organizationId}`,
      })
    : null;
  const verify = async (state: string, ctx: ServerContext) => {
    if (!codec) throw new Error("no request state is expected");
    try {
      return await codec.verify(state, ctx);
    } catch (error) {
      auditEvent({
        action: toolOf(ctx.mcpReq.id) ?? ctx.mcpReq.method,
        actorUserId: actor.userId,
        organizationId: actor.organizationId,
        accountId: actor.accountId,
        clientId: actor.clientId,
        resource: null,
        outcome: "denied",
        detail: "invalid_request_state",
      });
      throw error;
    }
  };
  const server = new McpServer({ name: "eccos", version: "0.1.0" }, codec ? { requestState: { verify } } : {});
  const deps = capabilities(actor, clients);
  const step = { codec, console: clients.console };
  for (const tool of registry) {
    if (actor.actions.includes(tool.action)) registerTool(server, tool, actor, deps, step);
  }
  return server;
}
