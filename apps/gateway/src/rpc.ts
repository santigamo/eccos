import { WorkerEntrypoint } from "cloudflare:workers";
import { getEffectiveConfig } from "./config";
import { getGatewayStubForWaba } from "./gateway-stub";
import { subscribeApp } from "./meta/connect-api";
import { listTemplates } from "@eccos/core/templates";
import type {
  DeliveryListOpts,
  DeliveryRecord,
  EraseByPhoneResult,
  GatewayApi,
  GatewayStatus,
  Health,
  InboundRow,
  ListOpts,
  OperatorCounts,
  OutboundRow,
  ResubscribeResult,
  SetSubscriberConfigInput,
  SubscriberConfig,
  TemplatesResult,
} from "@eccos/gateway-contract";

function healthFromCounts(counts: OperatorCounts): Health {
  if ((counts.deliveries.failed ?? 0) > 0) return "unhealthy";
  if ((counts.deliveries.pending ?? 0) > 10 || (counts.outbound.failed ?? 0) > 0) return "degraded";
  return "healthy";
}

const PRIVATE_CONFIG_KEYS = new Set([
  "META_ACCESS_TOKEN",
  "META_APP_SECRET",
  "META_WEBHOOK_VERIFY_TOKEN",
  "ECCOS_API_KEY",
  "SUBSCRIBER_SECRET",
]);

function publicConfig(config: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !PRIVATE_CONFIG_KEYS.has(key)));
}

/**
 * Operator API for the Eccos dashboard.
 *
 * RPC-only: reachable solely through a Cloudflare service binding
 * (entrypoint "GatewayRPC") from the dashboard Worker — never exposed as public
 * HTTP. All state lives in the EccosGateway Durable Object; these methods are
 * thin readers plus a retry trigger. The public HTTP surface (`/v1/wabas/:wabaId/*`,
 * `/webhooks/meta`) stays in the Hono app.
 */
export class GatewayRPC extends WorkerEntrypoint<Env> implements GatewayApi {
  private stubFor(wabaId: string) {
    return getGatewayStubForWaba(this.env, wabaId);
  }

  private async scoped(wabaId: string) {
    const stub = this.stubFor(wabaId);
    const config = await getEffectiveConfig(this.env, stub);
    if (config.META_WABA_ID !== wabaId) throw new Error(`WABA "${wabaId}" is not configured`);
    return { stub, config };
  }

  async getStatus(wabaId: string): Promise<GatewayStatus> {
    const { stub, config } = await this.scoped(wabaId);
    const [counts, stored] = await Promise.all([stub.getCounts(), stub.getAllConfig()]);
    return {
      name: "eccos",
      version: "0.1.0",
      health: healthFromCounts(counts),
      connection: {
        wabaId: stored.META_WABA_ID ?? config.META_WABA_ID ?? null,
        phoneNumberId: stored.META_PHONE_NUMBER_ID ?? config.META_PHONE_NUMBER_ID ?? null,
        displayPhone: stored.DISPLAY_PHONE_NUMBER ?? null,
        connectedAt: stored.CONNECTED_AT ?? null,
      },
      counts,
    };
  }

  async getConfig(wabaId: string): Promise<Record<string, string>> {
    const { stub } = await this.scoped(wabaId);
    return publicConfig(await stub.getAllConfig());
  }

  async listInbound(opts: ListOpts): Promise<InboundRow[]> {
    const { stub } = await this.scoped(opts.wabaId);
    return stub.listInbound(opts);
  }

  async listOutbound(opts: ListOpts): Promise<OutboundRow[]> {
    const { stub } = await this.scoped(opts.wabaId);
    return stub.listOutbound(opts);
  }

  async listDeliveries(opts: DeliveryListOpts): Promise<DeliveryRecord[]> {
    const { stub } = await this.scoped(opts.wabaId);
    return stub.listDeliveries(opts);
  }

  async getDelivery(id: number, wabaId: string): Promise<DeliveryRecord | null> {
    const { stub } = await this.scoped(wabaId);
    return stub.getDelivery(id);
  }

  /** Retry a failed delivery (or replay a delivered one) — re-enqueues + wakes the alarm. */
  async retryDelivery(id: number, wabaId: string): Promise<{ ok: boolean; previousStatus: string | null }> {
    const { stub } = await this.scoped(wabaId);
    return stub.retryDelivery(id);
  }

  async listTemplates(wabaId: string, limit = 100): Promise<TemplatesResult> {
    const { config: cfg } = await this.scoped(wabaId);
    return listTemplates(cfg, limit);
  }

  /** Operator-visible forwarding target (DO config first, env fallback). Never returns the secret. */
  async getSubscriberConfig(wabaId: string): Promise<SubscriberConfig> {
    const { stub } = await this.scoped(wabaId);
    return stub.getSubscriberConfig();
  }

  /** Rotate the forwarding target. Persists to DO config; the secret is only stored when provided. */
  async setSubscriberConfig(input: SetSubscriberConfigInput, wabaId: string): Promise<{ ok: true }> {
    const { stub } = await this.scoped(wabaId);
    await stub.setSubscriberConfig(input);
    return { ok: true };
  }

  /** Right-to-erasure (GDPR Art. 17): delete/redact every stored trace of a phone
   * number across the gateway tables. Returns per-table counts as erasure evidence. */
  async eraseByPhone(phone: string, wabaId: string): Promise<EraseByPhoneResult> {
    const { stub } = await this.scoped(wabaId);
    return stub.eraseByPhone(phone);
  }

  /**
   * Re-subscribe this app to the WABA's webhooks on Meta. The external call lives here
   * (not the DO) so the DO stays the state owner. Uses the persisted META_ACCESS_TOKEN —
   * the transient Embedded Signup business token is never stored — and the configured
   * callback URL (DO config `META_WEBHOOK_CALLBACK_URL`, env fallback).
   */
  async resubscribe(wabaId: string): Promise<ResubscribeResult> {
    try {
      const { stub, config: cfg } = await this.scoped(wabaId);
      const callbackUrl =
        (await stub.getConfigValue("META_WEBHOOK_CALLBACK_URL")) ??
        (this.env as { META_WEBHOOK_CALLBACK_URL?: string }).META_WEBHOOK_CALLBACK_URL;
      if (!callbackUrl) {
        return { ok: false, error: "resubscribe: META_WEBHOOK_CALLBACK_URL is not configured" };
      }
      await subscribeApp(cfg, cfg.META_WABA_ID, cfg.META_ACCESS_TOKEN, callbackUrl);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}
