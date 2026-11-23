import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Actor, ActorRef, AgentAction, AuthorizeResult, BillingLink, BillingResult, ElevationResult } from "@eccos/console-contract";
import type { AccountResources, AccountWabaResource } from "@eccos/gateway-contract";
import { expect } from "vitest";
import app from "../../src/index";
import type { AccountFixture, ConnectLinkIssue, GatewayCall } from "../stubs/gateway";

export const RESOURCE = "https://mcp.example.test/mcp";
export const METADATA_URL = "https://mcp.example.test/.well-known/oauth-protected-resource/mcp";
export const ALL_SCOPES = ["eccos:view", "eccos:operate", "eccos:send", "eccos:configure", "eccos:administer", "offline_access"];

interface ConsoleControls {
  reset(): Promise<void>;
  grant(token: string, result: AuthorizeResult): Promise<void>;
  revoke(token: string): Promise<void>;
  approve(actor: Pick<ActorRef, "userId" | "clientId" | "organizationId">, until: number): Promise<void>;
  setBilling(accountId: string, billing: BillingResult): Promise<void>;
  setBillingLink(accountId: string, method: "startCheckout" | "openBillingPortal", link: BillingLink): Promise<void>;
  billingLinkCalls(): Promise<{ method: string; actor: ActorRef }[]>;
  refuseElevation(refusal: ElevationResult | null): Promise<void>;
  failAuthorize(message: string | null): Promise<void>;
  billingCalls(): Promise<ActorRef[]>;
  authorizeCalls(): Promise<{ resource: string; token: string }[]>;
  elevationCalls(): Promise<{ actor: ActorRef; tool: string }[]>;
}

interface GatewayControls {
  reset(): Promise<void>;
  seed(accountId: string, fixture: AccountFixture): Promise<void>;
  fail(method: string, message: string): Promise<void>;
  calls(): Promise<GatewayCall[]>;
  connectLinkIssues(): Promise<ConnectLinkIssue[]>;
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

/** `fetch` into an app instance, in this isolate, with the test Worker's bindings (or `bindings`). */
export function fetcher(target: FetchApp = app, bindings: object = env) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    // An incoming request carries Host; one built in a test does not.
    request.headers.set("host", new URL(request.url).host);
    const ctx = createExecutionContext();
    const response = await target.fetch(request, bindings, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
}

/** A raw JSON-RPC POST to /mcp, as a 2026-07-28 client sends it. */
export function postMcp(
  body: unknown,
  {
    token,
    headers = {},
    target = app,
    raw,
  }: { token?: string; headers?: Record<string, string>; target?: FetchApp; raw?: BodyInit } = {},
): Promise<Response> {
  return fetcher(target)(RESOURCE, {
    method: "POST",
    ...(raw instanceof ReadableStream ? { duplex: "half" } : {}),
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      ...mcpHeaders(body),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? JSON.stringify(body),
  } as RequestInit);
}

/** The 2026-07-28 transport repeats the method (and a tool's name) in headers. */
function mcpHeaders(body: unknown): Record<string, string> {
  const { method, params } = (body ?? {}) as { method?: string; params?: { name?: string } };
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

export const envelope = () => ({
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
    bindings = env,
    mode = { pin: "2026-07-28" },
    capabilities = {},
    onElicit,
  }: {
    target?: FetchApp;
    bindings?: object;
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
      fetch: fetcher(target, bindings),
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

export function accountResources(accountId: string, wabas: AccountWabaResource[] = []): AccountResources {
  return {
    account: { accountId, name: "Acme", createdAt: 1, connectPolicy: "open" },
    keys: [],
    wabas,
    phones: wabas.flatMap((waba) => waba.phones.map((phone) => ({ ...phone, wabaId: waba.wabaId }))),
  };
}

export function wabaIn(status: AccountWabaResource["status"], wabaId: string, accountId: string, phoneNumberIds: string[] = []): AccountWabaResource {
  return { ...activeWaba(wabaId, accountId, phoneNumberIds), status, provisionedAt: status === "active" ? 2 : null };
}

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

/** Call a tool; a structured result's text block must carry the same JSON. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  if (result.structuredContent !== undefined) {
    const [block] = result.content as { type: string; text: string }[];
    expect(JSON.parse(block?.text ?? "null")).toEqual(result.structuredContent);
  }
  return result;
}

/** The text of an error result that carries no structured content. */
export function errorOf(result: CallResult): string {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  return (result.content as { text: string }[])[0]?.text ?? "";
}

export async function listedTools(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}
