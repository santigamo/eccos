import { WorkerEntrypoint } from "cloudflare:workers";
import type { FunnelMailApi, FunnelMailInput, FunnelMailResult } from "@eccos/gateway-contract/funnel-mail";
import { funnelDeps, sendFunnelEmail } from "./funnel-mail";

/** The gateway's `FUNNEL_MAIL` service binding (entrypoint `FunnelMailRPC`). */
export class FunnelMailRPC extends WorkerEntrypoint<Cloudflare.Env> implements FunnelMailApi {
  sendFunnelEmail(input: FunnelMailInput): Promise<FunnelMailResult> {
    return sendFunnelEmail(funnelDeps(this.env), input);
  }
}
