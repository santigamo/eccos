import { WorkerEntrypoint } from "cloudflare:workers";
import { getEffectiveConfig } from "./config";
import { listTemplates } from "@eccos/core/templates";
import type {
  DeliveryListOpts,
  DeliveryRecord,
  GatewayApi,
  GatewayStatus,
  Health,
  InboundRow,
  ListOpts,
  OperatorCounts,
  OutboundRow,
  TemplatesResult,
} from "@eccos/gateway-contract";

function healthFromCounts(counts: OperatorCounts): Health {
  if ((counts.deliveries.failed ?? 0) > 0) return "unhealthy";
  if ((counts.deliveries.pending ?? 0) > 10 || (counts.outbound.failed ?? 0) > 0) return "degraded";
  return "healthy";
}

/**
 * Operator API for the Eccos dashboard.
 *
 * RPC-only: reachable solely through a Cloudflare service binding
 * (entrypoint "GatewayRPC") from the dashboard Worker — never exposed as public
 * HTTP. All state lives in the EccosGateway Durable Object; these methods are
 * thin readers plus a retry trigger. The public HTTP surface (`/v1/messages`,
 * `/v1/templates`, `/webhooks/meta`) is unchanged and stays in the Hono app.
 */
export class GatewayRPC extends WorkerEntrypoint<Env> implements GatewayApi {
  private get stub() {
    return this.env.ECCOS.get(this.env.ECCOS.idFromName("singleton"));
  }

  async getStatus(): Promise<GatewayStatus> {
    const stub = this.stub;
    const [counts, config] = await Promise.all([stub.getCounts(), stub.getAllConfig()]);
    return {
      name: "eccos",
      version: "0.1.0",
      health: healthFromCounts(counts),
      connection: {
        wabaId: config.META_WABA_ID ?? null,
        phoneNumberId: config.META_PHONE_NUMBER_ID ?? null,
        displayPhone: config.DISPLAY_PHONE_NUMBER ?? null,
        connectedAt: config.CONNECTED_AT ?? null,
      },
      counts,
    };
  }

  getConfig(): Promise<Record<string, string>> {
    return this.stub.getAllConfig();
  }

  listInbound(opts: ListOpts = {}): Promise<InboundRow[]> {
    return this.stub.listInbound(opts);
  }

  listOutbound(opts: ListOpts = {}): Promise<OutboundRow[]> {
    return this.stub.listOutbound(opts);
  }

  listDeliveries(opts: DeliveryListOpts = {}): Promise<DeliveryRecord[]> {
    return this.stub.listDeliveries(opts);
  }

  getDelivery(id: number): Promise<DeliveryRecord | null> {
    return this.stub.getDelivery(id);
  }

  /** Retry a failed delivery (or replay a delivered one) — re-enqueues + wakes the alarm. */
  retryDelivery(id: number): Promise<{ ok: boolean; previousStatus: string | null }> {
    return this.stub.retryDelivery(id);
  }

  async listTemplates(limit = 100): Promise<TemplatesResult> {
    const cfg = await getEffectiveConfig(this.env, this.stub);
    return listTemplates(cfg, limit);
  }
}
