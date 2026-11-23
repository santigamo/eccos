import type {
  Actor,
  ActorRef,
  AgentAction,
  ConsoleApi,
  ElevationRequest,
  ElevationResult,
  GrantRefusalCode,
} from "@eccos/console-contract";
import type { GatewayApi } from "@eccos/gateway-contract";
import { type McpServer, type ServerContext, type ToolAnnotations, inputRequired, inputResponse } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type AuditResource, auditEvent } from "../audit";

/** The actor `authorize` returned for this request, plus the scopes the token carries. */
export type McpActor = Actor & { scope: string[] };

/** Everything a tool may call. Tools never see the token. */
export interface ToolDeps {
  gateway: GatewayApi;
  console: ConsoleApi;
  /** The console's public origin, where the pages a person opens live (`/connect`). */
  consoleOrigin: string;
}

/** A failure the agent can act on; its message is the whole error result, so say what to do next. */
export class ToolError extends Error {}

/**
 * One tool, as data. `createServer` registers it only when `action` is among the actor's
 * actions; `stepUp` puts it behind a live elevation (design § 3.3); a tool without
 * `readOnlyHint` is mutating and writes one audit line per call.
 */
export interface ToolDefinition<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  name: string;
  action: AgentAction;
  stepUp: boolean;
  title: string;
  description: string;
  inputSchema: I;
  /** The success shape. A step-up tool advertises its union with the approval shapes. */
  outputSchema: O;
  annotations: ToolAnnotations;
  /** The identifiers a mutating call's audit line carries. Never inputs that are content or secrets. */
  audit?(input: z.output<I>): AuditResource;
  run(input: z.output<I>, actor: McpActor, deps: ToolDeps): Promise<z.input<O>>;
}

export const defineTool = <I extends z.ZodObject, O extends z.ZodObject>(tool: ToolDefinition<I, O>) => tool;

const ELEVATION_INPUT = "elevation";

const approvalRequired = z.object({
  status: z.literal("approval_required"),
  reason: z.literal("elevation_required"),
  message: z.string(),
  approvalUrl: z.string(),
  expiresAt: z.string(),
  retry: z.object({ tool: z.string(), when: z.literal("after_approval"), sameArguments: z.literal(true) }),
});

const elevationDeclined = z.object({
  status: z.literal("elevation_declined"),
  action: z.enum(["decline", "cancel"]),
  message: z.string(),
});

export const isElevated = (actor: Pick<Actor, "elevatedUntil">) =>
  actor.elevatedUntil !== null && actor.elevatedUntil > Date.now();

export const actorRef = ({ userId, organizationId, accountId, clientId }: Actor): ActorRef => ({
  userId,
  organizationId,
  accountId,
  clientId,
});

const structured = (value: Record<string, unknown>, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
  ...(isError ? { isError } : {}),
});

const errorText = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/** Why a grant no longer stands (any console call can answer it), said so the agent knows what to do. */
export const GRANT_REFUSED: Record<GrantRefusalCode, string> = {
  revoked: "This agent's connection to Eccos was revoked. Ask the person to connect the agent again.",
  not_a_member: "The person this agent acts for is no longer a member of the workspace. Ask them to connect the agent again from a workspace they belong to.",
  no_account: "This workspace has no active Eccos account. Ask the person to check the workspace in the Eccos console.",
};

/** Why the console would not open an approval request, said so the agent knows what to do. */
const ELEVATION_REFUSED: Record<Extract<ElevationResult, { ok: false }>["code"], string> = {
  forbidden:
    "Only an owner or admin of this workspace can approve sensitive actions, and the person this agent acts for is neither. Ask an owner or admin to do this in the Eccos console.",
  ...GRANT_REFUSED,
};

function approvalResult(tool: string, request: ElevationRequest) {
  return structured(
    {
      status: "approval_required",
      reason: "elevation_required",
      message: `A person must approve sensitive actions for this agent. Ask them to open the link, then call ${tool} again with the same arguments.`,
      approvalUrl: request.url,
      expiresAt: new Date(request.expiresAt).toISOString(),
      retry: { tool, when: "after_approval", sameArguments: true },
    } satisfies z.input<typeof approvalRequired>,
    true,
  );
}

