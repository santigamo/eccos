/**
 * The OAuth endpoints software calls from other origins (contract §6, §9).
 *
 * MCP clients fetch the authorization-server metadata, register, exchange codes
 * and read the signing keys from their own origin, so these four answer CORS
 * with `Access-Control-Allow-Origin: *` and never `Allow-Credentials`. They
 * authenticate by what the request carries (the PKCE verifier, the refresh
 * token, the client id), never by a session: the request reaches Better Auth
 * without its `Cookie` header, and any `Set-Cookie` is dropped from the answer.
 * Without a cookie, registration can only be the open kind, never one owned by
 * whoever happens to be signed in. Every other `/api/auth` path stays
 * same-origin and cookie-bound. The size limits on these bodies live in
 * oauth-request-limits.ts.
 *
 * The RFC 8414 document lives at the root because the issuer is the bare
 * console origin and Claude and ChatGPT only look there (design §8.2). It is
 * the only metadata document: the copies under `/api/auth/.well-known` are
 * refused (blocked-endpoints.ts). It drops the introspection fields, which
 * point at an endpoint the console does not serve.
 */

import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import type { Auth } from "../auth/auth";
import { oauthRequestWithinLimits } from "./oauth-request-limits";

export const AUTH_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

/** Path → the one method it answers besides the preflight. */
const CROSS_ORIGIN: ReadonlyMap<string, "GET" | "POST"> = new Map([
  [AUTH_SERVER_METADATA_PATH, "GET"],
  ["/api/auth/oauth2/token", "POST"],
  ["/api/auth/oauth2/register", "POST"],
  ["/api/auth/jwks", "GET"],
]);

function withCors(response: Response, method: "GET" | "POST"): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.set("access-control-allow-origin", "*");
  if (response.status === 204) {
    headers.set("access-control-allow-methods", `${method}, OPTIONS`);
    headers.set("access-control-allow-headers", "authorization, content-type, dpop, mcp-protocol-version");
    headers.set("access-control-max-age", "86400");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function metadata(request: Request, auth: Auth): Promise<Response> {
  const response = await oauthProviderAuthServerMetadata(auth)(request);
  const document = (await response.json()) as Record<string, unknown>;
  for (const key of Object.keys(document)) {
    if (key.startsWith("introspection_")) delete document[key];
  }
  return new Response(JSON.stringify(document), { status: response.status, headers: response.headers });
}

/** The answer for one of the four paths, or undefined for any other request. */
export function oauthCrossOriginApi(
  request: Request,
  pathname: string,
  auth: () => Auth,
): Promise<Response> | undefined {
  const method = CROSS_ORIGIN.get(pathname);
  if (!method) return undefined;
  return (async () => {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), method);
    const limited = await oauthRequestWithinLimits(request, pathname);
    if (limited instanceof Response) return withCors(limited, method);
    const headers = new Headers(limited.headers);
    headers.delete("cookie");
    const cookieless = new Request(limited, { headers });
    const response =
      pathname === AUTH_SERVER_METADATA_PATH && request.method === "GET"
        ? await metadata(cookieless, auth())
        : await auth().handler(cookieless);
    return withCors(response, method);
  })();
}
