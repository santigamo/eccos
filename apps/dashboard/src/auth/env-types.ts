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
       * Mail adapter inputs — provider: reccado (eccos-3ne). BOTH are Worker
       * SECRETS, not vars: the endpoint carries the provider host and
       * `apps/dashboard/wrangler.jsonc` is in a public repo, so the Cloudflare
       * account subdomain deliberately stays out of it.
       *
       * `RECCADO_ENDPOINT` is the whole message endpoint
       * (`https://<host>/v1/mailboxes/<mailboxId>/transactional/messages`), not
       * a host plus a mailbox id: the key already determines the mailbox, so a
       * separate id could only ever disagree — and disagreement is reported as
       * `403 invalid_api_key`, blaming the key rather than the pairing.
       */
      RECCADO_API_KEY?: string;
      RECCADO_ENDPOINT?: string;
    }
  }
}

export {};
