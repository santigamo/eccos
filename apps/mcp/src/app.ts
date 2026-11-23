import type { Actor } from "@eccos/console-contract";
import { type OAuthResourceContext, OAuthResourceServer, insufficientScope } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { Hono } from "hono";
import { AGENT_SCOPES } from "@eccos/console-contract";
import { auditEvent } from "./audit";
import type { Env } from "./env";
import { SCOPE_OF, forbiddenMessage } from "./permissions";
import { TOOLS, createServer } from "./tools";
import { type McpActor, type ToolDefinition, logFailure } from "./tools/registry";

interface Props {
  actor: Actor;
}

/** Access tokens are JWTs; anything else is refused here, before it costs the console a lookup. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const RATE_LIMIT_PERIOD_SECONDS = 60;

/** The MCP SDK's own request cap, enforced here before this Worker parses anything. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

const jsonRpcError = (status: number, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });

/** The body as text, or null when it is larger than the cap, by Content-Length or by reading it. */
async function cappedText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (declared > MAX_BODY_BYTES) return null;
  const reader = request.clone().body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

type Call = { id?: unknown; method?: unknown; params?: { name?: unknown; _meta?: Record<string, unknown> } };

const toolCalls = (body: unknown): Call[] =>
  (Array.isArray(body) ? body : [body]).filter((message): message is Call => (message as Call | null)?.method === "tools/call");

/**
 * A tool error for a known tool the caller's role does not allow, in the era the request
 * speaks: a 2026-07-28 request names its protocol version in `_meta`, and its result carries
 * `resultType`.
 */
function refusal(call: Call, text: string): Response {
  const modern = call.params?._meta?.["io.modelcontextprotocol/protocolVersion"] !== undefined;
  const result = {
    content: [{ type: "text", text }],
    isError: true,
    ...(modern ? { resultType: "complete" } : {}),
  };
  return Response.json({ jsonrpc: "2.0", id: call.id ?? null, result });
}

/**
 * Before the MCP server sees a `tools/call` of a known tool: a scope the token lacks is the
 * scope challenge (403); a scope it carries but a role that does not allow the action is a tool
 * error that says what is missing, audited. The server itself never sees such a tool, since it
 * registers only the actor's actions.
 */
function preDispatch(body: unknown, caller: McpActor, auth: OAuthResourceContext<Props>["auth"], registry: readonly ToolDefinition[]) {
  for (const call of toolCalls(body)) {
    const tool = registry.find((candidate) => candidate.name === call.params?.name);
    if (!tool) continue;
    const scope = SCOPE_OF[tool.action];
    if (!caller.scope.includes(scope)) return insufficientScope(auth, [scope]);
    if (!caller.actions.includes(tool.action)) {
      auditEvent({
        action: tool.name,
        actorUserId: caller.userId,
        organizationId: caller.organizationId,
        accountId: caller.accountId,
        clientId: caller.clientId,
        resource: null,
        outcome: "denied",
        detail: "forbidden",
      });
      return refusal(call, forbiddenMessage(tool.action, caller));
    }
  }
  return null;
}

/**
 * The resource server, built from the bindings on the first request (`OAuthResourceServer`
 * validates its metadata when constructed). It is configuration: nothing about a token or an
 * actor outlives the request that carried it.
 */
function resourceServer(env: Env, registry: readonly ToolDefinition[]) {
  return new OAuthResourceServer<Env, Props>({
    resourceMetadata: { resource: env.MCP_RESOURCE, authorization_servers: [env.ISSUER] },
    // Published as scopes_supported and named in the 401 challenge, so one consent can cover
    // every scope; the consent page lets the person untick any (design § 3.2).
    requiredScopes: Object.keys(AGENT_SCOPES),
    validateToken: (bindings) => async (resource, token) => {
      if (!JWT_SHAPE.test(token)) return null;
      const result = await bindings.CONSOLE.authorize(resource, token).catch((error: unknown) => {
        logFailure("authorize_failure", null, error);
        throw error;
      });
      if (!result.ok) return null;
      return {
        props: { actor: result.actor },
        audience: result.audience,
        expiresAt: result.expiresAt,
        scope: result.scope,
        userId: result.actor.userId,
        clientId: result.actor.clientId,
      };
    },
    handler: {
      async fetch(request: Request, bindings: Env, ctx: OAuthResourceContext<Props>) {
        const consoleOrigin = new URL(bindings.CONSOLE_ORIGIN).origin;
        const origin = request.headers.get("origin");
        if (origin !== null && origin !== consoleOrigin) return jsonRpcError(403, -32000, `Invalid Origin: ${origin}`);

        const { actor } = ctx.props;
        const { success } = await bindings.MCP_RATE_LIMITER.limit({ key: `${actor.userId}:${actor.clientId}` });
        if (!success) {
          return Response.json(
            {
              error: "rate_limited",
              error_description: `Too many requests from this agent. Wait ${RATE_LIMIT_PERIOD_SECONDS} seconds, then retry.`,
            },
            { status: 429, headers: { "Retry-After": String(RATE_LIMIT_PERIOD_SECONDS) } },
          );
        }

        const caller = { ...actor, scope: ctx.auth.scope };
        const names = new Map<unknown, string>();
        if (request.method === "POST") {
          const text = await cappedText(request);
          if (text === null) return jsonRpcError(413, -32600, `Request body is larger than ${MAX_BODY_BYTES} bytes.`);
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = undefined;
          }
          const refused = preDispatch(body, caller, ctx.auth, registry);
          if (refused) return refused;
          for (const call of toolCalls(body)) if (typeof call.params?.name === "string") names.set(call.id, call.params.name);
        }

        const clients = { gateway: bindings.GATEWAY, console: bindings.CONSOLE };
        const mcp = createMcpHandler(() => createServer(caller, clients, registry, {
            requestStateKey: bindings.REQUEST_STATE_KEY,
            consoleOrigin,
            toolOf: (id) => names.get(id),
          }), {
          route: "/mcp",
          legacy: "stateless",
          allowedHostnames: [new URL(bindings.MCP_RESOURCE).hostname],
          allowedOriginHostnames: [new URL(consoleOrigin).hostname],
        });
        return mcp(request, bindings, ctx);
      },
    },
  });
}

export function createApp(registry: readonly ToolDefinition[] = TOOLS) {
  let server: OAuthResourceServer<Env, Props> | undefined;
  const app = new Hono<{ Bindings: Env }>();
  app.all("*", (c) => {
    server ??= resourceServer(c.env, registry);
    return server.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
  });
  return app;
}
