/**
 * Drives `wrangler dev` for apps/mcp (port 8788) with the MCP SDK client, against the stub console
 * (tests/dev/wrangler.console.jsonc, port 8791) and the real local gateway (port 8787). Writes
 * transcripts without tokens to the directory named by EVIDENCE_DIR.
 *
 *   bun run dev:gateway &      # or the verify-eccos stack: .agents/skills/verify-eccos/scripts/verify-eccos launch
 *   (cd apps/mcp && wrangler dev -c tests/dev/wrangler.console.jsonc --inspector-port 9241) &
 *   (cd apps/mcp && wrangler dev -c tests/dev/wrangler.mcp.jsonc) &
 *   EVIDENCE_DIR=… bun apps/mcp/tests/dev/evidence.ts
 *
 * With VERIFY_ECCOS=1 (the verify-eccos stack, whose gateway talks to its fake Meta), the setup
 * tools also run against a WABA registered through the gateway's admin route: pending, re-checked
 * to active, then an inbound webhook counted by status_get.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport, discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/client";

const MCP = "http://localhost:8788";
const CONSOLE = "http://localhost:8791";
const GATEWAY = "http://localhost:8787";
const VERIFY_ECCOS = process.env.VERIFY_ECCOS === "1";
const DIR = process.env.EVIDENCE_DIR ?? "evidence";
mkdirSync(DIR, { recursive: true });

const control = async (method: string, ...args: unknown[]) =>
  (await fetch(`${CONSOLE}/control/${method}`, { method: "POST", body: JSON.stringify(args) })).json();

const token = `eyJhbGciOiJFZERTQSJ9.${btoa(JSON.stringify({ evidence: Date.now() })).replace(/=+$/, "")}.ZXZpZGVuY2U`;
const redact = (text: string) =>
  text.replaceAll(token, "<token>").replace(/\/connect#[A-Za-z0-9._~-]+/g, "/connect#<link-token>");
const save = (name: string, data: unknown) => {
  writeFileSync(`${DIR}/${name}`, `${redact(JSON.stringify(data, null, 2))}\n`);
  console.log(`wrote ${DIR}/${name}`);
};
const headersOf = (response: Response) => Object.fromEntries(response.headers);

const { accountId, keyId } = (await control("provision", "org-evidence", "Evidence Co")) as { accountId: string; keyId: string };
const actor = {
  userId: "user-evidence",
  organizationId: "org-evidence",
  accountId,
  role: "owner",
  actions: ["view", "operate", "send", "configure", "administer"],
  elevatedUntil: null,
  clientId: "evidence-client",
};
await control("reset");
await control("grant", token, {
  ok: true,
  actor,
  audience: `${MCP}/mcp`,
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  scope: ["eccos:view", "eccos:operate", "eccos:send", "eccos:configure", "eccos:administer", "offline_access"],
});

// 1. Challenge and discovery.
const noToken = await fetch(`${MCP}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
const unknownToken = await fetch(`${MCP}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer aaa.bbb.ccc" },
  body: "{}",
});
const foreignOrigin = await fetch(`${MCP}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, origin: "https://evil.example" },
  body: "{}",
});
const metadataResponse = await fetch(`${MCP}/.well-known/oauth-protected-resource/mcp`);
save("01-challenge-and-discovery.json", {
  noToken: { status: noToken.status, wwwAuthenticate: noToken.headers.get("www-authenticate") },
  unknownToken: { status: unknownToken.status, wwwAuthenticate: unknownToken.headers.get("www-authenticate") },
  foreignOrigin: { status: foreignOrigin.status, body: await foreignOrigin.text() },
  metadata: { status: metadataResponse.status, headers: headersOf(metadataResponse), body: await metadataResponse.json() },
  sdkDiscovery: await discoverOAuthProtectedResourceMetadata(`${MCP}/mcp`),
});

// 2. The SDK client on each protocol era.
for (const [label, mode] of [
  ["2026-07-28", { pin: "2026-07-28" }],
  ["2025-11-25", "legacy"],
] as const) {
  const wire: unknown[] = [];
  const tracing: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const body = request.method === "POST" ? await request.clone().text() : "";
    const response = await fetch(request);
    const text = await response.clone().text();
    const parse = (s: string) => {
      const data = s.split("\n").find((line) => line.startsWith("data:"));
      try {
        return JSON.parse(data ? data.slice(5) : s);
      } catch {
        return s;
      }
    };
    wire.push({
      request: {
        method: request.method,
        headers: Object.fromEntries([...request.headers].filter(([key]) => key.startsWith("mcp-") || key === "authorization")),
        body: body ? parse(body) : null,
      },
      response: { status: response.status, body: text ? parse(text) : null },
    });
    return response;
  };
  const client = new Client({ name: `eccos-evidence-${label}`, version: "0" }, { capabilities: {}, versionNegotiation: { mode } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${MCP}/mcp`), { authProvider: { token: async () => token }, fetch: tracing } as never),
  );
  const tools = await client.listTools();
  const workspace = await client.callTool({ name: "workspace_get", arguments: {} });
  await client.close();
  save(`02-sdk-${label}.json`, {
    negotiatedProtocolVersion: (client as unknown as { getNegotiatedProtocolVersion?: () => string }).getNegotiatedProtocolVersion?.(),
    tools: tools.tools.map(({ name, annotations }) => ({ name, annotations })),
    workspaceGet: workspace,
    wire,
  });
}

save("03-console-calls.json", {
  provisionedAccount: { accountId, apiKeyId: keyId },
  authorizeCalls: ((await control("authorizeCalls")) as { resource: string }[]).map(({ resource }) => ({ resource, token: "<token>" })),
});

// 4. The setup tools (task 1.7) against the real gateway's data.
const transcript: { tool: string; arguments: Record<string, unknown>; isError: boolean; result: unknown }[] = [];
const setup = new Client({ name: "eccos-evidence-setup", version: "0" }, { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } });
await setup.connect(new StreamableHTTPClientTransport(new URL(`${MCP}/mcp`), { authProvider: { token: async () => token } } as never));
const run = async (tool: string, args: Record<string, unknown> = {}) => {
  const result = await setup.callTool({ name: tool, arguments: args });
  transcript.push({ tool, arguments: args, isError: result.isError === true, result: result.structuredContent ?? result.content });
  return result;
};
const admin = (method: string, path: string, body?: unknown) =>
  fetch(`${GATEWAY}${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.ADMIN_KEY ?? "verify-admin-key"}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
const registerWaba = (account: string, wabaId: string, phoneNumberId: string) =>
  admin("POST", `/v1/accounts/${account}/wabas`, {
    wabaId,
    metaAccessToken: "fake-token",
    callbackUrl: "https://gateway.eccos-verify.example/webhooks/meta",
    phones: [{ phoneNumberId, displayPhoneNumber: "+34600000001" }],
  });

await run("numbers_list");
await run("connect_status");
await run("connect_link_create");
await control("approve", actor, Date.now() + 86_400_000);
await run("connect_link_create");
await run("connect_status");
await run("connect_link_create");
await run("connect_link_create", { replace: true });
await run("billing_get");
await control("setBilling", accountId, {
  ok: true,
  billing: { connectPolicy: "closed", numbers: 0, monthlyEuros: 0, hasCustomer: false, explicitPolicy: false },
});
await control("setBillingLink", accountId, "startCheckout", { ok: true, kind: "checkout", url: "https://creem.example/checkout/stub" });
await run("billing_get");
await run("billing_checkout_link");
await run("billing_checkout_link", { purpose: "manage" });

const gatewaySide: Record<string, unknown> = {};
if (VERIFY_ECCOS) {
  gatewaySide.registerWaba = (await registerWaba(accountId, "100200300", "555001")).status;
  await run("numbers_list");
  await run("status_get");
  await run("number_recheck");
  await run("numbers_list");
  await run("number_recheck");
  gatewaySide.webhook = execFileSync(".agents/skills/verify-eccos/scripts/verify-eccos", ["webhook", ".agents/skills/verify-eccos/fixtures/inbound-text.json"])
    .toString()
    .trim();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await run("status_get");

  // Two accounts: B owns a WABA; an actor of A names it.
  const other = (await control("provision", "org-evidence-b", "Other Co")) as { accountId: string };
  gatewaySide.otherAccountWaba = (await registerWaba(other.accountId, "700800900", "777001")).status;
  await run("status_get", { wabaId: "700800900" });
  await run("number_recheck", { wabaId: "700800900" });
  gatewaySide.otherAccountId = other.accountId;
}
await setup.close();
save("04-setup-tools.json", {
  note: "Billing answers come from the stub ConsoleRPC (task 1.5 has not landed); every other tool reads the running gateway.",
  gateway: VERIFY_ECCOS ? "verify-eccos stack (fake Meta)" : "dev:gateway",
  gatewaySide,
  transcript,
});
