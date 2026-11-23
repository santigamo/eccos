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
 * active organization as the consent's reference id, only while the user is a
 * member of it (the workspace page, /oauth/workspace, sets it), and every access token
 * (code exchange and refresh alike) is refused unless the user is STILL a
 * member of it. The token is a pointer, not evidence: the MCP resource
 * re-derives role and account on every request (design §2.2).
 */

import { cimd } from "@better-auth/cimd";
import { getCurrentAuthEndpointContext } from "@better-auth/core/context";
import { mcp } from "@better-auth/mcp";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { CLIENT_METADATA_MAX_BYTES, clientMetadataRefusal } from "./client-metadata-limits";

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
 * to the caller and never followed (which then refuses the document), a time
 * cap, and the same size and field limits as a registration
 * (client-metadata-limits.ts). A document outside them is refused, which fails
 * the authorization with `invalid_client`. Nothing outlives the request's own
 * auth instance.
 */
export const cimdFetch: ClientMetadataResourceFetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== "https:") throw new TypeError("Client metadata must be fetched over HTTPS");
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new TypeError("Client metadata is fetched with GET or HEAD only");
  }
  if (url.username || url.password) throw new TypeError("Client metadata URLs carry no credentials");
  await assertMayResolve(url.href);
  const headers = new Headers(request.headers);
  headers.set("user-agent", CIMD_USER_AGENT);
  const timeout = AbortSignal.timeout(CIMD_TIMEOUT_MS);
  const response = await fetch(url.href, {
    method: request.method,
    headers,
    redirect: "manual",
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  if (Number(response.headers.get("content-length") ?? 0) > CLIENT_METADATA_MAX_BYTES) {
    await response.body?.cancel();
    throw new TypeError("Client metadata document is too large");
  }
  if (!response.body) return response;
  let seen = 0;
  const capped = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > CLIENT_METADATA_MAX_BYTES) controller.error(new TypeError("Client metadata document is too large"));
        else controller.enqueue(chunk);
      },
    }),
  );
  const body = await new Response(capped).text();
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    document = undefined;
  }
  const refused = response.ok && document !== undefined ? clientMetadataRefusal(document) : undefined;
  if (refused) throw new TypeError(`Client metadata document refused: ${refused.description}`);
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

/**
 * Only the authorization endpoint brings in a client it has not seen. Token
 * and revocation also resolve a client id that is a URL, and would otherwise
 * fetch and store any document a caller names, outside the authorization
 * endpoint's rate limit. A document client they know is refreshed as before.
 */
async function assertMayResolve(url: string): Promise<void> {
  let context: ReturnType<typeof getCurrentAuthEndpointContext>;
  try {
    context = getCurrentAuthEndpointContext();
  } catch {
    return;
  }
  if (context.path === "/oauth2/authorize") return;
  const known = await context.context.adapter.findOne({
    model: "oauthClient",
    where: [{ field: "clientId", value: url }],
  });
  if (!known) throw new TypeError("Client metadata documents are resolved only by the authorization endpoint");
}

async function isMember(userId: string, organizationId: string): Promise<boolean> {
  const { context } = getCurrentAuthEndpointContext();
  const member = await context.adapter.findOne({
    model: "member",
    where: [
      { field: "userId", value: userId },
      { field: "organizationId", value: organizationId },
    ],
  });
  return member !== null;
}

/**
 * The session's active workspace, only while the user is still a member of it.
 * `organization/set-active` checks membership when it is set, but a session
 * keeps the id after the user is removed.
 */
async function memberWorkspace(session: Record<string, unknown>): Promise<string | undefined> {
  const id = session.activeOrganizationId;
  if (typeof id !== "string" || !id || typeof session.userId !== "string") return undefined;
  return (await isMember(session.userId, id)) ? id : undefined;
}

/**
 * RFC 6749 §5.2: a grant that can no longer issue tokens is `invalid_grant`,
 * with no detail on why, so the client starts a new authorization.
 */
