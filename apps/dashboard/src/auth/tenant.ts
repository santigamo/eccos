/**
 * Server-side tenant resolution and authorization helpers (contract §1/§5).
 *
 * The tenant is re-derived per request from the Better Auth session and its
 * memberships — NEVER from `session.activeOrganizationId`, slugs, metadata, or
 * any browser-supplied accountId/orgId (those are UX input at most). The
 * organization→account link itself is resolved through the gateway control
 * plane (see `resolveTenantAccount` callers in eccos-0x0.6).
 */

import type { Auth } from "./auth";
import type { GatewayAction } from "./permissions";

export type { GatewayAction };
import { UnauthorizedError } from "./session";

/** Typed error for authenticated-but-forbidden requests (used by route guards
 * wired into responses by eccos-0x0.4). */
export class ForbiddenError extends Error {
  constructor(message = "not allowed for this organization") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** Minimal membership view from the identity plane. */
export interface Membership {
  id: string;
  name: string;
  slug: string;
}

interface OrganizationLike {
  id?: unknown;
  name?: unknown;
  slug?: unknown;
}

/**
 * List the organizations the signed-in user belongs to. Resolved from Better
 * Auth memberships only; an empty result means the user must onboard into an
 * organization before any account-scoped operation.
 */
export async function resolveMemberships(
  auth: Auth,
  headers: Headers,
): Promise<Membership[]> {
  const orgs = (await auth.api.listOrganizations({ headers })) as OrganizationLike[];
  return orgs
    .filter((org) => typeof org?.id === "string")
    .map((org) => ({
      id: String(org.id),
      name: String(org.name ?? ""),
      slug: String(org.slug ?? ""),
    }));
}

/**
 * Verify the user is a member of the given organization — the server-side
 * membership check that every protected operation requires (contract §1 step 3).
 * A guessed or forged organizationId fails here.
 */
export async function verifyMembership(
  auth: Auth,
  headers: Headers,
  organizationId: string,
): Promise<boolean> {
  if (!organizationId) return false;
  const memberships = await resolveMemberships(auth, headers);
  return memberships.some((m) => m.id === organizationId);
}

/**
 * Require that the signed-in user holds `action` in the resolved organization.
 *
 * The organization id comes from the explicit server-side argument, falling
 * back to the session's active organization — UX state only, re-validated here
 * against membership + permission (contract §5). Throws `UnauthorizedError`
 * without a session, `ForbiddenError` when the org is missing, not a
 * membership, or the permission check fails.
 *
 * Returns the validated organizationId.
 */
export async function requirePermission(
  auth: Auth,
  headers: Headers,
  organizationId: string | undefined,
  action: GatewayAction,
): Promise<string> {
  const session = await auth.api.getSession({ headers });
  if (!session?.session || !session.user) throw new UnauthorizedError();

  // UX fallback: the session's stored active organization. It is validated
  // below against membership + permission — never trusted on its own. The
  // field lives on the raw session row; typed loosely because Better Auth's
  // session type only carries it when the organization plugin is inferred.
  const rawSession = session.session as { activeOrganizationId?: string | null };
  const orgId = organizationId ?? rawSession.activeOrganizationId ?? "";
  if (!orgId) throw new ForbiddenError("no organization context");

  const memberships = await resolveMemberships(auth, headers);
  if (!memberships.some((m) => m.id === orgId)) {
    throw new ForbiddenError("not a member of the requested organization");
  }

  const result = (await auth.api.hasPermission({
    body: { permissions: { gateway: [action] }, organizationId: orgId },
    headers,
  })) as { success?: boolean } | null;
  if (result?.success !== true) {
    throw new ForbiddenError(`missing "${action}" permission in this organization`);
  }
  return orgId;
}
