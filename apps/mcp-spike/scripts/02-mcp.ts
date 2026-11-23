// Bullets: OAuthResourceServer + createMcpHandler inside Hono, the actor reaching tools;
// inputRequired.elicitUrl round trip with requestState; isError + structuredContent on the wire;
// revocation on the next request. Driven with @modelcontextprotocol/client 2.4.0.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { $ } from "bun";
import { Browser, MCP, redact, save } from "./lib";

const session = await Bun.file(new URL("../evidence/.session.json", import.meta.url).pathname).json();
const token: string = session.tokens.access_token;
const person = new Browser();
for (const [k, v] of session.jar) person.jar.set(k, v);

const wire: unknown[] = [];
const tracingFetch: typeof fetch = async (input, init) => {
  const req = new Request(input as RequestInfo, init);
  const body = req.method === "POST" ? await req.clone().text() : "";
  const res = await fetch(req);
  const text = await res.clone().text();
  const headers = Object.fromEntries([...req.headers].filter(([k]) => k.startsWith("mcp-") || k === "authorization").map(([k, v]) => [k, k === "authorization" ? "Bearer <jwt>" : v]));
  wire.push({ request: { headers, body: safe(body) }, response: { status: res.status, wwwAuthenticate: res.headers.get("www-authenticate") ?? undefined, body: safe(text) } });
  return res;
};
const safe = (s: string) => { try { return JSON.parse(s.startsWith("event:") || s.startsWith("data:") ? s.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : s); } catch { return s.slice(0, 400); } };

type Mode = "legacy" | { pin: string };
async function connect(mode: Mode, capabilities: Record<string, unknown>, onElicit?: (params: Record<string, unknown>) => Promise<{ action: string }>) {
  const client = new Client({ name: "spike-sdk-client", version: "0" }, { capabilities, versionNegotiation: { mode } } as never);
  const seen: unknown[] = [];
  if (onElicit) {
    client.setRequestHandler("elicitation/create" as never, (async (request: { params: Record<string, unknown> }) => {
      seen.push(request.params);
      return onElicit(request.params);
    }) as never);
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP + "/mcp"), { authProvider: { token: async () => token }, fetch: tracingFetch } as never));
  return { client, seen };
}
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  try { return await client.callTool({ name, arguments: args }); } catch (e) { return { thrown: String(e), data: (e as { data?: unknown }).data }; }
};
const approve = async (url: string) => {
  const page = await person.fetch(url);
  const post = await person.fetch(url, { method: "POST" });
  return { pageStatus: page.status, approveStatus: post.status };
};

const out: Record<string, unknown> = {};

// A. Modern (2026-07-28) client, no elicitation capability.
{
  const { client } = await connect({ pin: "2026-07-28" }, {});
  out.A_tools = (await client.listTools()).tools.map((t) => t.name);
  out.A_whoami = await call(client, "whoami");
  out.A_gateway = await call(client, "gateway_probe");
  out.A_stepup_structured = await call(client, "api_key_create", { label: "ci" });
  await client.close();
}
// B. Declares elicitation.url; the person declines.
{
  const { client, seen } = await connect({ pin: "2026-07-28" }, { elicitation: { url: {} } }, async () => ({ action: "decline" }));
  out.B_decline = { result: await call(client, "api_key_create", { label: "ci" }), elicitationSeenByClient: seen };
  await client.close();
}
// C. Declares elicitation.url; the person consents to open the URL but does NOT finish approving.
{
  const mark = wire.length;
  const { client, seen } = await connect({ pin: "2026-07-28" }, { elicitation: { url: {} } }, async () => ({ action: "accept" }));
  out.C_accept_without_approval = { result: await call(client, "api_key_create", { label: "ci" }), elicitationSeenByClient: seen };
  out.C_wire = wire.slice(mark).filter((w) => JSON.stringify(w).includes("api_key_create"));
  await client.close();
}
// D. Declares elicitation.url; the person approves in the console; the SDK retries the call.
{
  const mark = wire.length;
  let approval: unknown;
  const { client, seen } = await connect({ pin: "2026-07-28" }, { elicitation: { url: {} } }, async (params) => {
    approval = await approve(String(params.url));
    return { action: "accept" };
  });
  out.D_approved = { result: await call(client, "api_key_create", { label: "ci" }), elicitationSeenByClient: seen, approval };
  out.D_wire = wire.slice(mark).filter((w) => JSON.stringify(w).includes("api_key_create"));
  out.D_whoami_after = await call(client, "whoami");
  // Tampered requestState is refused by the codec.
  const forged = await fetch(MCP + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + token, "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "api_key_create" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "api_key_create", arguments: { label: "x" }, requestState: "forged", inputResponses: { approve: { action: "accept" } }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "raw", version: "0" }, "io.modelcontextprotocol/clientCapabilities": { elicitation: { url: {} } } } } }),
  });
  out.D_forged_requestState = { status: forged.status, body: safe(await forged.text()) };
  await client.close();
}
// E. 2025-era client (initialize handshake) that declares elicitation.url: served by the legacy stateless lane.
{
  const mark = wire.length;
  // fresh elevation state: end the elevation first
  await $`cd ../dashboard && bunx wrangler d1 execute eccos-auth --local --command "DELETE FROM spike_elevation"`.quiet();
  const { client, seen } = await connect("legacy", { elicitation: { url: {}, form: {} } }, async () => ({ action: "accept" }));
  out.E_legacy = { negotiated: (client as unknown as { getNegotiatedProtocolVersion?: () => string }).getNegotiatedProtocolVersion?.(), whoami: await call(client, "whoami"), stepup: await call(client, "api_key_create", { label: "ci" }), elicitationSeenByClient: seen };
  out.E_wire_first = wire.slice(mark, mark + 2);
  await client.close();
}
// F. Revocation: delete the consent row (what Connected agents → Revoke does); the very next request is refused.
{
  const { client } = await connect({ pin: "2026-07-28" }, {});
  const before = await call(client, "whoami");
  await $`cd ../dashboard && bunx wrangler d1 execute eccos-auth --local --command "DELETE FROM oauthConsent WHERE clientId = '${session.client.client_id}'"`.quiet();
  const after = await call(client, "whoami");
  out.F_revocation = { beforeOk: !("thrown" in (before as object)), after };
  out.F_wire_last = wire.at(-1);
  await client.close().catch(() => {});
}
save("02-mcp.json", out);
console.log(redact(JSON.stringify(out, null, 1)).slice(0, 9000));