const invalidGrant = () => new APIError("BAD_REQUEST", { error: "invalid_grant" });

/**
 * Consent is never skipped (contract §9). Better Auth would skip the consent
 * page when a stored consent already covers the client, workspace and scopes,
 * so every authorization request is given `prompt=consent` before Better Auth
 * signs its query: the workspace step, the consent page and every resume carry
 * it, and only `oauth2/consent` removes it, after the person accepted, before
 * it re-enters the authorize endpoint in process. Stored
 * consents and the refresh tokens issued under them are left alone.
 *
 * `prompt=none` cannot be combined with another value. Such a request can
 * never be answered without the person, so Better Auth's
 * `interaction_required` for it is reported as what is missing,
 * `consent_required` (OpenID Connect Core §3.1.2.6).
 */
const AUTHORIZE_PATH = "/oauth2/authorize";

function promptValues(query: Record<string, unknown> | undefined): string[] {
  return typeof query?.prompt === "string" ? query.prompt.split(" ").filter(Boolean) : [];
}

const forceConsent = {
  id: "eccos-force-consent",
  hooks: {
    before: [
      {
        // The browser's own request only: `oauth2/consent` and the sign-in resume
        // re-enter the authorize endpoint in process, carrying the signed query.
        matcher: (ctx: { path?: string; request?: Request }) =>
          ctx.path === AUTHORIZE_PATH && (!ctx.request || new URL(ctx.request.url).pathname.endsWith(AUTHORIZE_PATH)),
        handler: createAuthMiddleware(async (ctx) => {
          const prompt = promptValues(ctx.query);
          if (prompt.includes("none") || prompt.includes("consent")) return;
          return { context: { query: { ...ctx.query, prompt: [...prompt, "consent"].join(" ") } } };
        }),
      },
    ],
    after: [
      {
        matcher: (ctx: { path?: string; query?: Record<string, unknown> }) =>
          ctx.path === AUTHORIZE_PATH && promptValues(ctx.query).includes("none"),
        handler: createAuthMiddleware(async (ctx) => {
          const returned = ctx.context.returned;
          const location = isAPIError(returned)
            ? new Headers(returned.headers).get("location")
            : (returned as { url?: unknown } | undefined)?.url;
          if (typeof location !== "string") return;
          const url = new URL(location, ctx.context.baseURL);
          if (url.searchParams.get("error") !== "interaction_required") return;
          url.searchParams.set("error", "consent_required");
          url.searchParams.set("error_description", "End-User consent is required");
          if (isAPIError(returned)) throw ctx.redirect(url.href);
          return ctx.json({ redirect: true, url: url.href });
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

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
        // People authorize rarely, and each new metadata-document client id
        // costs a fetch and a row: 10 per minute per address, not 30.
        rateLimit: { authorize: { window: 60, max: 10 } },
        clientRegistrationDefaultApplicationType: "infer",
        postLogin: {
          page: "/oauth/workspace",
          // The person picks the workspace on every authorization; the
          // continuation must then carry an active organization the user is
          // still a member of, or it goes back to the workspace step.
          shouldRedirect: async ({ session, isContinuation }) => !isContinuation || !(await memberWorkspace(session)),
          consentReferenceId: async ({ session }) => {
            const organizationId = session ? await memberWorkspace(session) : undefined;
            if (!organizationId) throw new APIError("BAD_REQUEST", { error: "invalid_request", error_description: "workspace_required" });
            return organizationId;
          },
        },
        customAccessTokenClaims: async ({ user, referenceId }) => {
          if (!user || !referenceId || !(await isMember(user.id, referenceId))) throw invalidGrant();
          return { [WORKSPACE_CLAIM]: referenceId };
        },
      }),
      cimd({ fetchClientMetadataResource: cimdFetch, metadataProfile: "mcp-2026-07-28" }),
      forceConsent,
    ],
  };
}
