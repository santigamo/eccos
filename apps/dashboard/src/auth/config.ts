/**
 * Request-scoped auth configuration derived from Worker bindings (contract §3/§6).
 *
 * The canonical customer origin is https://app.eccos.chat; localhost is trusted
 * only for development (non-https base URL). Production-like configuration
 * (https origin) fails closed without a configured secret.
 */

import type { AuthConfig } from "./auth";
import { createMailSender, ConsoleMailSender, type MailEnv, type MailSender } from "./mail";
import { ResendMailSender } from "./mail-resend";

/** Canonical customer origin — the only production-trusted host (contract §6). */
export const CANONICAL_ORIGIN = "https://app.eccos.chat";

/** Local development origin (vite dev). */
export const LOCAL_ORIGIN = "http://localhost:3000";

export interface AuthEnv {
  DB: unknown;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  MAIL_FROM?: string;
  RESEND_API_KEY?: string;
}

/**
 * Mail adapter selection: the Resend sender is used only when the deployment
 * configures `RESEND_API_KEY` (Worker secret) — otherwise the development
 * console sender is used. Provider wiring details (domain, SPF/DKIM/DMARC,
 * DPA) are documented in `docs/auth-email-delivery.md` (eccos-0x0.11).
 */
export function createMailSenderFromEnv(env: MailEnv): MailSender {
  if (env.RESEND_API_KEY?.trim()) {
    return new ResendMailSender(env);
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
    ? [LOCAL_ORIGIN, "http://127.0.0.1:3000"]
    : [CANONICAL_ORIGIN];

  return {
    database: env.DB,
    secret: secret || `dev-insecure-secret-${LOCAL_ORIGIN}-0000000000`,
    baseURL,
    trustedOrigins,
    mail: createMailSenderFromEnv(env),
  };
}
