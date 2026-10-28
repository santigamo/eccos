/**
 * One Better Auth instance per actual Request (contract §5).
 *
 * `createAuth` builds plugins, endpoint maps and a database adapter; doing it
 * for every consumer in a request (entry gate, permission seam, organizations,
 * analytics) is pure CPU waste. The instance is memoized in a WeakMap keyed by
 * the Request's Headers (like request-memo.ts), so it dies with the request:
 * never per isolate (bindings can change under a reused isolate) and never
 * shared across requests. Session and membership are still read per request.
 */

import { createAuth, type Auth } from "./auth";
import { authConfigFromEnv } from "./config";
import { count } from "../server/timing";

const byRequest = new WeakMap<Headers, Auth>();

type AuthEnv = Parameters<typeof authConfigFromEnv>[0];

/** The request's auth instance, built on first use. Without a request, builds a fresh one. */
export function getAuthForRequest(request: Request | Headers | undefined, env: AuthEnv): Auth {
  const key = request instanceof Headers ? request : request?.headers;
  const cached = key && byRequest.get(key);
  if (cached) return cached;
  const auth = createAuth(authConfigFromEnv(env));
  if (key) {
    byRequest.set(key, auth);
    count(key, "auth-instances");
  }
  return auth;
}
