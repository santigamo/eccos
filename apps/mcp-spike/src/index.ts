/**
 * THROWAWAY spike (task 0.3): Hono + OAuthResourceServer + createMcpHandler, stateless,
 * validating tokens through the console's ConsoleRPC entrypoint over a service binding.
 */
import { Hono } from "hono";
import { OAuthResourceServer, insufficientScope } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { McpServer, createRequestStateCodec, inputRequired } from "@modelcontextprotocol/server";
import { z } from "zod";

interface Actor {
  userId: string;
  organizationId: string;
  accountId: string;
  role: string;
  elevatedUntil: number | null;
  clientId: string;
}
type AuthorizeResult =
  | { ok: true; actor: Actor; audience: string; expiresAt: number; scope: string[]; clientId: string }
  | { ok: false; reason: string; detail?: string };

interface Env {
  MCP_RESOURCE: string;
  ISSUER: string;
  REQUEST_STATE_KEY: string;
  CONSOLE: {
    ping(): Promise<string>;
    authorize(resource: string, token: string): Promise<AuthorizeResult>;
    requestElevation(actor: Actor, tool: string): Promise<{ url: string; requestId: string; expiresAt: number }>;
    elevationOf(actor: Actor): Promise<number | null>;
  };
  GATEWAY: Record<string, (...args: unknown[]) => Promise<unknown>>;
}

const approvalResult = (tool: string, url: string, expiresAt: number, reason = "elevation_required") => {
  const structuredContent = {
    status: "approval_required",
    reason,
    message: `A person must approve sensitive actions for this agent. Ask them to open the link, then call ${tool} again with the same arguments.`,
    approvalUrl: url,
    expiresAt: new Date(expiresAt).toISOString(),
    retry: { tool, when: "after_approval", sameArguments: true },
  };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
};

