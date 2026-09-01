import { WorkerEntrypoint } from "cloudflare:workers";
import { getGatewayStubForWaba } from "./gateway-stub";
import { getControlPlaneStub } from "./control-plane-stub";
import { exchangeAndRegisterAll, startConnectForAccount } from "./routes/connect";
import { getAppConfig, tenantConfig, type TenantConfig } from "./tenant-config";
import { listTemplates } from "@eccos/core/templates";
import { isPublicConfigKey } from "./private-config-keys";
import { reconcileWaba, resubscribeWaba } from "./provisioning";
import type {
  AccountResources,
  ConnectExchangeResult,
  ConnectStartResult,
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
  ReconcileWabaResult,
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
  return Object.fromEntries(Object.entries(config).filter(([key]) => isPublicConfigKey(key)));
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

  async getStatus(wabaId: string, accountId: string): Promise<GatewayStatus> {
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

  async getConfig(wabaId: string, accountId: string): Promise<Record<string, string>> {
    const { stub } = await this.scoped(wabaId, accountId);
    return publicConfig(await stub.getAllConfig());
  }

  async listInbound(opts: ListOpts, accountId: string): Promise<InboundRow[]> {
    const { stub } = await this.scoped(opts.wabaId, accountId);
    return stub.listInbound(opts);
  }

  async listOutbound(opts: ListOpts, accountId: string): Promise<OutboundRow[]> {
    const { stub } = await this.scoped(opts.wabaId, accountId);
    return stub.listOutbound(opts);
  }

  async listDeliveries(opts: DeliveryListOpts, accountId: string): Promise<DeliveryRecord[]> {
    const { stub } = await this.scoped(opts.wabaId, accountId);
    return stub.listDeliveries(opts);
  }

  async getDelivery(id: number, wabaId: string, accountId: string): Promise<DeliveryRecord | null> {
    const { stub } = await this.scoped(wabaId, accountId);
    return stub.getDelivery(id);
  }

  /** Retry a failed delivery (or replay a delivered one) — re-enqueues + wakes the alarm. */
  async retryDelivery(
    id: number,
    wabaId: string,
    accountId: string,
  ): Promise<{ ok: boolean; previousStatus: string | null }> {
    const { stub } = await this.scoped(wabaId, accountId);
    return stub.retryDelivery(id);
  }

  async listTemplates(wabaId: string, limit: number | undefined, accountId: string): Promise<TemplatesResult> {
    const { config: cfg } = await this.scoped(wabaId, accountId);
    return listTemplates(cfg, limit);
  }

  /** Operator-visible forwarding target (DO config first, env fallback). Never returns the secret. */
  async getSubscriberConfig(wabaId: string, accountId: string): Promise<SubscriberConfig> {
    const { stub } = await this.scoped(wabaId, accountId);
    return stub.getSubscriberConfig();
  }

  /** Rotate the forwarding target. Persists to DO config; the secret is only stored when provided. */
  async setSubscriberConfig(
    input: SetSubscriberConfigInput,
    wabaId: string,
    accountId: string,
  ): Promise<{ ok: true }> {
    const { stub } = await this.scoped(wabaId, accountId);
    await stub.setSubscriberConfig(input);
    return { ok: true };
  }

  /** Right-to-erasure (GDPR Art. 17): delete/redact every stored trace of a phone
   * number across the gateway tables. Returns per-table counts as erasure evidence. */
  async eraseByPhone(phone: string, wabaId: string, accountId: string): Promise<EraseByPhoneResult> {
    const { stub } = await this.scoped(wabaId, accountId);
    return stub.eraseByPhone(phone);
  }

  async exportData(wabaId: string, accountId: string): Promise<GatewayExport> {
    const { stub } = await this.scoped(wabaId, accountId);
    return stub.exportData();
  }

  /**
   * Re-subscribe this app to the WABA's webhooks on Meta through the control-plane
   * provisioning reconciler.
   */
  async resubscribe(wabaId: string, accountId: string): Promise<ResubscribeResult> {
    try {
      const account = requireAccountId(accountId, "accountId is required");
      const result = await resubscribeWaba(this.env, account, wabaId);
      return result.error ? { ok: false, error: result.error } : { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /**
   * Re-run provisioning for one WABA at the operator's request (eccos-lpk).
   *
   * Unlike every other method here this one does NOT go through `scoped()`: a
   * `pending` WABA has no active registration yet, and it is exactly the row an
   * operator needs to re-check. Ownership is still enforced — `reconcileWaba`
   * reads the row through the account-scoped registry and reports "not owned"
   * as a plain failure. The saga's lease and revision guards make it safe next
   * to the cron; a failure leaves the row pending for the cron to retry.
   */
  async reconcileWaba(wabaId: string, accountId: string): Promise<ReconcileWabaResult> {
    try {
      const account = requireAccountId(accountId, "accountId is required");
      const run = await reconcileWaba(this.env, account, wabaId);
      if (!run.waba) {
        return { ok: false, error: `WABA "${wabaId}" is not owned by account "${account}"` };
      }
      return {
        ok: true,
        status: run.waba.status,
        error: run.waba.provisioningError ?? run.error,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Enumerate the durable resources owned by one account (registry). */
  async listAccountResources(accountId: string): Promise<AccountResources> {
    const account = requireAccountId(accountId, "accountId is required");
    return getControlPlaneStub(this.env).listAccountResources(account);
  }

  /** Idempotent organization→account provisioning (contract §2). Creates no API
   * key; concurrent/retried calls converge to one account and one link. */
  async ensureOrganizationAccount(
    organizationId: string,
    name?: string,
  ): Promise<{ accountId: string; status: "active" | "existing" }> {
    return getControlPlaneStub(this.env).ensureOrganizationAccount(organizationId, name);
  }

  /** Read the organization→account link. Unknown org → null; pending/disabled
   * links are returned so callers fail closed (contract §10). */
  async getOrganizationAccountLink(organizationId: string): Promise<{
    accountId: string;
    status: "active" | "pending" | "disabled";
  } | null> {
    return getControlPlaneStub(this.env).getOrganizationAccountLink(organizationId);
  }

  /** Start Embedded Signup for a resolved account (contract §Reconciliation):
   * the installation key is replaced by the server-resolved account id.
   * `returnTo` is where Meta's callback hands the operator back (eccos-5z9);
   * the control plane re-validates it before storing. */
  async startConnectForAccountId(accountId: string, returnTo?: string): Promise<ConnectStartResult> {
    const id = requireAccountId(accountId, "accountId is required");
    const resources = await getControlPlaneStub(this.env).listAccountResources(id);
    if (!resources.account) throw new Error(`Account "${id}" is not configured`);
    const publicOrigin = this.env.GATEWAY_PUBLIC_URL?.trim();
    if (!publicOrigin) throw new Error("GATEWAY_PUBLIC_URL is required for dashboard Embedded Signup");
    return startConnectForAccount(this.env, id, publicOrigin, returnTo);
  }

  /**
   * Finish Embedded Signup for a code that came from the JavaScript SDK.
   *
   * The dashboard's SDK page gets the code from `FB.login()` and posts it to a
   * server function, which calls this. That indirection is the point: the code
   * has to be exchanged with the app secret, and the browser must never hold an
   * account API key, so the only public surface is a session-authenticated
   * dashboard route and the exchange itself never leaves the private binding.
   *
   * `state` is consumed here — single-use, account-bound, and re-checked
   * against the caller's account, so a code minted for one tenant cannot be
   * redeemed by another. No `redirect_uri` is sent: the SDK flow never had one.
   */
  async exchangeConnectCodeForAccountId(
    accountId: string,
    code: string,
    state: string,
    wabaId?: string,
  ): Promise<ConnectExchangeResult> {
    const id = requireAccountId(accountId, "accountId is required");
    const authorizationCode = code?.trim();
    if (!authorizationCode) throw new Error("code is required");
    const oauthState = state?.trim();
    if (!oauthState) throw new Error("state is required");
    const publicOrigin = this.env.GATEWAY_PUBLIC_URL?.trim();
    if (!publicOrigin) throw new Error("GATEWAY_PUBLIC_URL is required for dashboard Embedded Signup");

    const controlPlane = getControlPlaneStub(this.env);
    // Single-use and account-bound. Consuming before the exchange means a
    // replayed post cannot start a second registration even if the first is
    // still in flight.
    const consumed = await controlPlane.consumeConnectStateForAccount(oauthState, id);
    if (!consumed) {
      return { ok: false, error: "invalid or expired OAuth state", code: "state" };
    }
    return exchangeAndRegisterAll(
      this.env,
      (work) => this.ctx.waitUntil(work),
      authorizationCode,
      id,
      // No redirect_uri: an `FB.login()` code was never bound to one, and Meta
      // rejects the exchange if one is sent.
      undefined,
      publicOrigin,
      wabaId?.trim() || undefined,
    );
  }
}
