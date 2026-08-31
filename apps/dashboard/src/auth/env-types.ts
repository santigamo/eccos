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
      /**
       * Mail adapter inputs — provider: reccado (eccos-3ne). The API key is a
       * Worker SECRET; the origin and mailbox are plain vars. The origin is
       * configuration rather than a constant because the provider's custom
       * domain sits behind Cloudflare Access and answers only on its
       * workers.dev host today (the contract is identical on both).
       */
      RECCADO_API_KEY?: string;
      RECCADO_BASE_URL?: string;
      RECCADO_MAILBOX_ID?: string;
    }
  }
}

export {};
