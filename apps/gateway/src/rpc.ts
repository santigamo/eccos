import { WorkerEntrypoint } from "cloudflare:workers";
import { getEffectiveConfig } from "./config";
import { getGatewayStubForWaba } from "./gateway-stub";
import { getControlPlaneStub } from "./control-plane-stub";
import { getAppConfig, isMultiTenantEnabled, tenantConfig, type TenantConfig } from "./tenant-config";
import { subscribeApp } from "./meta/connect-api";
import { listTemplates } from "@eccos/core/templates";
import { PRIVATE_CONFIG_KEYS } from "./private-config-keys";
import type {
  AccountResources,
  DeliveryListOpts,
  DeliveryRecord,
  EraseByPhoneResult,
  GatewayExport,
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

function publicConfig(config: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !PRIVATE_CONFIG_KEYS.has(key)));
}

function requireAccountId(accountId: string | undefined, message: string): string {
  const id = accountId?.trim();
  if (!id) throw new Error(message);
  return id;
}

/**
 * Operator API for the Eccos dashboard.
 *
 * RPC-only: reachable solely through a Cloudflare service binding
 * (entrypoint "GatewayRPC") from the dashboard Worker — never exposed as public
 * HTTP. All state lives in the EccosGateway Durable Object; these methods are
 * thin readers plus a retry trigger. The public HTTP surface (`/v1/wabas/:wabaId/*`,
 * `/webhooks/meta`) stays in the Hono app.
 *
 * Account scoping: single-tenant deployments (no `ECCOS_MULTI_TENANT`) keep the
 * legacy behavior — the WABA is implicit in the env, `accountId` is ignored.
 * Multi-tenant deployments require a non-empty `accountId` on every method and
 * verify, via the control-plane registry, that the requested WABA is owned by
 * that account before touching its Durable Object; credentials come from the
 * registry, never from global env secrets.
 */
export class GatewayRPC extends WorkerEntrypoint<Env> implements GatewayApi {
  private stubFor(wabaId: string) {
    return getGatewayStubForWaba(this.env, wabaId);
  }

  /**
   * Resolves the WABA's stub with an ownership + configuration context.
   * In multi-tenant mode the control plane is the authority: a WABA not
   * registered to the account fails closed. In legacy mode the env config is
   * the authority and `accountId` is ignored.
   */
  private async scoped(
    wabaId: string,
    accountId?: string,
  ): Promise<{ stub: ReturnType<GatewayRPC["stubFor"]>; config: TenantConfig; callbackUrl: string | null }> {
    if (isMultiTenantEnabled(this.env)) {
      const account = requireAccountId(accountId, "accountId is required in multi-tenant mode");
      const waba = await getControlPlaneStub(this.env).getWaba(account, wabaId);
      if (!waba) throw new Error(`WABA "${wabaId}" is not owned by account "${account}"`);
      const phoneNumberId = waba.phones[0]?.phoneNumberId ?? "";
      const config = tenantConfig(getAppConfig(this.env), {
        wabaId: waba.wabaId,
        phoneNumberId,
        metaAccessToken: waba.metaAccessToken,
      });
      return { stub: this.stubFor(wabaId), config, callbackUrl: waba.callbackUrl ?? null };
    }
    const stub = this.stubFor(wabaId);
    const config = await getEffectiveConfig(this.env, stub);
    if (config.META_WABA_ID !== wabaId) throw new Error(`WABA "${wabaId}" is not configured`);
    return { stub, config, callbackUrl: null };
  }

  async getStatus(wabaId: string, accountId?: string): Promise<GatewayStatus> {
    const { stub, config } = await this.scoped(wabaId, accountId);
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

  async getConfig(wabaId: string, accountId?: string): Promise<Record<string, string>> {
    const { stub } = await this.scoped(wabaId, accountId);
    return publicConfig(await stub.getAllConfig());
  }

  async listInbound(opts: ListOpts, accountId?: string): Promise<InboundRow[]> {
    const { stub } = await this.scoped(opts.wabaId, accountId);
    return stub.listInbound(opts);
  }

  async listOutbound(opts: ListOpts, accountId?: string): Promise<OutboundRow[]> {
    const { stub } = await this.scoped(opts.wabaId, accountId);
    return stub.listOutbound(opts);
  }

  async listDeliveries(opts: DeliveryListOpts, accountId?: string): Promise<DeliveryRecord[]> {
    const { stub } = await this.scoped(opts.wabaId, accountId);
    return stub.listDeliveries(opts);
  }

  async getDelivery(id: number, wabaId: string, accountId?: string): Promise<DeliveryRecord | null> {
    const { stub } = await this.scoped(wabaId, accountId);
    return stub.getDelivery(id);
  }

  /** Retry a failed delivery (or replay a delivered one) — re-enqueues + wakes the alarm. */
  async retryDelivery(
    id: number,
    wabaId: string,
    accountId?: string,
  ): Promise<{ ok: boolean; previousStatus: string | null }> {
    const { stub } = await this.scoped(wabaId, accountId);
    return stub.retryDelivery(id);
  }

  async listTemplates(wabaId: string, limit = 100, accountId?: string): Promise<TemplatesResult> {
    const { config: cfg } = await this.scoped(wabaId, accountId);
    return listTemplates(cfg, limit);
  }

  /** Operator-visible forwarding target (DO config first, env fallback). Never returns the secret. */
  async getSubscriberConfig(wabaId: string, accountId?: string): Promise<SubscriberConfig> {
    const { stub } = await this.scoped(wabaId, accountId);
    return stub.getSubscriberConfig();
  }

  /** Rotate the forwarding target. Persists to DO config; the secret is only stored when provided. */
  async setSubscriberConfig(
    input: SetSubscriberConfigInput,
    wabaId: string,
    accountId?: string,
  ): Promise<{ ok: true }> {
    const { stub } = await this.scoped(wabaId, accountId);
    await stub.setSubscriberConfig(input);
    return { ok: true };
  }

  /** Right-to-erasure (GDPR Art. 17): delete/redact every stored trace of a phone
   * number across the gateway tables. Returns per-table counts as erasure evidence. */
  async eraseByPhone(phone: string, wabaId: string, accountId?: string): Promise<EraseByPhoneResult> {
    const { stub } = await this.scoped(wabaId, accountId);
    return stub.eraseByPhone(phone);
  }

  async exportData(wabaId: string, accountId?: string): Promise<GatewayExport> {
    const { stub } = await this.scoped(wabaId, accountId);
    return stub.exportData();
  }

  /**
   * Re-subscribe this app to the WABA's webhooks on Meta. The external call lives here
   * (not the DO) so the DO stays the state owner. In multi-tenant mode the registry's
   * tenant token and WABA callback metadata are used; in legacy mode the persisted
   * META_ACCESS_TOKEN (transient Embedded Signup token is never stored) and the
   * configured callback URL (DO config `META_WEBHOOK_CALLBACK_URL`, env fallback).
   */
  async resubscribe(wabaId: string, accountId?: string): Promise<ResubscribeResult> {
    try {
      const { stub, config: cfg, callbackUrl: registryCallbackUrl } = await this.scoped(wabaId, accountId);
      const callbackUrl =
        registryCallbackUrl ??
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

  /** Enumerate the durable resources owned by one account (registry). */
  async listAccountResources(accountId: string): Promise<AccountResources> {
    const account = requireAccountId(accountId, "accountId is required");
    return getControlPlaneStub(this.env).listAccountResources(account);
  }
}
