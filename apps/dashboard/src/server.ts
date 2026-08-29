import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import { createServerEntry, type ServerEntry } from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";
import { createAuth } from "./auth/auth";
import { authConfigFromEnv } from "./auth/config";

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
 * 3. The TanStack Start SSR + server-function handler; every protected route
 *    and server function re-resolves session/tenant server-side (contract §1).
 */

const startHandler = createStartHandler(defaultStreamHandler);

/** Hosts allowed to reach the app. `app.eccos.chat` is the only customer origin. */
const CANONICAL_HOSTS = new Set(["app.eccos.chat"]);
/** Development-only hosts (workers.dev-style bypasses are NOT in this list). */
const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

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
