/**
 * Better Auth HTTP endpoints the console refuses to serve (contract §9).
 *
 * `src/server.ts` passes every `/api/auth/*` request straight to
 * `auth.handler`, which means the Organization plugin's whole HTTP surface is
 * reachable by anyone with a session — not just the parts the console's own UI
 * uses. Three of those endpoints answer questions about the ORGANIZATION SLUG,
 * and the slug is globally unique across every tenant:
 *
 * - `organization/check-slug` is a purpose-built oracle. Any session, no
 *   membership required, `{status:true}` versus `SLUG_ALREADY_TAKEN`. Better
 *   Auth 1.7.2 offers no option to disable it.
 * - `organization/create` checks `findOrganizationBySlug` and throws
 *   `ORGANIZATION_ALREADY_EXISTS` BEFORE `beforeCreateOrganization` runs
 *   (dist/plugins/organization/routes/crud-org.mjs), so no hook can intercept
 *   the answer.
 * - `organization/update` does the same before `beforeUpdateOrganization`, so a
 *   customer probes the global namespace by renaming their own workspace.
 *
 * Minting slugs as random UUIDs (see `createOrganization`) already empties the
 * value space those questions are asked about. Blocking the endpoints is the
 * second half: it removes the question itself, and — for `create` — it closes a
 * separate, older hole. A direct `POST /api/auth/organization/create` builds an
 * organization while skipping the console's server function entirely, and with
 * it the idempotent `ensureOrganizationAccount` provisioning saga. That leaves
 * an organization with NO account link, which every tenant-scoped request then
 * fails closed on: a signed-in user could strand themselves in a workspace that
 * can never work.
 *
 * The console's own creation path is unaffected: `createOrganization` in
 * `src/organizations.ts` is a TanStack server function that calls
 * `auth.api.createOrganization` IN PROCESS. It never issues an HTTP request to
 * `/api/auth/*`, so it never traverses this check.
 *
 * The refusal is byte-identical to better-call's own miss
 * (`new Response(null, { status: 404, statusText: "Not Found" })`,
 * better-call/dist/router.mjs), so a blocked endpoint is indistinguishable from
 * one that was never registered — a 403 would itself confirm the endpoint
 * exists and is being withheld.
 *
 * The four membership writes are refused for a different reason: their rules
 * live in the console's server functions (`src/members.ts`), which call them in
 * process. Served over HTTP, any admin session could invite or grant `owner`
 * or Better Auth's default `member` role, and the act would leave no audit line.
 *
 * The OAuth provider (`oauth-provider.ts`) mounts more than the authorization
 * server needs, and contract §9 serves only that. Refused, with no caller in
 * Eccos: the `jwt` plugin's session-JWT route (already in `disabledPaths`, whose
 * own 404 carries a body that tells it apart), introspection (`ConsoleRPC.authorize` verifies tokens in process),
 * the OpenID Connect endpoints (no `openid` scope is offered), the consent
 * endpoints (Connected agents revokes through server functions, because a
 * revoke must also revoke the refresh tokens and write an audit line), and
 * every client and resource administration endpoint, including all of
 * `admin/oauth2/*`. The discovery documents the plugins mount under
 * `/api/auth/.well-known/` are refused too: the one metadata document is the
 * root `/.well-known/oauth-authorization-server` (`server/oauth-cross-origin.ts`),
 * the resource metadata belongs to the MCP Worker, and the root
 * `/.well-known/openid-configuration` would otherwise fall through to the
 * page gate and redirect to sign-in, which says "something is here".
 */

/** Exact paths (Better Auth is mounted at `/api/auth`) that never dispatch. */
export const BLOCKED_AUTH_ENDPOINTS: ReadonlySet<string> = new Set([
  "/api/auth/organization/create",
  "/api/auth/organization/check-slug",
  "/api/auth/organization/update",
  "/api/auth/organization/invite-member",
  "/api/auth/organization/cancel-invitation",
  "/api/auth/organization/remove-member",
  "/api/auth/organization/update-member-role",
  "/api/auth/token",
  "/api/auth/oauth2/introspect",
  "/api/auth/oauth2/userinfo",
  "/api/auth/oauth2/end-session",
  "/api/auth/oauth2/end-session/confirm",
  "/api/auth/oauth2/get-consents",
  "/api/auth/oauth2/get-consent",
  "/api/auth/oauth2/update-consent",
  "/api/auth/oauth2/delete-consent",
  "/api/auth/oauth2/create-client",
  "/api/auth/oauth2/get-client",
  "/api/auth/oauth2/get-clients",
  "/api/auth/oauth2/update-client",
  "/api/auth/oauth2/delete-client",
  "/api/auth/oauth2/client/rotate-secret",
  "/api/auth/oauth2/client/rotate-keys",
  "/.well-known/openid-configuration",
]);

/** Whole subtrees that never dispatch: every path below each prefix. */
export const BLOCKED_AUTH_PREFIXES: readonly string[] = [
  "/api/auth/admin/oauth2/",
  "/api/auth/.well-known/",
];

/**
 * Whether this request path is one of the refused endpoints.
 *
 * Matched on the path alone, whatever the method: a refused endpoint is refused
 * for every verb, and stays so if a future version adds one. The trailing-slash
 * and case normalisation is belt-and-braces for the same reason — better-call's router rejects both
 * variants itself in 1.4.0, and this does not depend on it continuing to.
 */
export function isBlockedAuthEndpoint(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "").toLowerCase();
  return BLOCKED_AUTH_ENDPOINTS.has(path) || BLOCKED_AUTH_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix));
}

/** The refusal itself: better-call's own "no such route" response. */
export function blockedAuthEndpointResponse(): Response {
  return new Response(null, { status: 404, statusText: "Not Found" });
}
