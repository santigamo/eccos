import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Actor, ActorRef, AgentAction, AuthorizeResult, BillingResult, ElevationResult } from "@eccos/console-contract";
import type { AccountWabaResource } from "@eccos/gateway-contract";
import app from "../../src/index";
import type { AccountFixture, GatewayCall } from "../stubs/gateway";

export const RESOURCE = "https://mcp.example.test/mcp";
export const METADATA_URL = "https://mcp.example.test/.well-known/oauth-protected-resource/mcp";
export const ALL_SCOPES = ["eccos:view", "eccos:operate", "eccos:send", "eccos:configure", "eccos:administer", "offline_access"];

interface ConsoleControls {
  reset(): Promise<void>;
  grant(token: string, result: AuthorizeResult): Promise<void>;
  revoke(token: string): Promise<void>;
  approve(actor: Pick<ActorRef, "userId" | "clientId" | "organizationId">, until: number): Promise<void>;
  setBilling(accountId: string, billing: BillingResult): Promise<void>;
  refuseElevation(refusal: ElevationResult | null): Promise<void>;
  authorizeCalls(): Promise<{ resource: string; token: string }[]>;
  elevationCalls(): Promise<{ actor: ActorRef; tool: string }[]>;
}

interface GatewayControls {
  reset(): Promise<void>;
  seed(accountId: string, fixture: AccountFixture): Promise<void>;
  calls(): Promise<GatewayCall[]>;
}

export const consoleStub = (env as unknown as { CONSOLE: ConsoleControls }).CONSOLE;
export const gatewayStub = (env as unknown as { GATEWAY: GatewayControls }).GATEWAY;

export async function resetStubs(): Promise<void> {
  await Promise.all([consoleStub.reset(), gatewayStub.reset()]);
}

let sequence = 0;
const segment = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** A JWT-shaped opaque token. Only the stub console gives it a meaning. */
export function newToken(): string {
  sequence += 1;
  return `${segment({ alg: "EdDSA", typ: "at+jwt" })}.${segment({ n: sequence })}.c2lnbmF0dXJl${sequence}`;
}

export function makeActor(overrides: Partial<Actor> = {}): Actor {
  sequence += 1;
  return {
    userId: `user-${sequence}`,
    organizationId: "org-a",
    accountId: "acct-a",
    role: "owner",
    actions: ["view", "operate", "send", "configure", "administer"] satisfies AgentAction[],
    elevatedUntil: null,
    clientId: "client-1",
    ...overrides,
  };
}

/** Register a token for `actor` with the stub console and return it. */
export async function grantToken(actor: Actor, scope: string[] = ALL_SCOPES): Promise<string> {
  const token = newToken();
  await consoleStub.grant(token, {
    ok: true,
    actor,
    audience: RESOURCE,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    scope,
  });
  return token;
}

type FetchApp = { fetch(request: Request, env: unknown, ctx: ExecutionContext): Response | Promise<Response> };

/** `fetch` into an app instance, in this isolate, with the test Worker's bindings. */
export function fetcher(target: FetchApp = app) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    // An incoming request carries Host; one built in a test does not.
    request.headers.set("host", new URL(request.url).host);
    const ctx = createExecutionContext();
    const response = await target.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
}

/** A raw JSON-RPC POST to /mcp, as a 2026-07-28 client sends it. */
export function postMcp(
  body: unknown,
  { token, headers = {}, target = app }: { token?: string; headers?: Record<string, string>; target?: FetchApp } = {},
): Promise<Response> {
  return fetcher(target)(RESOURCE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      ...mcpHeaders(body),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** The 2026-07-28 transport repeats the method (and a tool's name) in headers. */
function mcpHeaders(body: unknown): Record<string, string> {
  const { method, params } = body as { method?: string; params?: { name?: string } };
  return {
    ...(method ? { "mcp-method": method } : {}),
    ...(method === "tools/call" && params?.name ? { "mcp-name": params.name } : {}),
  };
}

export const toolsList = (id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/list",
  params: { _meta: envelope() },
});

export const toolsCall = (name: string, args: Record<string, unknown> = {}, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args, _meta: envelope() },
});

const envelope = () => ({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "raw-test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
});

export type Mode = "legacy" | { pin: string };

/** An MCP SDK client connected to an app instance with `token`. */
export async function connect(
  token: string,
  {
    target = app,
    mode = { pin: "2026-07-28" },
    capabilities = {},
    onElicit,
  }: {
    target?: FetchApp;
    mode?: Mode;
    capabilities?: Record<string, unknown>;
    onElicit?: (params: Record<string, unknown>) => Promise<{ action: "accept" | "decline" | "cancel" }>;
  } = {},
): Promise<Client> {
  const client = new Client({ name: "eccos-mcp-test", version: "0" }, { capabilities, versionNegotiation: { mode } });
  if (onElicit) {
    client.setRequestHandler("elicitation/create", (request) => onElicit(request.params as Record<string, unknown>));
  }
  await client.connect(
    new StreamableHTTPClientTransport(new URL(RESOURCE), {
      authProvider: { token: async () => token },
      fetch: fetcher(target),
    } as never),
  );
  return client;
}

export function activeWaba(wabaId: string, accountId: string, phoneNumberIds: string[]): AccountWabaResource {
  return {
    accountId,
    wabaId,
    callbackUrl: null,
    createdAt: 1,
    provisionedAt: 2,
    status: "active",
    provisioningError: null,
    tokenExpiresAt: 0,
    phones: phoneNumberIds.map((phoneNumberId) => ({ phoneNumberId, displayPhoneNumber: `+34 600 ${phoneNumberId}` })),
    coexistence: {
      onboardingType: "standard",
      verifiedOnboardingType: null,
      status: "not_applicable",
      deadlineAt: null,
      contactsStartedAt: null,
      contactsRequestId: null,
      historyStartedAt: null,
      historyRequestId: null,
      error: null,
    },
  };
}
