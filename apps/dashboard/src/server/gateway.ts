import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import type {
  DeliveryListOpts,
  DeliveryRecord,
  GatewayApi,
  GatewayStatus,
  InboundRow,
  OutboundRow,
  ResubscribeResult,
  SubscriberConfig,
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
  ResubscribeResult,
  SetSubscriberConfigInput,
  SubscriberConfig,
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
 * `env.GATEWAY` is re-typed as a `Service` over the shared `GatewayApi` contract
 * in `src/env.d.ts` — the same interface the gateway's `GatewayRPC implements` —
 * so no cast is needed here. That declaration is the single type tying the two
 * Workers together. The runtime `if (!gateway)` guard still covers a genuinely
 * missing binding (e.g. running the dashboard without the gateway).
 */
async function withGateway<T>(fn: (gateway: GatewayApi) => Promise<T>): Promise<Result<T>> {
  const gateway = env.GATEWAY;
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

export const listDeliveries = createServerFn({ method: "GET" })
  .validator((opts: DeliveryListOpts | undefined) => opts)
  .handler(
    ({ data }): Promise<Result<DeliveryRecord[]>> =>
      withGateway((gateway) => gateway.listDeliveries(data)),
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

// --- Operator actions (settings page) ---

/** Read the current outbound-forwarding target. The secret is never exposed. */
export const getSubscriberConfig = createServerFn({ method: "GET" }).handler(
  (): Promise<Result<SubscriberConfig>> =>
    withGateway((gateway) => gateway.getSubscriberConfig()),
);

/** Rotate the forwarding target. `secret` is only sent when the operator sets it. */
export const setSubscriberConfig = createServerFn({ method: "POST" })
  .validator((input: { url: string; secret?: string }) => input)
  .handler(
    ({ data }): Promise<Result<{ ok: true }>> =>
      withGateway((gateway) => gateway.setSubscriberConfig(data)),
  );

/**
 * Re-run the Meta webhook subscription handshake. Two layers: the outer
 * `Result` reports gateway reachability; the inner `ResubscribeResult` reports
 * whether Meta accepted the (re)subscription.
 */
export const resubscribe = createServerFn({ method: "POST" }).handler(
  (): Promise<Result<ResubscribeResult>> =>
    withGateway((gateway) => gateway.resubscribe()),
);
