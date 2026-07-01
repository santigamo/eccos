import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

export type Health = "healthy" | "degraded" | "unhealthy";

/**
 * Return shape of the gateway's `GatewayRPC.getStatus()`.
 *
 * This is a hand-maintained local mirror of the contract in
 * `apps/gateway/src/rpc.ts`. Full cross-worker RPC type inference is not wired
 * for increment 2a: importing the gateway's types would couple this app's
 * tsconfig (and its generated `Env`) to the gateway's, which is exactly what the
 * per-app type isolation avoids. Keep this in sync with the gateway.
 * TODO(2b): publish a shared `@eccos/gateway-contract` type package.
 */
export interface GatewayStatus {
  name: string;
  version: string;
  health: Health;
  connection: {
    wabaId: string | null;
    phoneNumberId: string | null;
    displayPhone: string | null;
    connectedAt: string | null;
  };
  counts: {
    inbound: number;
    outbound: Record<string, number>;
    deliveries: Record<string, number>;
  };
}

/** Minimal slice of `GatewayRPC` the dashboard consumes in 2a. */
interface GatewayService {
  getStatus(): Promise<GatewayStatus>;
}

export type GatewayStatusResult =
  | { ok: true; status: GatewayStatus }
  | { ok: false; error: string };

/**
 * Server function: reads the `GATEWAY` service binding and calls the gateway's
 * RPC entrypoint. Runs only on the worker (SSR / server). The call is wrapped so
 * that an unconfigured or unreachable gateway yields a structured error instead
 * of throwing — the Status page renders a graceful "unreachable" state, and a
 * plain `vite build` / SSR without a running gateway never crashes.
 */
export const getGatewayStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<GatewayStatusResult> => {
    // `wrangler types` types `env.GATEWAY` loosely (a cross-worker service
    // binding it can't resolve to `GatewayRPC`), so narrow it locally.
    const gateway = (env as unknown as { GATEWAY?: GatewayService }).GATEWAY;
    if (!gateway) {
      return { ok: false, error: "GATEWAY service binding is not configured" };
    }
    try {
      const status = await gateway.getStatus();
      return { ok: true, status };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
);
