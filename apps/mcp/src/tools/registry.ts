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
import {
  type McpServer,
  type RequestStateCodec,
  type ServerContext,
  type ToolAnnotations,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { type AuditResource, auditEvent } from "../audit";
import { CONSOLE_METHODS, type ClientsFor, GATEWAY_METHODS, type OneAction, LEAST_ROLE, forbiddenMessage, methodsFor } from "../permissions";

/** The actor `authorize` returned for this request, plus the scopes the token carries. */
export type McpActor = Actor & { scope: string[] };

/** The private bindings a tool calls through. Tools never see the token. */
export interface Clients {
  gateway: GatewayApi;
  console: ConsoleApi;
}

/**
 * What a tool may call, gated by the actor's actions (live role ∩ granted scopes). A tool asks
 * for the clients of the action each call needs, so no call reaches the console or the gateway
 * on an action the caller does not hold: the console cannot tell, because an `ActorRef` carries
 * no scope.
 */
export interface ToolDeps {
  /**
   * The gateway and console methods bound to `action` (permissions.ts), and nothing else;
   * throws a {@link ForbiddenError} when the actor lacks it.
   */
  for<A extends AgentAction>(action: A & OneAction<A>): ClientsFor<A>;
  can(action: AgentAction): boolean;
  /** The console's public origin, where the pages a person opens live (`/connect`). Not a client, so not gated. */
  consoleOrigin: string;
}

/** A failure the agent can act on; its message is the whole error result, so say what to do next. */
export class ToolError extends Error {}

/** The caller lacks the action a call needs. */
export class ForbiddenError extends ToolError {
  constructor(
    readonly action: AgentAction,
    actor: Pick<Actor, "role">,
  ) {
    super(forbiddenMessage(action, actor));
  }
}

export function capabilities(actor: Pick<Actor, "actions" | "role">, clients: Clients): Omit<ToolDeps, "consoleOrigin"> {
  const can = (action: AgentAction) => Object.hasOwn(LEAST_ROLE, action) && actor.actions.includes(action);
  const forAction = (action: AgentAction) => {
    if (!can(action)) throw new ForbiddenError(action, actor);
    return {
      gateway: methodsFor(clients.gateway, GATEWAY_METHODS, action),
      console: methodsFor(clients.console, CONSOLE_METHODS, action),
    };
  };
  return { can, for: forAction as unknown as ToolDeps["for"] };
}

/** What the step-up guard needs besides the tool's own clients. */
export interface StepUp {
  codec: ElevationStateCodec | null;
  console: Pick<ConsoleApi, "requestElevation">;
}

/** What the step-up guard seals into `requestState` when it sends a client to the approval page. */
export interface ElevationState {
  requestId: string;
  tool: string;
}

export type ElevationStateCodec = RequestStateCodec<ElevationState>;

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
  /**
   * Other actions the tool's calls need besides `action`. Defaults to `["view"]`, because
   * resolving the account's WABAs (`listAccountResources`) is view; a tool that reads nothing at
   * view says `[]`.
   */
  reads?: AgentAction[];
  /** The identifiers a mutating call's audit line carries. Never inputs that are content or secrets. */
  audit?(input: z.output<I>): AuditResource;
  run(input: z.output<I>, actor: McpActor, deps: ToolDeps): Promise<z.input<O>>;
}

export const defineTool = <I extends z.ZodObject, O extends z.ZodObject>(tool: ToolDefinition<I, O>) => tool;

/** Every action a tool's calls need: its own, then its reads. */
export const toolActions = (tool: Pick<ToolDefinition, "action" | "reads">): AgentAction[] => [
  ...new Set([tool.action, ...(tool.reads ?? ["view"])]),
];

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

/** A sealed state the SDK accepted, but for another tool or a request that is no longer pending. */
const STALE_STATE = (tool: string) =>
  `This approval prompt does not match a pending approval request for ${tool}. Call ${tool} again with the same arguments to get a current approval link.`;

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
  const message =
    action === "decline"
      ? `The person declined to approve sensitive actions for this agent. Do not retry ${tool} unless they ask you to; calling it again asks for approval again.`
      : `The person closed the approval prompt without answering. Call ${tool} again with the same arguments when they are ready to approve.`;
  return structured({ status: "elevation_declined", action, message } satisfies z.input<typeof elevationDeclined>, true);
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

