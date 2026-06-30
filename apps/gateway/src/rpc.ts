import { WorkerEntrypoint } from "cloudflare:workers";
import { getEffectiveConfig } from "./config";
import { listTemplates } from "@eccos/core/templates";
import type { DeliveryRecord, InboundRow, OperatorCounts, OutboundRow } from "./gateway";

type HealthStatus = "healthy" | "degraded" | "unhealthy";

function healthFromCounts(counts: OperatorCounts): HealthStatus {
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
export class GatewayRPC extends WorkerEntrypoint<Env> {
  private get stub() {
    return this.env.ECCOS.get(this.env.ECCOS.idFromName("singleton"));
  }

  async getStatus(): Promise<{
    name: string;
    version: string;
    health: HealthStatus;
    connection: {
      wabaId: string | null;
      phoneNumberId: string | null;
      displayPhone: string | null;
      connectedAt: string | null;
    };
    counts: OperatorCounts;
  }> {
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

  listInbound(opts: { limit?: number; before?: number } = {}): Promise<InboundRow[]> {
    return this.stub.listInbound(opts);
  }

  listOutbound(opts: { limit?: number; before?: number } = {}): Promise<OutboundRow[]> {
    return this.stub.listOutbound(opts);
  }

  listDeliveries(opts: { status?: string; limit?: number; before?: number } = {}): Promise<DeliveryRecord[]> {
    return this.stub.listDeliveries(opts);
  }

  getDelivery(id: number): Promise<DeliveryRecord | null> {
    return this.stub.getDelivery(id);
  }

  /** Retry a failed delivery (or replay a delivered one) — re-enqueues + wakes the alarm. */
  retryDelivery(id: number): Promise<{ ok: boolean; previousStatus: string | null }> {
    return this.stub.retryDelivery(id);
  }

  async listTemplates(limit = 100): Promise<{ ok: true; data: unknown } | { ok: false; error: unknown }> {
    const cfg = await getEffectiveConfig(this.env, this.stub);
    return listTemplates(cfg, limit);
  }
}
