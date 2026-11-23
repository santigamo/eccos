// Discovery as the MCP SDK client runs it (RFC 9728 -> RFC 8414), with the issuer at the bare origin.
import { discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/client";
import { CONSOLE, MCP, save } from "./lib";
const tried: string[] = [];
const fetchFn = (async (u: string | URL, init?: RequestInit) => { const r = await fetch(u, init); tried.push(`${u} -> ${r.status}`); return r; }) as typeof fetch;
const prm = await discoverOAuthProtectedResourceMetadata(MCP + "/mcp", undefined, fetchFn as never);
const asUrl = prm.authorization_servers![0];
const as = await discoverAuthorizationServerMetadata(asUrl, { fetchFn: fetchFn as never });
const out = { protectedResource: prm, authorizationServerUrl: asUrl, issuer: as?.issuer, issuerMatches: as?.issuer === asUrl, tried,
  root: (await fetch(CONSOLE + "/.well-known/oauth-authorization-server")).status };
save("11-discovery.json", out);
console.log(JSON.stringify(out, null, 1));
