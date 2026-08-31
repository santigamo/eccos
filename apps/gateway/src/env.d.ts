/** App-level platform config + bootstrap secrets, shared by every tenant. */
interface Env {
  META_APP_ID?: string;
  META_ES_CONFIG_ID?: string;
  GATEWAY_PUBLIC_URL?: string;
  /** Bootstrap key for account and WABA provisioning (admin endpoints). */
  ECCOS_ADMIN_API_KEY?: string;
  /**
   * Key material for the application-layer encryption of the Meta access
   * tokens stored in the control plane (`wrangler secret put
   * ECCOS_TOKEN_ENCRYPTION_KEY`, at least 32 characters — generate with
   * `openssl rand -base64 32`). Optional at the type level like every other
   * secret binding; validated at runtime in `src/token-crypto.ts`, where a
   * missing or short key makes every token read/write fail closed instead of
   * silently falling back to plaintext. See docs/deployment.md.
   */
  ECCOS_TOKEN_ENCRYPTION_KEY?: string;
  SEND_RATE_LIMITER?: RateLimit;
  /**
   * Optional Durable Object jurisdiction ("eu", "fedramp", "fedramp-high").
   * Empty/absent = no jurisdiction (current behavior). Validated in
   * `src/gateway-stub.ts` — an invalid value throws instead of being ignored.
   * CRITICAL: changing this on an existing deployment points the gateway at a
   * new, EMPTY Durable Object; data is NOT migrated. See docs/deployment.md.
   */
  DO_JURISDICTION?: string;
  CONTROL_PLANE: DurableObjectNamespace<import("./control-plane").EccosControlPlane>;
}
