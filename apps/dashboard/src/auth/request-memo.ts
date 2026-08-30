/**
 * Request-scoped session memo (eccos-ya5, contract §5).
 *
 * The dashboard's admin path resolves the session multiple times per request:
 * `requireGatewayPermission` internally calls `auth.api.getSession` (through
 * `requirePermission`) and `requireAuthContext` calls it again — two D1 reads
 * per admin call. This module deduplicates those resolutions WITHIN one
 * Request, while strictly honoring the tenancy contract:
 *
 * - **Never across requests**: the memo is a `WeakMap` keyed by the Request's
 *   Headers object — a per-request object that dies with the request — so it
 *   can never leak authorization state between requests or isolates.
 * - **Uniform keying**: `resolveSession`/`requireSession` receive a Request and
 *   the tenant layer receives only Headers; keying by the Headers instance
 *   (the same instance both paths see for one request) makes every resolution
 *   path share one memo entry.
 * - **Fail closed**: a null (unauthenticated) resolution is memoized as null,
 *   and repeated resolutions in the same request agree. A resolution that
 *   THROWS is NOT cached, so a transient failure cannot poison the request or
 *   mask a later valid session.
 * - **Revocation latency preserved**: the next request always re-resolves from
 *   the auth D1; a revoked session fails closed on the next protected request.
 *
 * The memo lives in `auth/` (not the server seam) so every caller — session
 * helpers, the tenant permission layer, and the server-auth seam — shares the
 * same single-flight resolution.
 */

import type { Auth } from "./auth";

/** The raw Better Auth getSession result (shape is version-dependent). */
export type SessionResult = {
  user?: { id?: string; email?: string; emailVerified?: boolean; name?: string };
  session?: { id?: string; activeOrganizationId?: string | null };
} | null;

const sessionsByRequest = new WeakMap<Headers, Promise<SessionResult>>();

/** Accept either a full Request or a bare Headers object. */
type SessionKey = Request | Headers;

function toHeaders(request: SessionKey): Headers {
  return request instanceof Headers ? request : request.headers;
}

/**
 * Resolve the session for `request` at most once per Request.
 *
 * A resolved value (including null) is memoized; a rejection is not, so the
 * next resolution attempt inside the same request can still succeed.
 */
export function getSessionOnce(auth: Auth, request: SessionKey): Promise<SessionResult> {
  const headers = toHeaders(request);
  const cached = sessionsByRequest.get(headers);
  if (cached) return cached;

  const resolution = (async () => {
    try {
      return (await auth.api.getSession({ headers })) as SessionResult;
    } catch (err) {
      // Fail closed but do not cache the failure: a transient D1/network error
      // must not pin the request to "no session".
      sessionsByRequest.delete(headers);
      throw err;
    }
  })();

  sessionsByRequest.set(headers, resolution);
  return resolution;
}
