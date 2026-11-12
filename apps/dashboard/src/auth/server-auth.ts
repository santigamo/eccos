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
 *
 * Session resolutions are deduplicated per request (request-memo.ts): the
 * `requireActor` path (`requireGatewayPermission` then `requireAuthContext`)
 * performs ONE `auth.api.getSession` per request instead of two, while the
 * next request always re-resolves (contract §5).
 */

import { requirePermission } from "./tenant";
import { resolveSession, UnauthorizedError, type SessionUser } from "./session";
import { getSessionOnce } from "./request-memo";
import { isStepUpRow, requireStepUp, STEP_UP_ROWS, stepUpDeadline, type Grant } from "./step-up";
import type { Auth } from "./auth";

export { UnauthorizedError, type SessionUser };

/**
 * Authorize one grant and return the validated org id. A step-up row checks
 * its role first, so a role that lacks the action is told that instead.
 */
export async function requireGatewayPermission(
  auth: Auth,
  request: Request,
  grant: Grant,
): Promise<string> {
  const stepUp = isStepUpRow(grant);
  const organizationId = await requirePermission(
    auth,
    request.headers,
    undefined,
    stepUp ? STEP_UP_ROWS[grant] : grant,
  );
  if (stepUp) await requireStepUp(auth, request.headers);
  return organizationId;
}

/** When the caller's step-up runs out (epoch ms), for work prepared ahead of its use. */
export async function stepUpUntil(auth: Auth, request: Request): Promise<number> {
  return stepUpDeadline((await getSessionOnce(auth, request)) ?? {});
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

/**
 * Session-or-null for the root loader's page gate. Returns a plain boolean —
 * the loader never needs the session payload, only its existence, and loaders
 * run for both auth'd and anonymous visitors.
 */
export async function hasSession(auth: Auth, request: Request): Promise<boolean> {
  return (await resolveSession(auth, request)) !== null;
}
