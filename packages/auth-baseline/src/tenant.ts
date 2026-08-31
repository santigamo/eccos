/**
 * Server-side tenant resolution and authorization helpers (baseline).
 *
 * The tenant is re-derived per request from the Better Auth session and its
 * memberships — NEVER from `session.activeOrganizationId`, slugs, metadata, or
 * any browser-supplied accountId/orgId (those are UX input at most). Product
 * resources (accounts, workspaces, etc.) are resolved by the host application
 * from its own server-owned mapping, after these guards pass.
 */

import type { GatewayAction } from "./permissions";
import { UnauthorizedError, type AuthLike } from "./session";

export type { GatewayAction };

/** Auth instance with the organization API surface the guards use. */
export interface Auth extends AuthLike {
  api: {
    listOrganizations(args: { headers: Headers }): Promise<unknown>;
    hasPermission(args: { body: Record<string, unknown>; headers: Headers }): Promise<{ success?: boolean } | null>;
  };
}

/**
 * Why an authorization check refused, as a code callers can branch on.
 *
 * The message is for humans and may be reworded at any time; this is the part a
 * UI, a route guard, or a boundary is allowed to switch on, so nobody ever has
 * to match on error strings to tell "you belong to no organization" apart from
 * "your role lacks this action" — or from a transport failure.
 */
export type ForbiddenReason =
  | "no-organization"
  | "select-organization"
  | "not-a-member"
  | "missing-permission"
  | "other";

/** Typed error for authenticated-but-forbidden requests. */
export class ForbiddenError extends Error {
  readonly reason: ForbiddenReason;
  constructor(message = "not allowed for this organization", reason: ForbiddenReason = "other") {
    super(message);
    this.name = "ForbiddenError";
    this.reason = reason;
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
 * membership check that every protected operation requires. A guessed or
 * forged organizationId fails here.
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
 * against membership + permission. Throws `UnauthorizedError`
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
  let orgId = organizationId ?? rawSession.activeOrganizationId ?? "";

  const memberships = await resolveMemberships(auth, headers);
  if (!orgId) {
    // No explicit selector and no stored active org. A single membership is not
    // ambiguous, so default to it rather than dead-ending a user who has
    // exactly one place to be. Zero memberships and multi-org ambiguity both
    // still fail closed, each with the reason its caller needs to act on.
    const sole = memberships[0];
    if (memberships.length === 1 && sole) {
      orgId = sole.id;
    } else if (memberships.length === 0) {
      throw new ForbiddenError(
        "no organization membership — create or join an organization first",
        "no-organization",
      );
    } else {
      throw new ForbiddenError("select an organization", "select-organization");
    }
  }
  if (!memberships.some((m) => m.id === orgId)) {
    throw new ForbiddenError("not a member of the requested organization", "not-a-member");
  }

  const result = (await auth.api.hasPermission({
    body: { permissions: { gateway: [action] }, organizationId: orgId },
    headers,
  })) as { success?: boolean } | null;
  if (result?.success !== true) {
    throw new ForbiddenError(
      `missing "${action}" permission in this organization`,
      "missing-permission",
    );
  }
  return orgId;
}
