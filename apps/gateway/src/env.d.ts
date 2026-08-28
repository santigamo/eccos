/** App-level platform config + bootstrap secrets, shared by every tenant. */
interface Env {
  META_APP_ID?: string;
  META_ES_CONFIG_ID?: string;
  GATEWAY_PUBLIC_URL?: string;
  /** Bootstrap key for account and WABA provisioning (admin endpoints). */
  ECCOS_ADMIN_API_KEY?: string;
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
