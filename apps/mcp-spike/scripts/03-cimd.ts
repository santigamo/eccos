// Bullet: a Workers fetcher for cimd() under global_fetch_strictly_public.
// Uses the real published client metadata documents of Claude and ChatGPT.
import { readFileSync } from "node:fs";
import { CONSOLE, LOG, RESOURCE, newUser, pkce, save } from "./lib";

const out: Record<string, unknown> = {};
const { b } = await newUser("cimd", "CIMD Workspace");
const fetchLog = () => readFileSync(LOG, "utf8").split("\n").filter((l) => l.includes("SPIKE_CIMD_FETCH")).map((l) => l.slice(l.indexOf("SPIKE_CIMD_FETCH")));

async function tryClient(clientId: string, redirectUri?: string) {
  const before = fetchLog().length;
  let doc: { redirect_uris?: string[]; client_name?: string; token_endpoint_auth_method?: string } | undefined;
  if (!redirectUri) {
    doc = (await (await fetch(clientId)).json()) as typeof doc;
    redirectUri = doc!.redirect_uris![0];
  }
  const u = new URL(CONSOLE + "/api/auth/oauth2/authorize");
  u.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri!, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s", resource: RESOURCE, scope: "eccos:view offline_access" }).toString();
  const t0 = Date.now();
  const res = await b.follow(u.href, (x) => x.pathname.startsWith("/spike/"));
  const landed = new URL(res.url);
  let body = "";
  if (landed.origin === new URL(CONSOLE).origin && !landed.pathname.startsWith("/spike/")) body = (await res.res.text()).slice(0, 300);
  return {
    clientId, published: doc && { client_name: doc.client_name, redirect_uris: doc.redirect_uris, token_endpoint_auth_method: doc.token_endpoint_auth_method },
    ms: Date.now() - t0, status: res.res.status, landedOn: landed.origin + landed.pathname, error: landed.searchParams.get("error"), errorDescription: landed.searchParams.get("error_description"), body,
    transportCalls: fetchLog().slice(before),
  };
}

out.claude = await tryClient("https://claude.ai/oauth/mcp-oauth-client-metadata");
out.claudeSecondTime_cached = await tryClient("https://claude.ai/oauth/mcp-oauth-client-metadata");
out.claudeCode = await tryClient("https://claude.ai/oauth/claude-code-client-metadata");
out.chatgpt = await tryClient("https://chatgpt.com/oauth/client.json");
// The consent page for a CIMD client: what the person would see.
{
  const u = new URL(String((out.claude as { landedOn: string }).landedOn));
  out.claudeLanded = u.pathname;
}
out.negative = {
  http: await tryClient("http://example.com/client.json", "https://example.com/cb"),
  loopbackLiteral: await tryClient("https://127.0.0.1/client.json", "https://example.com/cb"),
  privateLiteral: await tryClient("https://10.0.0.1/client.json", "https://example.com/cb"),
  metadataLiteral: await tryClient("https://169.254.169.254/client.json", "https://example.com/cb"),
  nameResolvingToLoopback: await tryClient("https://localtest.me/client.json", "https://example.com/cb"),
  redirecting: await tryClient("https://www.github.com/client.json", "https://example.com/cb"),
  notJson: await tryClient("https://example.com/client.json", "https://example.com/cb"),
  ownConsole: await tryClient("https://localhost:3000/client.json", "https://example.com/cb"),
};
save("03-cimd.json", out);
console.log(JSON.stringify(out, null, 1).slice(0, 7000));
