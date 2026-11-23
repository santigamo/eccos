/**
 * The console as the OAuth 2.1 authorization server for the MCP resource
 * (docs/auth-tenancy-contract.md §9 "OAuth authorization server endpoints",
 * openspec/changes/add-mcp-server/design.md §2.1, §3.1, §3.4).
 *
 * Three plugins, one issuer:
 *
 * - `jwt()` holds the signing keys (EdDSA, encrypted with BETTER_AUTH_SECRET in
 *   the `jwks` table) and names the issuer: the bare console origin, which is
 *   what the root `/.well-known/oauth-authorization-server` document and the
 *   resource's metadata both say. Its own `/token` route would sign a SESSION
 *   as a JWT with the same key, so it is disabled (`disabledPaths`), and a
 *   session JWT can never pass as an access token.
 * - `mcp()` IS the OAuth provider (`oauthProvider()` is never registered next
 *   to it): tokens are audience-bound to the MCP resource, last 10 minutes,
 *   and carry the workspace the person chose. `resourceSeedScope: "process"`
 *   because `createAuth` runs per request (request-auth.ts), and the default
 *   would re-read the resource table on every one.
 * - `cimd()` resolves Client ID Metadata Documents through `cimdFetch` below.
 *
 * A grant is bound to one workspace: the post-login step stores the session's
 * active organization as the consent's reference id, and every access token
 * (code exchange and refresh alike) is refused unless the user is STILL a
 * member of it. The token is a pointer, not evidence: the MCP resource
 * re-derives role and account on every request (design §2.2).
 */

import { cimd } from "@better-auth/cimd";
import { getCurrentAuthEndpointContext } from "@better-auth/core/context";
import { mcp } from "@better-auth/mcp";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";

/** The scopes a grant may carry (design §3.2). There is none for `erase`. */
export const MCP_SCOPES = [
  "eccos:view",
  "eccos:operate",
  "eccos:send",
  "eccos:configure",
  "eccos:administer",
  "offline_access",
];

/** The access-token claim naming the grant's workspace (organization id). */
export const WORKSPACE_CLAIM = "https://eccos.chat/workspace";

const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_TIMEOUT_MS = 5_000;
/** chatgpt.com answers 403 to a request without one (design §8.3). */
export const CIMD_USER_AGENT = "Eccos-CIMD/1.0 (+https://eccos.chat)";

/**
 * The Workers transport for Client ID Metadata Documents (design §3.4).
 *
 * `cimd()` asks its transport to resolve once, pin the address and refuse
 * redirects. A Worker cannot pin a DNS answer, but it has no private network to
 * be rebound into either, and the console runs with the
 * `global_fetch_strictly_public` compatibility flag, so every fetch goes out
 * over the public Internet. Better Auth itself refuses private and reserved
 * address literals before calling this. What is left to the transport: HTTPS
 * only, GET and HEAD only, no credentials in the URL, a redirect is returned
 * to the caller and never followed (which then refuses the document), and a
 * time and size cap. Nothing outlives the request's own auth instance.
 */
export const cimdFetch: ClientMetadataResourceFetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== "https:") throw new TypeError("Client metadata must be fetched over HTTPS");
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new TypeError("Client metadata is fetched with GET or HEAD only");
  }
  if (url.username || url.password) throw new TypeError("Client metadata URLs carry no credentials");
  const headers = new Headers(request.headers);
  headers.set("user-agent", CIMD_USER_AGENT);
  const timeout = AbortSignal.timeout(CIMD_TIMEOUT_MS);
  const response = await fetch(url.href, {
    method: request.method,
    headers,
    redirect: "manual",
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  if (Number(response.headers.get("content-length") ?? 0) > CIMD_MAX_BYTES) {
    await response.body?.cancel();
    throw new TypeError("Client metadata document is too large");
  }
  if (!response.body) return response;
  let seen = 0;
  const capped = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > CIMD_MAX_BYTES) controller.error(new TypeError("Client metadata document is too large"));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(capped, { status: response.status, statusText: response.statusText, headers: response.headers });
};

/** Refuses the token unless `userId` is still a member of `organizationId`. */
async function requireMembership(userId: string, organizationId: string): Promise<void> {
  const { context } = getCurrentAuthEndpointContext();
  const member = await context.adapter.findOne({
    model: "member",
    where: [
      { field: "userId", value: userId },
      { field: "organizationId", value: organizationId },
    ],
  });
  if (!member) throw new APIError("FORBIDDEN", { message: "not_a_member" });
}

function activeOrganizationId(session: Record<string, unknown>): string | undefined {
  const id = session.activeOrganizationId;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * The authorization server's share of the Better Auth options: spread
 * `plugins` into `createAuth`'s plugin list and pass `disabledPaths` through.
 * `scripts/auth-schema.config.ts` builds the same thing, so the generated
 * migration matches what runs.
 */
export function oauthAuthorizationServer(config: { baseURL: string; mcpResource: string }) {
  return {
    disabledPaths: ["/token"],
    plugins: [
      jwt({ disableSettingJwtHeader: true, jwt: { issuer: new URL(config.baseURL).origin } }),
      mcp({
        resource: config.mcpResource,
        resourceSeedScope: "process",
        loginPage: "/signin",
        signup: { page: "/signup" },
        consentPage: "/oauth/consent",
        scopes: MCP_SCOPES,
        // Every grant acts as a person: no client_credentials (no user, no workspace).
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: 600,
        // The fallback to CIMD that Cursor and 2025-era clients need (design §3.4).
        // The provider's default limit caps registrations per address.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "infer",
        postLogin: {
          page: "/oauth/workspace",
          // The person picks the workspace on every authorization; the
          // continuation must then carry an active organization, which
          // `organization/set-active` only sets for a membership.
          shouldRedirect: ({ session, isContinuation }) => !isContinuation || !activeOrganizationId(session),
          consentReferenceId: ({ session }) => {
            const organizationId = activeOrganizationId(session);
            if (!organizationId) throw new APIError("BAD_REQUEST", { message: "workspace_required" });
            return organizationId;
          },
        },
        customAccessTokenClaims: async ({ user, referenceId }) => {
          if (!user || !referenceId) throw new APIError("FORBIDDEN", { message: "workspace_required" });
          await requireMembership(user.id, referenceId);
          return { [WORKSPACE_CLAIM]: referenceId };
        },
      }),
      cimd({ fetchClientMetadataResource: cimdFetch, metadataProfile: "mcp-2026-07-28" }),
    ],
  };
}
