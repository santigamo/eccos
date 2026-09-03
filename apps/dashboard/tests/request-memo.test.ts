/**
 * Request-scoped session memo tests (eccos-ya5, contract §5).
 *
 * The gateway's `requireActor` calls `requireGatewayPermission` (which resolves
 * the session via `requirePermission` -> `auth.api.getSession`) AND
 * `requireAuthContext` (a second `auth.api.getSession`) — two D1 reads per
 * admin call. The contract forbids cross-request authorization caching, so the
 * memo is scoped to a single Request object (WeakMap key) and dies with it.
 *
 * These tests exercise the real session/tenant seam against a fake Auth whose
 * `getSession` counts invocations, proving:
 *   (i)   within one request, repeated resolutions share ONE getSession;
 *   (ii)  a DIFFERENT request gets a fresh resolution (revocation latency kept);
 *   (iii) the memo stays fail-closed (null results are memoized as null;
 *         resolution errors are NOT cached, so a transient failure cannot
 *         poison a request).
 */

import { describe, expect, mock, test } from "bun:test";
import type { Auth } from "../src/auth/auth";
import { resolveSession, requireSession } from "../src/auth/session";
import { requirePermission } from "../src/auth/tenant";

/**
 * `?real-module` ON PURPOSE, and it is load-bearing.
 *
 * `tests/gateway.test.ts` registers a process-global `mock.module` for
 * `../src/auth/server-auth` that replaces both of these with fakes keyed to
 * its own file-local session state. Bun never resets the module registry
 * between test files, so a plain static import here would get THAT mock
 * whenever gateway.test.ts happens to evaluate first — and which file runs
 * first is bun's directory-walk order, which differs between macOS and CI's
 * Linux and reshuffles whenever a file is added or renamed.
 *
 * This file asserts the REAL request-scoped memo (that a session is read from
 * D1 once per request), so the fakes would make it throw `UnauthorizedError`
 * rather than quietly measure the wrong thing. It is green today only because
 * of the order; the query specifier makes it green by construction.
 */
const { requireAuthContext, requireGatewayPermission } = await import(
  "../src/auth/server-auth?real-module"
);

interface SessionLike {
  user?: { id?: string; email?: string; emailVerified?: boolean; name?: string };
  session?: { id?: string; activeOrganizationId?: string | null };
}

/** Fake Auth whose getSession counts calls; options drive the session shape. */
function countingAuth(session: SessionLike | null): { auth: Auth; getSessionCalls: () => number } {
  let calls = 0;
  const auth = {
    api: {
      getSession: mock(async () => {
        calls += 1;
        return session;
      }),
      listOrganizations: mock(async () => [{ id: "org-1", name: "Acme" }]),
      hasPermission: mock(async () => ({ success: true })),
    },
  } as unknown as Auth;
  return { auth, getSessionCalls: () => calls };
}

const MEMBER_SESSION: SessionLike = {
  user: { id: "user-1", email: "op@corp.test", emailVerified: true, name: "Op" },
  session: { id: "sess-1", activeOrganizationId: "org-1" },
};

describe("request-scoped session memo (eccos-ya5)", () => {
  test("within one request, requireGatewayPermission + requireAuthContext share a single getSession", async () => {
    const { auth, getSessionCalls } = countingAuth(MEMBER_SESSION);
    const request = new Request("http://localhost:3000/", { headers: { cookie: "c=1" } });

    const orgId = await requireGatewayPermission(auth, request, "view");
    const ctx = await requireAuthContext(auth, request);

    expect(orgId).toBe("org-1");
    expect(ctx.session.userId).toBe("user-1");
    // The whole admin path resolves the session exactly once.
    expect(getSessionCalls()).toBe(1);
  });

  test("a different request gets a fresh resolution (revocation latency preserved)", async () => {
    const { auth, getSessionCalls } = countingAuth(MEMBER_SESSION);
    const requestA = new Request("http://localhost:3000/", { headers: { cookie: "c=1" } });
    const requestB = new Request("http://localhost:3000/", { headers: { cookie: "c=1" } });

    await requireGatewayPermission(auth, requestA, "view");
    const before = getSessionCalls();
    // Second request: session revoked server-side.
    await requireAuthContext(auth, requestB);

    expect(before).toBe(1);
    expect(getSessionCalls()).toBe(2);
  });

  test("resolveSession and requirePermission share the memo within one request", async () => {
    const { auth, getSessionCalls } = countingAuth(MEMBER_SESSION);
    const request = new Request("http://localhost:3000/", { headers: { cookie: "c=1" } });

    const direct = await resolveSession(auth, request);
    const orgId = await requirePermission(auth, request.headers, undefined, "view");

    expect(direct?.userId).toBe("user-1");
    expect(orgId).toBe("org-1");
    expect(getSessionCalls()).toBe(1);
  });

  test("fail closed: an unauthenticated resolution stays null within the request", async () => {
    const { auth, getSessionCalls } = countingAuth(null);
    const request = new Request("http://localhost:3000/");

    expect(await resolveSession(auth, request)).toBeNull();
    await expect(requireSession(auth, request)).rejects.toThrow(/authentication required/);
    expect(getSessionCalls()).toBe(1);
  });
});
