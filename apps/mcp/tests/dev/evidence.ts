/**
 * Drives `wrangler dev` for apps/mcp (port 8788) with the MCP SDK client, against the stub console
 * (tests/dev/wrangler.console.jsonc, port 8790) and the real local gateway (port 8787). Writes
 * transcripts without tokens to the directory named by EVIDENCE_DIR.
 *
 *   bun run dev:gateway &
 *   (cd apps/mcp && wrangler dev -c tests/dev/wrangler.console.jsonc --inspector-port 9241) &
 *   (cd apps/mcp && wrangler dev) &
 *   EVIDENCE_DIR=… bun apps/mcp/tests/dev/evidence.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport, discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/client";

const MCP = "http://localhost:8788";
const CONSOLE = "http://localhost:8790";
const DIR = process.env.EVIDENCE_DIR ?? "evidence";
mkdirSync(DIR, { recursive: true });

const control = async (method: string, ...args: unknown[]) =>
  (await fetch(`${CONSOLE}/control/${method}`, { method: "POST", body: JSON.stringify(args) })).json();

const token = `eyJhbGciOiJFZERTQSJ9.${btoa(JSON.stringify({ evidence: Date.now() })).replace(/=+$/, "")}.ZXZpZGVuY2U`;
const redact = (text: string) => text.replaceAll(token, "<token>");
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
