/** WS2 secrets — optional until Embedded Signup is configured. */
interface Env {
  META_APP_ID?: string;
  META_ES_CONFIG_ID?: string;
  SEND_RATE_LIMITER?: RateLimit;
  /**
   * Optional Durable Object jurisdiction ("eu", "fedramp", "fedramp-high").
   * Empty/absent = no jurisdiction (current behavior). Validated in
   * `src/gateway-stub.ts` — an invalid value throws instead of being ignored.
   * CRITICAL: changing this on an existing deployment points the gateway at a
   * new, EMPTY Durable Object; data is NOT migrated. See docs/deployment.md.
   */
  DO_JURISDICTION?: string;
  /** @deprecated Legacy single retention window — read as a fallback for
   * `CONTENT_RETENTION_DAYS` only. Use the split retention vars instead. */
  RETENTION_DAYS?: string;
}