function createServer(env: Env) {
  const codec = createRequestStateCodec({ key: env.REQUEST_STATE_KEY, ttlSeconds: 600 });
  const server = new McpServer(
    { name: "eccos-mcp-spike", version: "0.0.0" },
    { requestState: { verify: codec.verify } } as never,
  );
  const actor = () => getMcpAuthContext()?.props.actor as Actor | undefined;

  server.registerTool(
    "whoami",
    { description: "Who the agent acts as (spike).", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async (_args, ctx) => {
      const out = {
        actor: actor(),
        authInfo: (ctx as { http?: { authInfo?: unknown } }).http?.authInfo ?? null,
        clientCapabilities: (ctx.mcpReq as { envelope?: Record<string, unknown> }).envelope ?? null,
      };
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
    },
  );

  server.registerTool(
    "api_key_create",
    {
      description: "Step-up tool (spike): needs a live elevation.",
      inputSchema: z.object({ label: z.string(), carrier: z.enum(["auto", "structured"]).default("auto") }),
    },
    async ({ label, carrier }, ctx) => {
      const who = actor();
      if (!who) throw new Error("no actor");
      // The elevation is ALWAYS re-read from the console; requestState is only a hint.
      const elevatedUntil = await env.CONSOLE.elevationOf(who);
      if (elevatedUntil && elevatedUntil > Date.now()) {
        const out = { status: "claim_ready", label, elevatedUntil: new Date(elevatedUntil).toISOString() };
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
      }
      const req = ctx.mcpReq as unknown as {
        envelope?: Record<string, { elicitation?: { url?: unknown } } | undefined>;
        inputResponses?: Record<string, { action?: string }>;
        requestState: <T>() => T | undefined;
      };
      const state = req.requestState<{ requestId: string; asked: number }>();
      const answer = req.inputResponses?.approve;
      console.log("SPIKE_STEPUP " + JSON.stringify({ state, answer, caps: req.envelope?.["io.modelcontextprotocol/clientCapabilities"] ?? null }));
      if (answer && answer.action !== "accept") {
        const out = { status: "elevation_declined", action: answer.action };
        return { isError: true, content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
      }
      const pending = await env.CONSOLE.requestElevation(who, "api_key_create");
      const declaresUrl = req.envelope?.["io.modelcontextprotocol/clientCapabilities"]?.elicitation?.url !== undefined;
      if (carrier === "structured" || !declaresUrl || state) {
        // Second round without an elevation, or a client that cannot be elicited: the structured result.
        return approvalResult("api_key_create", pending.url, pending.expiresAt);
      }
      return inputRequired({
        inputRequests: {
          approve: inputRequired.elicitUrl({
            url: pending.url,
            message: "Approve sensitive actions for this agent in the Eccos console.",
          }),
        },
        requestState: await codec.mint({ requestId: pending.requestId, asked: Date.now() }, ctx),
      });
    },
  );

  // Does a success-only outputSchema collide with an isError approval result?
  server.registerTool(
    "strict_stepup",
    {
      description: "Step-up tool with a success-only outputSchema (spike).",
      inputSchema: z.object({}),
      outputSchema: z.object({ status: z.literal("claim_ready"), label: z.string() }),
    },
    async () => approvalResult("strict_stepup", "http://localhost:3000/spike/approve?request=demo", Date.now() + 600_000) as never,
  );
  server.registerTool(
    "union_stepup",
    {
      description: "Step-up tool whose outputSchema includes the approval shape (spike).",
      inputSchema: z.object({}),
      outputSchema: z.union([
        z.object({ status: z.literal("claim_ready"), label: z.string() }),
        z.object({ status: z.literal("approval_required"), reason: z.string(), message: z.string(), approvalUrl: z.string(), expiresAt: z.string(), retry: z.object({ tool: z.string(), when: z.string(), sameArguments: z.boolean() }) }),
      ]) as never,
    },
    async () => approvalResult("union_stepup", "http://localhost:3000/spike/approve?request=demo", Date.now() + 600_000) as never,
  );

  server.registerTool(
    "gateway_probe",
    { description: "Calls GatewayRPC over the service binding with the resolved accountId (spike).", inputSchema: z.object({}) },
    async () => {
      const who = actor();
      if (!who) throw new Error("no actor");
      const resources = await env.GATEWAY.listAccountResources(who.accountId);
      const out = { accountId: who.accountId, resources };
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out as never };
    },
  );
  return server;
}

const mcp = (env: Env) =>
  createMcpHandler(() => createServer(env), {
    route: "/mcp",
    legacy: "stateless",
  });

// Finding: resourceMetadata is validated at construction, so with the resource in a var the
// host is built on first request (or the value is read from `cloudflare:workers` env at module scope).
let cached: OAuthResourceServer<Env, { actor: Actor }> | undefined;
const resourceServer = (bindings: Env) => (cached ??= new OAuthResourceServer<Env, { actor: Actor }>({
  resourceMetadata: { resource: bindings.MCP_RESOURCE, authorization_servers: [bindings.ISSUER] },
  requiredScopes: ["eccos:view"],
  validateToken: (env: Env) => async (resource: string, token: string) => {
    const result = await env.CONSOLE.authorize(resource, token);
    console.log("SPIKE_VALIDATE " + JSON.stringify(result.ok ? { ok: true, actor: result.actor, scope: result.scope } : result));
    if (!result.ok) return null;
    return {
      props: { actor: result.actor },
      audience: result.audience,
      expiresAt: result.expiresAt,
      scope: result.scope,
      userId: result.actor.userId,
      clientId: result.clientId,
    };
  },
  handler: {
    async fetch(request: Request, env: Env, ctx: ExecutionContext & { auth: { scope: string[] } }) {
      if (request.headers.get("x-spike-need-scope") && !ctx.auth.scope.includes("eccos:administer")) {
        return insufficientScope(ctx.auth as never, ["eccos:administer"]);
      }
      return mcp(env)(request, env, ctx);
    },
  },
} as never));

const app = new Hono<{ Bindings: Env }>();
app.post("/spike/compare-verify", async (c) => {
  const { token, resource } = await c.req.json<{ token: string; resource?: string }>();
  return c.json(await (c.env.CONSOLE as unknown as { compareVerify(r: string, t: string): Promise<unknown> }).compareVerify(resource ?? c.env.MCP_RESOURCE, token));
});
app.get("/healthz", async (c) => c.json({ ok: true, console: await c.env.CONSOLE.ping() }));
app.all("*", (c) => resourceServer(c.env).fetch(c.req.raw, c.env, c.executionCtx as never));

export default app;
