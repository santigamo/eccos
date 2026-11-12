import type { GatewayApi } from "@eccos/gateway-contract";

// Tighten the generated `env.GATEWAY` binding type.
//
// `wrangler types` emits `GATEWAY` as a bare cross-worker `Service` — it can't
// resolve the remote `GatewayRPC` entrypoint's shape — which is why `withGateway`
// otherwise needs an `as unknown as GatewayApi` cast. Here we re-type the binding
// as a `Service` over the shared contract. Intersecting with
// `Rpc.WorkerEntrypointBranded` satisfies `Service`'s generic constraint (a plain
// interface isn't RPC-branded, so `Service<GatewayApi>` alone is rejected) and
// yields a stub that is assignable to `GatewayApi`, so the cast can be dropped.
declare global {
  namespace Cloudflare {
    interface Env {
      META_APP_ID?: string;
      META_ES_CONFIG_ID?: string;
      /** Eccos Cloud billing; all unset (the default) turns it off. */
      CREEM_API_KEY?: string;
      CREEM_WEBHOOK_SECRET?: string;
      CREEM_PRODUCT_ID?: string;
      GATEWAY: Service<GatewayApi & Rpc.WorkerEntrypointBranded>;
    }
  }
}
