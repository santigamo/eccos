/**
 * Auth seam for server functions (eccos-0x0.4).
 *
 * `src/server/gateway.ts` imports ONLY this module for session/permission
 * checks. Tests that exercise the data-plane server functions can mock this
 * single seam without touching the real implementations in `session.ts` /
 * `tenant.ts`, which other test files exercise directly.
 *
 * The `Request` and the configured auth instance are supplied by the caller —
 * `src/server/gateway.ts` runs server-side, where `getRequest()` and the
 * Worker bindings live — so this seam stays free of server-only specifiers
 * (no `cloudflare:workers`, no `@tanstack/react-start/server`) and TanStack's
 * import protection keeps the client bundle clean.
 */

import { requirePermission, type GatewayAction } from "./tenant";
import { resolveSession, UnauthorizedError, type SessionUser } from "./session";
import type { Auth } from "./auth";

export { UnauthorizedError, type SessionUser };

/** Require a session plus a `gateway` permission; returns the validated org id. */
export async function requireGatewayPermission(
  auth: Auth,
  request: Request,
  action: GatewayAction,
): Promise<string> {
  return requirePermission(auth, request.headers, undefined, action);
}

/** Authenticated server-function context: throws UnauthorizedError when absent. */
export async function requireAuthContext(
  auth: Auth,
  request: Request,
): Promise<{ session: SessionUser }> {
  const session = await resolveSession(auth, request);
  if (!session) throw new UnauthorizedError();
  return { session };
}
