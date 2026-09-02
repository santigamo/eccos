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
 */

/** Exact paths (Better Auth is mounted at `/api/auth`) that never dispatch. */
export const BLOCKED_AUTH_ENDPOINTS: ReadonlySet<string> = new Set([
  "/api/auth/organization/create",
  "/api/auth/organization/check-slug",
  "/api/auth/organization/update",
]);

/**
 * Whether this request path is one of the refused endpoints.
 *
 * All three are POST-only in Better Auth, so any other method already 404s;
 * matching on the path alone therefore changes nothing today and stays correct
 * if a future version adds a verb. The trailing-slash and case normalisation is
 * belt-and-braces for the same reason — better-call's router rejects both
 * variants itself in 1.4.0, and this does not depend on it continuing to.
 */
export function isBlockedAuthEndpoint(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "").toLowerCase();
  return BLOCKED_AUTH_ENDPOINTS.has(path);
}

/** The refusal itself: better-call's own "no such route" response. */
export function blockedAuthEndpointResponse(): Response {
  return new Response(null, { status: 404, statusText: "Not Found" });
}
