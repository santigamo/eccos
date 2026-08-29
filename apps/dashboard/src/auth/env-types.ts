/**
 * Auth bindings on the dashboard Worker env (types only).
 *
 * `DB` is the dedicated auth D1 database (contract §3): never shared with other
 * products, never shared with gateway message data. `BETTER_AUTH_SECRET` is a
 * Worker secret set per environment; it is never committed.
 */

declare global {
  namespace Cloudflare {
    interface Env {
      /** Dedicated auth D1 database binding. */
      DB: D1Database;
      /** Better Auth secret (>= 32 chars). Worker secret, not a var. */
      BETTER_AUTH_SECRET?: string;
      /** Optional explicit base URL; defaults to the canonical customer origin. */
      BETTER_AUTH_URL?: string;
      /** Mail adapter inputs (provider wiring in eccos-0x0.11). */
      MAIL_FROM?: string;
      RESEND_API_KEY?: string;
    }
  }
}

export {};
