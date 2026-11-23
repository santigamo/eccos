/**
 * Request-scoped auth configuration derived from Worker bindings (contract §3/§6).
 *
 * The canonical customer origin is `BETTER_AUTH_URL`; unset or non-https means
 * development, where only localhost is trusted. Production-like configuration
 * (https origin) fails closed without a configured secret.
 */

import type { AuthConfig } from "./auth";
import { ConsoleMailSender, type MailEnv, type MailSender } from "./mail";
import { ReccadoMailSender } from "./mail-reccado";
import { attemptLimiter, type AttemptLimiter } from "../server/attempt-limit";

/** At most 20 invitations per inviter per hour, counted in the invitation hook (auth.ts). */
export function invitationLimiter(db: D1Database): AttemptLimiter {
  return attemptLimiter(db, "invite-member", 20, 60 * 60 * 1000);
}

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

/** The MCP Worker's resource under local `wrangler dev` (apps/mcp, port 8788). */
export const LOCAL_MCP_RESOURCE = "http://localhost:8788/mcp";

/** Development-only hosts (workers.dev-style bypasses are NOT in this list). */
const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Only the `BETTER_AUTH_URL` host reaches the app; localhost only in development (contract §6). */
export function isAllowedHost(hostname: string, configuredBaseURL: string | undefined): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const configured = configuredBaseURL?.trim() || "";
  if (!configured.startsWith("https://")) return DEV_HOSTS.has(host);
  return host === new URL(configured).hostname;
}

export interface AuthEnv {
  DB: unknown;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  MCP_RESOURCE?: string;
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
  const baseURL = env.BETTER_AUTH_URL?.trim() || LOCAL_ORIGIN;
  const isDev = !baseURL.startsWith("https://");

  const secret = env.BETTER_AUTH_SECRET?.trim() ?? "";
  if (!secret && !isDev) {
    // Fail closed: a public deployment without an auth secret must not boot.
    throw new Error("BETTER_AUTH_SECRET must be configured for production");
  }
  // Same rule for the audience of every access token: a public deployment
  // names its own MCP resource, never the local one.
  const mcpResource = env.MCP_RESOURCE?.trim() || (isDev ? LOCAL_MCP_RESOURCE : "");
  if (!mcpResource) {
    throw new Error("MCP_RESOURCE must be configured for production");
  }

  const trustedOrigins = isDev
    ? [LOCAL_ORIGIN, "http://127.0.0.1:3000", VITE_DEV_ORIGIN, VITE_DEV_ORIGIN_LOOPBACK]
    : [new URL(baseURL).origin];

  return {
    database: env.DB,
    secret: secret || `dev-insecure-secret-${LOCAL_ORIGIN}-0000000000`,
    baseURL,
    trustedOrigins,
    mcpResource,
    mail: createMailSenderFromEnv(env),
    invitationLimiter: invitationLimiter(env.DB as D1Database),
  };
}
