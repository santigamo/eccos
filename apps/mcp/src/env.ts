import type { ConsoleApi } from "@eccos/console-contract";
import type { GatewayApi } from "@eccos/gateway-contract";

export interface Env {
  /** The canonical resource clients connect to and every access token's audience. */
  MCP_RESOURCE: string;
  /** The console's Better Auth issuer. */
  ISSUER: string;
  /** The only browser origin allowed to call /mcp. */
  CONSOLE_ORIGIN: string;
  CONSOLE: ConsoleApi;
  GATEWAY: GatewayApi;
  MCP_RATE_LIMITER: RateLimit;
  /**
   * HMAC key that seals the step-up guard's `requestState` (a Worker secret, at least 32 bytes).
   * It grants no access: elevation is always re-read from the console. Unset, the guard never
   * uses URL elicitation and every client gets the structured approval result.
   */
  REQUEST_STATE_KEY?: string;
}
