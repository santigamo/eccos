import { AGENT_SCOPES, type Actor, type AgentAction, type AgentScope } from "@eccos/console-contract";
import { type OAuthResourceContext, OAuthResourceServer, insufficientScope } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { Hono } from "hono";
import type { Env } from "./env";
import { TOOLS, createServer } from "./tools";
import type { ToolDefinition } from "./tools/registry";

interface Props {
  actor: Actor;
}

/** Access tokens are JWTs; anything else is refused here, before it costs the console a lookup. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const SCOPE_OF = Object.fromEntries(Object.entries(AGENT_SCOPES).map(([scope, action]) => [action, scope])) as Record<
  AgentAction,
  AgentScope
>;

const RATE_LIMIT_PERIOD_SECONDS = 60;

/**
 * The scope a `tools/call` of a known tool needs and the token lacks, if any. The MCP server
 * itself never sees such a tool (it registers only the actor's actions), so the challenge is
 * answered here, where the whole registry is known.
 */
async function missingScope(request: Request, granted: string[], registry: readonly ToolDefinition[]) {
  if (request.method !== "POST") return undefined;
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => undefined);
  for (const message of Array.isArray(body) ? body : [body]) {
    const call = message as { method?: unknown; params?: { name?: unknown } } | null;
    if (call?.method !== "tools/call") continue;
    const tool = registry.find((candidate) => candidate.name === call.params?.name);
    if (tool && !granted.includes(SCOPE_OF[tool.action])) return SCOPE_OF[tool.action];
  }
  return undefined;
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
      const result = await bindings.CONSOLE.authorize(resource, token);
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
        const scope = await missingScope(request, ctx.auth.scope, registry);
        if (scope) return insufficientScope(ctx.auth, [scope]);

        const caller = { ...actor, scope: ctx.auth.scope };
        const deps = { gateway: bindings.GATEWAY, console: bindings.CONSOLE, consoleOrigin: new URL(bindings.CONSOLE_ORIGIN).origin };
        const mcp = createMcpHandler(() => createServer(caller, deps, registry), {
          route: "/mcp",
          legacy: "stateless",
          allowedHostnames: [new URL(bindings.MCP_RESOURCE).hostname],
          allowedOriginHostnames: [new URL(bindings.CONSOLE_ORIGIN).hostname],
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