function declinedResult(tool: string, action: "decline" | "cancel") {
  return structured(
    {
      status: "elevation_declined",
      action,
      message: `The person declined to approve sensitive actions for this agent. Do not retry ${tool} unless they ask you to; calling it again asks for approval again.`,
    } satisfies z.input<typeof elevationDeclined>,
    true,
  );
}

/** Client capabilities arrive per request on 2026-07-28; 2025-era requests carry none. */
function declaresUrlElicitation(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as
    | Record<string, { elicitation?: { url?: unknown } } | undefined>
    | undefined;
  return envelope?.["io.modelcontextprotocol/clientCapabilities"]?.elicitation?.url !== undefined;
}

type Outcome = {
  result: ReturnType<typeof structured> | ReturnType<typeof errorText> | ReturnType<typeof inputRequired>;
  audit?: { outcome: "success" | "denied" | "failed"; detail: string | null };
};

/**
 * The step-up guard (design § 3.3). Elevation is read only from this request's actor. Without
 * it, a client that declares URL elicitation is sent to the approval page once; its retry
 * carries the person's answer in `inputResponses`, so no request state is needed: a decline
 * ends the call, an accept without an approval falls through to the structured result that
 * every other client gets.
 */
async function guard(tool: ToolDefinition, actor: McpActor, deps: ToolDeps, ctx: ServerContext): Promise<Outcome | null> {
  if (!tool.stepUp || isElevated(actor)) return null;
  const answer = inputResponse(ctx.mcpReq.inputResponses, ELEVATION_INPUT);
  if (answer.kind === "elicit" && answer.action !== "accept") {
    return { result: declinedResult(tool.name, answer.action), audit: { outcome: "denied", detail: "elevation_declined" } };
  }
  const elevation = await deps.console.requestElevation(actorRef(actor), tool.name);
  if (!elevation.ok) {
    return { result: errorText(ELEVATION_REFUSED[elevation.code]), audit: { outcome: "denied", detail: elevation.code } };
  }
  const { request } = elevation;
  if (answer.kind === "missing" && declaresUrlElicitation(ctx)) {
    return {
      result: inputRequired({
        inputRequests: {
          [ELEVATION_INPUT]: inputRequired.elicitUrl({
            url: request.url,
            message: "Approve sensitive actions for this agent in the Eccos console, then come back here.",
          }),
        },
      }),
    };
  }
  return { result: approvalResult(tool.name, request), audit: { outcome: "denied", detail: "elevation_required" } };
}

async function invoke(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  actor: McpActor,
  deps: ToolDeps,
  ctx: ServerContext,
): Promise<Outcome> {
  const guarded = await guard(tool, actor, deps, ctx);
  if (guarded) return guarded;
  try {
    const value = await tool.run(input, actor, deps);
    return { result: structured(value), audit: { outcome: "success", detail: null } };
  } catch (error) {
    if (error instanceof ToolError) return { result: errorText(error.message), audit: { outcome: "failed", detail: null } };
    console.error(JSON.stringify({ level: "error", area: "mcp", tool: tool.name, error: String(error) }));
    return {
      result: errorText(`Eccos could not complete ${tool.name}. Try again in a minute; if it keeps failing, tell the person.`),
      audit: { outcome: "failed", detail: null },
    };
  }
}

export function registerTool(server: McpServer, tool: ToolDefinition, actor: McpActor, deps: ToolDeps): void {
  const outputSchema = tool.stepUp ? z.union([tool.outputSchema, approvalRequired, elevationDeclined]) : tool.outputSchema;
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema,
      annotations: tool.annotations,
    },
    async (input: Record<string, unknown>, ctx: ServerContext) => {
      const { result, audit } = await invoke(tool, input, actor, deps, ctx);
      if (audit && tool.annotations.readOnlyHint !== true) {
        auditEvent({
          action: tool.name,
          actorUserId: actor.userId,
          organizationId: actor.organizationId,
          accountId: actor.accountId,
          clientId: actor.clientId,
          resource: tool.audit?.(input) ?? null,
          ...audit,
        });
      }
      return result as never;
    },
  );
}
