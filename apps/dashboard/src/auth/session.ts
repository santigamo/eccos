/**
 * Server-side session resolution for the customer dashboard (contract §1/§5).
 *
 * Every protected page load, loader, and server function resolves the session
 * on the server from the request's cookies. No client-supplied identity is ever
 * trusted; there is no cross-request authorization caching.
 */

import type { Auth } from "./auth";
import { getSessionOnce, type SessionResult } from "./request-memo";

/** Minimal session view the dashboard logic consumes. */
export interface SessionUser {
  userId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  sessionId: string;
  /** Active organization from the session row — UX default only, NEVER
   * authorization evidence (contract §1). */
  activeOrganizationId: string | null;
}

/** Typed error used by route guards (wired into responses by eccos-0x0.4). */
export class UnauthorizedError extends Error {
  constructor(message = "authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

function toSessionUser(session: unknown): SessionUser | null {
  if (!session || typeof session !== "object") return null;
  const s = session as {
    user?: { id?: unknown; email?: unknown; emailVerified?: unknown; name?: unknown };
    session?: { id?: unknown; activeOrganizationId?: unknown };
  };
  const user = s.user;
  const sess = s.session;
  if (!user?.id || !sess?.id) return null;
  return {
    userId: String(user.id),
    email: String(user.email ?? ""),
    emailVerified: Boolean(user.emailVerified),
    name: String(user.name ?? ""),
    sessionId: String(sess.id),
    activeOrganizationId:
      sess.activeOrganizationId == null ? null : String(sess.activeOrganizationId),
  };
}

/**
 * Resolve the signed-in user from the request, or null when unauthenticated.
 * Invalid, expired, revoked, or cross-origin sessions all resolve to null
 * (fail closed).
 */
export async function resolveSession(auth: Auth, request: Request): Promise<SessionUser | null> {
  try {
    const result: SessionResult = await getSessionOnce(auth, request);
    return toSessionUser(result);
  } catch {
    // Any resolution failure is an unauthenticated request, not a 500.
    return null;
  }
}

/** Like {@link resolveSession} but throws `UnauthorizedError` when absent. */
export async function requireSession(auth: Auth, request: Request): Promise<SessionUser> {
  const session = await resolveSession(auth, request);
  if (!session) throw new UnauthorizedError();
  return session;
}
