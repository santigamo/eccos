import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import { createServerEntry, type ServerEntry } from "@tanstack/react-start/server-entry";
import * as Sentry from "@sentry/cloudflare";
import { env } from "cloudflare:workers";
import { isAllowedHost } from "./auth/config";
import { getAuthForRequest } from "./auth/request-auth";
import {
  blockedAuthEndpointResponse,
  isBlockedAuthEndpoint,
} from "./auth/blocked-endpoints";
import { authGate } from "./auth/page-gate";
import { requireGatewayPermission } from "./auth/server-auth";
import { resolveSession } from "./auth/session";
import { parseMediaPath, serveMedia } from "./server/media";
import { absolutizeUnfurlTags } from "./server/unfurl";
import { beginTiming, finishTiming, logPerf } from "./server/timing";
import { sentryOptions } from "./lib/sentry";

/**
 * Custom TanStack Start server entry (picked up by convention at `src/server.ts`,
 * and pointed at by `wrangler.jsonc` `main`).
 *
 * Responsibilities, in order:
 * 1. Canonical-host allowlist (contract §6): only the `BETTER_AUTH_URL` host (and
 *    localhost in development) reaches the app. Raw `*.workers.dev`/preview
 *    origins fail closed with 403 — they are not alternate customer paths.
 * 2. Better Auth handler at `/api/auth/*` (identity plane: sessions, sign-up/
 *    sign-in, organization endpoints), minus the slug-bearing organization
 *    endpoints, which are refused before dispatch (contract §9; the reasoning
 *    lives in `auth/blocked-endpoints.ts`). The auth instance is built per
 *    request from the request-scoped bindings — no module-global auth state.
 * 3. Page-level auth gate (contract §10): anonymous page loads are redirected
 *    to `/signin` (with a bounce-back target) except the public auth pages.
 *    Anonymous server-function calls get a serialized redirect instead
 *    (auth/page-gate.ts) and additionally fail closed per-call in
 *    `src/auth/server-auth.ts`; `/assets/*` are public static files.
 */

const startHandler = createStartHandler(defaultStreamHandler);

const forbidden = (): Response =>
  new Response("Forbidden", { status: 403, headers: { "cache-control": "private, no-store" } });

const handleFetch: ServerEntry["fetch"] = async (request, opts) => {
  const url = new URL(request.url);
  if (!isAllowedHost(url.hostname, env.BETTER_AUTH_URL)) {
    return forbidden();
  }
  const { pathname } = url;
  beginTiming(request);
  // Media answers 401 rather than redirecting: an <img> cannot follow a sign-in page.
  const media = parseMediaPath(pathname);
  if (media) {
    const auth = getAuthForRequest(request, env);
    return serveMedia(
      request,
      { organizationFor: (req) => requireGatewayPermission(auth, req, "view"), gateway: env.GATEWAY },
      media.wabaId,
      media.mediaId,
    );
  }
  if (pathname.startsWith("/api/auth/")) {
    // Refused BEFORE the auth instance is even built: these endpoints answer
    // questions about the globally-unique organization slug, and `create`
    // additionally bypasses the provisioning saga (auth/blocked-endpoints.ts).
    // The console's own flows use in-process `auth.api.*` and never reach here.
    if (isBlockedAuthEndpoint(pathname)) {
      return blockedAuthEndpointResponse();
    }
    const auth = getAuthForRequest(request, env);
    return auth.handler(request);
  }

  // Page-level auth gate (contract §10); the order of its checks lives in
  // auth/page-gate.ts.
  const gated = await authGate(request, async () => {
    const auth = getAuthForRequest(request, env);
    return (await resolveSession(auth, request)) !== null;
  });
  if (gated) return gated;

  const response = await startHandler(request, opts);
  const report = finishTiming(request);
  if (request.method === "POST" || !pathname.startsWith("/assets/")) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    if (report) {
      headers.set("Server-Timing", report.header);
      if (pathname.startsWith("/_serverFn/")) logPerf(pathname, response.status, report);
    }
    return absolutizeUnfurlTags(
      new Response(response.body, { status: response.status, statusText: response.statusText, headers }),
      url.origin,
    );
  }
  return response;
};

export default Sentry.withSentry(() => sentryOptions, createServerEntry({ fetch: handleFetch }));
