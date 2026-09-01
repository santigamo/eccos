/**
 * Request-scoped auth configuration derived from Worker bindings (contract §3/§6).
 *
 * The canonical customer origin is https://app.eccos.chat; localhost is trusted
 * only for development (non-https base URL). Production-like configuration
 * (https origin) fails closed without a configured secret.
 */

import type { AuthConfig } from "./auth";
import { ConsoleMailSender, type MailEnv, type MailSender } from "./mail";
import { ReccadoMailSender } from "./mail-reccado";

/** Canonical customer origin — the only production-trusted host (contract §6). */
export const CANONICAL_ORIGIN = "https://app.eccos.chat";

/** Local development origin (vite dev). */
export const LOCAL_ORIGIN = "http://localhost:3000";

/**
 * Vite dev server origins (the browser side of local development). Vite serves
 * the dashboard UI on its default port 5173 while the auth Worker runs under
 * `wrangler dev` on :3000 (README "Local development"), so browser auth
 * requests carry the Vite origin and Better Auth must trust it alongside the
 * Worker's own origin.
 */
export const VITE_DEV_ORIGIN = "http://localhost:5173";
export const VITE_DEV_ORIGIN_LOOPBACK = "http://127.0.0.1:5173";

export interface AuthEnv {
  DB: unknown;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  RECCADO_API_KEY?: string;
  RECCADO_ENDPOINT?: string;
}

/**
 * Mail adapter selection: the reccado sender is used only when the deployment
 * configures `RECCADO_API_KEY` (Worker secret) — otherwise the development
 * console sender is used, so no provider is needed locally. The adapter then
 * fails closed if the accompanying `RECCADO_ENDPOINT` secret is missing or
 * malformed: a key without an endpoint is a half-configured deployment, not a
 * degraded one.
 *
 * Provider wiring (mailbox, templates, DNS, DPA) is documented in
 * `docs/auth-email-delivery.md` (eccos-3ne).
 */
export function createMailSenderFromEnv(env: MailEnv): MailSender {
  if (env.RECCADO_API_KEY?.trim()) {
    return new ReccadoMailSender(env);
  }
  return new ConsoleMailSender();
}

export function authConfigFromEnv(env: AuthEnv): AuthConfig {
  const baseURL = env.BETTER_AUTH_URL?.trim() || CANONICAL_ORIGIN;
  const isDev = !baseURL.startsWith("https://");

  const secret = env.BETTER_AUTH_SECRET?.trim() ?? "";
  if (!secret && !isDev) {
    // Fail closed: a public deployment without an auth secret must not boot.
    throw new Error("BETTER_AUTH_SECRET must be configured for production");
  }

  const trustedOrigins = isDev
    ? [LOCAL_ORIGIN, "http://127.0.0.1:3000", VITE_DEV_ORIGIN, VITE_DEV_ORIGIN_LOOPBACK]
    : [CANONICAL_ORIGIN];

  return {
    database: env.DB,
    secret: secret || `dev-insecure-secret-${LOCAL_ORIGIN}-0000000000`,
    baseURL,
    trustedOrigins,
    mail: createMailSenderFromEnv(env),
  };
}
