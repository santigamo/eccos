import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import type {
  DeliveryRecord,
  GatewayApi,
  GatewayStatus,
  InboundRow,
  OutboundRow,
} from "@eccos/gateway-contract";

// Re-export the shared contract types the routes render against, so the whole
// dashboard reads the operator surface from a single source of truth
// (`@eccos/gateway-contract`) — no more hand-mirrored shapes.
export type {
  DeliveryRecord,
  GatewayStatus,
  Health,
  InboundRow,
  OperatorCounts,
  OutboundRow,
} from "@eccos/gateway-contract";

/**
 * Discriminated result wrapper. Every server function narrows an unconfigured
 * or unreachable gateway to `{ ok: false }` instead of throwing, so pages render
 * a graceful "unreachable" state and a plain `vite build` / SSR without a
 * running gateway never crashes.
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Arbitrary JSON value. TanStack Start validates that server-function return
 * types are serializable and rejects bare `unknown`, so the contract's
 * `TemplatesResult` (whose `data` / `error` are `unknown`) is surfaced across
 * the boundary through this JSON type — semantically the same untyped payload,
 * just serialization-checkable. The templates route re-narrows `data`.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type TemplatesResult = { ok: true; data: Json } | { ok: false; error: Json };

export type GatewayStatusResult =
  | { ok: true; status: GatewayStatus }
  | { ok: false; error: string };

/**
 * Read the `GATEWAY` service binding and invoke the gateway's RPC entrypoint.
 *
 * `wrangler types` types `env.GATEWAY` as a bare cross-worker `Service` it can't
 * resolve to `GatewayRPC`, so we narrow it to the shared `GatewayApi` contract —
 * the same interface the gateway's `GatewayRPC implements`. This is the single
 * type that ties the two Workers together.
 */
async function withGateway<T>(fn: (gateway: GatewayApi) => Promise<T>): Promise<Result<T>> {
  const gateway = (env as unknown as { GATEWAY?: GatewayApi }).GATEWAY;
  if (!gateway) {
    return { ok: false, error: "GATEWAY service binding is not configured" };
  }
  try {
    return { ok: true, data: await fn(gateway) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Status page loader — kept returning `{ status }` for the existing route. */
export const getGatewayStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<GatewayStatusResult> => {
    const res = await withGateway((gateway) => gateway.getStatus());
    return res.ok ? { ok: true, status: res.data } : res;
  },
);

export const listDeliveries = createServerFn({ method: "GET" }).handler(
  (): Promise<Result<DeliveryRecord[]>> => withGateway((gateway) => gateway.listDeliveries()),
);

export const listInbound = createServerFn({ method: "GET" }).handler(
  (): Promise<Result<InboundRow[]>> => withGateway((gateway) => gateway.listInbound()),
);

export const listOutbound = createServerFn({ method: "GET" }).handler(
  (): Promise<Result<OutboundRow[]>> => withGateway((gateway) => gateway.listOutbound()),
);

export const listTemplates = createServerFn({ method: "GET" }).handler(
  (): Promise<Result<TemplatesResult>> =>
    withGateway(async (gateway) => (await gateway.listTemplates()) as TemplatesResult),
);

export const retryDelivery = createServerFn({ method: "POST" })
  .validator((id: number) => id)
  .handler(
    ({ data }): Promise<Result<{ ok: boolean; previousStatus: string | null }>> =>
      withGateway((gateway) => gateway.retryDelivery(data)),
  );
