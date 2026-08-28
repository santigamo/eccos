import { WorkerEntrypoint } from "cloudflare:workers";
import { getGatewayStubForWaba } from "./gateway-stub";
import { getControlPlaneStub } from "./control-plane-stub";
import { getAppConfig, tenantConfig, type TenantConfig } from "./tenant-config";
import { listTemplates } from "@eccos/core/templates";
import { PRIVATE_CONFIG_KEYS } from "./private-config-keys";
import { resubscribeWaba } from "./provisioning";
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
 * The gateway is unconditionally account-scoped: every method requires a
 * non-empty `accountId` and verifies, via the control-plane registry, that the
 * requested WABA is owned by that account before touching its Durable Object;
 * credentials come from the registry, never from global env secrets.
 */
export class GatewayRPC extends WorkerEntrypoint<Env> implements GatewayApi {
  private stubFor(wabaId: string) {
    return getGatewayStubForWaba(this.env, wabaId);
  }

  /** Resolves the WABA's stub with an ownership + configuration context.
   * The control plane is the authority: a WABA not registered to the account
   * fails closed. */
  private async scoped(
    wabaId: string,
    accountId?: string,
  ): Promise<{
    stub: ReturnType<GatewayRPC["stubFor"]>;
    wabaId: string;
    phoneNumberId: string | null;
    config: TenantConfig;
    callbackUrl: string | null;
    displayPhone: string | null;
    provisionedAt: number | null;
  }> {
    const account = requireAccountId(accountId, "accountId is required");
    const waba = await getControlPlaneStub(this.env).getWaba(account, wabaId);
    if (!waba) throw new Error(`WABA "${wabaId}" is not owned by account "${account}"`);
    const phoneNumberId = waba.phones[0]?.phoneNumberId ?? "";
    const config = tenantConfig(getAppConfig(this.env), {
      wabaId: waba.wabaId,
      phoneNumberId,
      metaAccessToken: waba.metaAccessToken,
    });
    return {
      stub: this.stubFor(wabaId),
      wabaId: waba.wabaId,
      phoneNumberId: phoneNumberId || null,
      config,
      callbackUrl: waba.callbackUrl ?? null,
      displayPhone: waba.phones[0]?.displayPhoneNumber || null,
      provisionedAt: waba.provisionedAt ?? null,
    };
  }

  async getStatus(wabaId: string, accountId?: string): Promise<GatewayStatus> {
    const { stub, wabaId: scopedWabaId, phoneNumberId, displayPhone, provisionedAt } = await this.scoped(wabaId, accountId);
    const counts = await stub.getCounts();
    return {
      name: "eccos",
      version: "0.1.0",
      health: healthFromCounts(counts),
      connection: {
        wabaId: scopedWabaId,
        phoneNumberId,
        displayPhone,
        connectedAt: provisionedAt === null ? null : new Date(provisionedAt).toISOString(),
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
   * Re-subscribe this app to the WABA's webhooks on Meta through the control-plane
   * provisioning reconciler.
   */
  async resubscribe(wabaId: string, accountId?: string): Promise<ResubscribeResult> {
    try {
      const account = requireAccountId(accountId, "accountId is required");
      const result = await resubscribeWaba(this.env, account, wabaId);
      return result.error ? { ok: false, error: result.error } : { ok: true };
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
