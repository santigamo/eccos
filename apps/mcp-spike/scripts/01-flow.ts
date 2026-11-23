// Bullets: postLogin.consentReferenceId + claim in the token; raw access token verified in process
// (through ConsoleRPC.authorize over the service binding); actor reaching tools.
import { Browser, CONSOLE, MCP, RESOURCE, decodeJwt, newUser, pkce, save } from "./lib";

const REDIRECT = "http://127.0.0.1:53682/callback";
const out: Record<string, unknown> = {};

// 1. Unauthenticated MCP request -> challenge -> metadata.
const challenge = await fetch(MCP + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
out.challenge = { status: challenge.status, wwwAuthenticate: challenge.headers.get("www-authenticate") };
out.protectedResource = await (await fetch(MCP + "/.well-known/oauth-protected-resource/mcp")).json();
out.authorizationServer = await (await fetch(CONSOLE + "/.well-known/oauth-authorization-server/api/auth")).json();

// 2. Dynamic registration (public client).
const reg = await fetch(CONSOLE + "/api/auth/oauth2/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Spike Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
});
const client = (await reg.json()) as { client_id: string };
out.registration = { status: reg.status, client };

// 3. A person with TWO workspaces; they pick the second.
const { b, organizationId: first } = await newUser("flow", "Workspace One");
const w2 = await b.post("/spike/create-workspace", { name: "Workspace Two" });
const second = ((await w2.json()) as { organizationId: string }).organizationId;
out.workspaces = { first, second };

// 4. Authorize.
const { verifier, challenge: codeChallenge } = pkce();
const authorize = new URL(CONSOLE + "/api/auth/oauth2/authorize");
authorize.search = new URLSearchParams({
  response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: codeChallenge, code_challenge_method: "S256",
  state: "state-" + Date.now(), resource: RESOURCE, scope: "eccos:view eccos:operate eccos:send eccos:configure eccos:administer offline_access",
}).toString();
const step1 = await b.follow(authorize.href, (u) => u.pathname.startsWith("/spike/"));
const workspacePage = new URL(step1.url);
out.afterAuthorize = workspacePage.pathname;
if (workspacePage.pathname !== "/spike/workspace") throw new Error("expected workspace step, got " + step1.url + "\n" + b.trail.join("\n"));

// 5. Pick workspace two, continue.
await b.post("/api/auth/organization/set-active", { organizationId: second });
const cont = await b.post("/api/auth/oauth2/continue", { postLogin: true, oauth_query: workspacePage.search.slice(1) });
const contJson = (await cont.json()) as Record<string, string>;
out.continue = { status: cont.status, keys: Object.keys(contJson) };
const consentUrl = new URL(contJson.url ?? contJson.redirect_uri ?? contJson.uri, CONSOLE);
out.consentPage = consentUrl.pathname;
const consentPage = await b.fetch(consentUrl.href);
out.consentPageStatus = consentPage.status;

// 6. Consent, unticking eccos:send.
const granted = "eccos:view eccos:operate eccos:configure eccos:administer offline_access";
const consent = await b.post("/api/auth/oauth2/consent", { accept: true, scope: granted, oauth_query: consentUrl.search.slice(1) });
const consentJson = (await consent.json()) as Record<string, string>;
const callback = new URL(consentJson.url ?? consentJson.redirect_uri ?? consentJson.uri);
out.callback = { origin: callback.origin + callback.pathname, params: [...callback.searchParams.keys()], iss: callback.searchParams.get("iss") };

// 7. Token.
const tokenRes = await fetch(CONSOLE + "/api/auth/oauth2/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: RESOURCE }),
});
const tokens = (await tokenRes.json()) as Record<string, string>;
if (!tokens.access_token) throw new Error("no token: " + JSON.stringify(tokens) + "\n" + b.trail.join("\n"));
const jwt = decodeJwt(tokens.access_token);
out.token = { status: tokenRes.status, keys: Object.keys(tokens), expires_in: tokens.expires_in, scope: tokens.scope, header: jwt.header, payload: jwt.payload };
out.claimMatchesChosenWorkspace = jwt.payload["https://eccos.chat/workspace"] === second;

// 8. Call the MCP server with the token: tools/list and whoami (2026-07-28 stateless, raw JSON-RPC).
const rpc = async (method: string, params: unknown, extra: Record<string, string> = {}) => {
  const res = await fetch(MCP + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + tokens.access_token, "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text); } catch {}
  return { status: res.status, wwwAuthenticate: res.headers.get("www-authenticate"), body };
};
const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "spike-raw", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} };
out.toolsList = await rpc("tools/list", { _meta: meta });
out.whoami = await rpc("tools/call", { name: "whoami", arguments: {}, _meta: meta });
out.gatewayProbe = await rpc("tools/call", { name: "gateway_probe", arguments: {}, _meta: meta });
out.scopeChallenge = await rpc("tools/list", { _meta: meta }, { "x-spike-need-scope": "1" });

// 9. Negative checks on the raw token.
const bad = async (label: string, token: string) => {
  const res = await fetch(MCP + "/mcp", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: "{}" });
  return { label, status: res.status, wwwAuthenticate: res.headers.get("www-authenticate") };
};
const tampered = tokens.access_token.slice(0, -4) + "AAAA";
out.negative = [await bad("tampered signature", tampered), await bad("garbage", "not-a-jwt"), await bad("refresh token as bearer", tokens.refresh_token ?? "none")];

// 10. Revocation takes effect on the next request: delete the consent row (what "Connected agents → Revoke" does).
out.trail = b.trail;
save("01-flow.json", out);
await Bun.write(new URL("../evidence/.session.json", import.meta.url).pathname, JSON.stringify({ tokens, client, second, first, jar: [...b.jar] }));
console.log(JSON.stringify({ claimMatchesChosenWorkspace: out.claimMatchesChosenWorkspace, whoami: out.whoami, negative: out.negative, scopeChallenge: out.scopeChallenge }, null, 1).slice(0, 5000));