const denied = (result: Outcome["result"], detail: string): Outcome => ({ result, audit: { outcome: "denied", detail } });

/**
 * The step-up guard (design § 3.3). Elevation is read only from this request's actor. Without
 * it, a client that declares URL elicitation is sent to the approval page once, with the request
 * id and the tool sealed into `requestState`; the SDK refuses a forged or expired state before
 * this runs. The retry must carry a state for this tool and for the request still pending;
 * then a decline or cancel ends the call, and an accept without an approval falls through to
 * the structured result every other client gets. Without a sealing key there is no URL
 * elicitation at all: the structured result works for every client.
 */
async function guard(
  tool: ToolDefinition,
  actor: McpActor,
  deps: ToolDeps,
  ctx: ServerContext,
  step: StepUp,
): Promise<Outcome | null> {
  if (!tool.stepUp || isElevated(actor)) return null;
  if (!deps.can(tool.action)) throw new ForbiddenError(tool.action, actor);
  const { codec } = step;
  const answer = inputResponse(ctx.mcpReq.inputResponses, ELEVATION_INPUT);
  const state = codec ? ctx.mcpReq.requestState<ElevationState>() : undefined;
  const retry = codec !== null && (answer.kind !== "missing" || state !== undefined);
  if (retry && state?.tool !== tool.name) return denied(errorText(STALE_STATE(tool.name)), "request_state_mismatch");

  const elevation = await step.console.requestElevation(actorRef(actor), tool.name);
  if (!elevation.ok) return denied(errorText(ELEVATION_REFUSED[elevation.code]), elevation.code);
  const { request } = elevation;

  if (retry) {
    if (state?.requestId !== request.requestId) return denied(errorText(STALE_STATE(tool.name)), "request_state_mismatch");
    if (answer.kind === "elicit" && answer.action !== "accept") {
      return denied(declinedResult(tool.name, answer.action), answer.action === "decline" ? "elevation_declined" : "elevation_cancelled");
    }
  } else if (declaresUrlElicitation(ctx)) {
    if (codec) {
      return {
        result: inputRequired({
          inputRequests: {
            [ELEVATION_INPUT]: inputRequired.elicitUrl({
              url: request.url,
              message: "Approve sensitive actions for this agent in the Eccos console, then come back here.",
            }),
          },
          requestState: await codec.mint({ requestId: request.requestId, tool: tool.name }, ctx),
        }),
      };
    }
    console.warn(
      JSON.stringify({ level: "warn", area: "mcp", event: "url_elicitation_unavailable", tool: tool.name, reason: "REQUEST_STATE_KEY is unset or shorter than 32 bytes" }),
    );
  }
  return denied(approvalResult(tool.name, request), "elevation_required");
}

async function invoke(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  actor: McpActor,
  deps: ToolDeps,
  ctx: ServerContext,
  step: StepUp,
): Promise<Outcome> {
  try {
    const guarded = await guard(tool, actor, deps, ctx, step);
    if (guarded) return guarded;
    const value = await tool.run(input, actor, deps);
    return { result: structured(value), audit: { outcome: "success", detail: null } };
  } catch (error) {
    if (error instanceof ForbiddenError) return denied(errorText(error.message), "forbidden");
    if (error instanceof ToolError) return { result: errorText(error.message), audit: { outcome: "failed", detail: null } };
    logFailure("tool_failure", tool.name, error);
    return {
      result: errorText(`Eccos could not complete ${tool.name}. Try again in a minute; if it keeps failing, tell the person.`),
      audit: { outcome: "failed", detail: null },
    };
  }
}

/**
 * One line for a failure of the console, the gateway or a tool. The error's name only: its
 * message can carry anything the failing side put in it, a token included.
 */
export function logFailure(event: string, tool: string | null, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  console.error(JSON.stringify({ level: "error", area: "mcp", event, tool, error: name }));
}

export function registerTool(
  server: McpServer,
  tool: ToolDefinition,
  actor: McpActor,
  deps: ToolDeps,
  step: StepUp,
): void {
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
      const { result, audit } = await invoke(tool, input, actor, deps, ctx, step);
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
