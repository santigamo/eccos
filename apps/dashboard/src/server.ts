import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import { createServerEntry, type ServerEntry } from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";
import { createAuth } from "./auth/auth";
import { authConfigFromEnv } from "./auth/config";
import { resolveSession } from "./auth/session";

/**
 * Custom TanStack Start server entry (picked up by convention at `src/server.ts`,
 * and pointed at by `wrangler.jsonc` `main`).
 *
 * Responsibilities, in order:
 * 1. Canonical-host allowlist (contract §6): only the customer origin (and
 *    localhost in development) reaches the app. Raw `*.workers.dev`/preview
 *    origins fail closed with 403 — they are not alternate customer paths.
 * 2. Better Auth handler at `/api/auth/*` (identity plane: sessions, sign-up/
 *    sign-in, organization endpoints). The auth instance is built per request
 *    from the request-scoped bindings — no module-global auth state.
 * 3. Page-level auth gate (contract §10): anonymous page loads are redirected
 *    to `/signin` (with a bounce-back target) except the public auth pages.
 *    Server functions additionally fail closed per-call in
 *    `src/auth/server-auth.ts`; `/assets/*` are public static files.
 */

const startHandler = createStartHandler(defaultStreamHandler);

/** Hosts allowed to reach the app. `app.eccos.chat` is the only customer origin. */
const CANONICAL_HOSTS = new Set(["app.eccos.chat"]);
/** Development-only hosts (workers.dev-style bypasses are NOT in this list). */
const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Paths reachable without a Better Auth session (contract §10). */
const PUBLIC_PATHS = new Set([
  "/signin",
  "/signup",
  "/forgot-password",
  "/reset-password",
]);

export function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (CANONICAL_HOSTS.has(host)) return true;
  // Dev hosts only count when running without a production binding (BETTER_AUTH_URL unset or local).
  const configured = env.BETTER_AUTH_URL?.trim() || "";
  const isDevConfig = !configured.startsWith("https://");
  return isDevConfig && DEV_HOSTS.has(host);
}

const forbidden = (): Response =>
  new Response("Forbidden", { status: 403, headers: { "cache-control": "private, no-store" } });

function signInRedirect(requestUrl: string): Response {
  const url = new URL(requestUrl);
  const target = `${url.pathname}${url.search}`;
  const location = `/signin?redirect=${encodeURIComponent(target)}`;
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "private, no-store" },
  });
}

const handleFetch: ServerEntry["fetch"] = async (request, opts) => {
  const url = new URL(request.url);
  if (!isAllowedHost(url.hostname)) {
    return forbidden();
  }
  const { pathname } = url;
  if (pathname.startsWith("/api/auth/")) {
    const auth = createAuth(authConfigFromEnv(env));
    return auth.handler(request);
  }

  // Page-level auth gate: every non-public page load requires a session, and
  // signed-in users skip the auth pages (contract §10). Static assets stay
  // public; server functions fail closed per-call in src/auth/server-auth.ts.
  if (!pathname.startsWith("/assets/")) {
    const isPublic = PUBLIC_PATHS.has(pathname);
    const auth = createAuth(authConfigFromEnv(env));
    const session = await resolveSession(auth, request);
    if (!session && !isPublic) {
      return signInRedirect(request.url);
    }
    if (session && isPublic && pathname !== "/reset-password") {
      return new Response(null, {
        status: 302,
        headers: { location: "/", "cache-control": "private, no-store" },
      });
    }
  }

  const response = await startHandler(request, opts);
  if (request.method === "POST" || !pathname.startsWith("/assets/")) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return response;
};

export default createServerEntry({ fetch: handleFetch });
