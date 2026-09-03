import { WorkerEntrypoint } from "cloudflare:workers";
import { getGatewayStubForWaba } from "./gateway-stub";
import { getControlPlaneStub } from "./control-plane-stub";
import {
  exchangeAndRegisterAll,
  registerWabasForToken,
  startConnectForAccount,
} from "./routes/connect";
import { inspectToken, probeWabaWithToken, wabaMatchesForTargetIds } from "./meta/connect-api";
import { getAppConfig, tenantConfig, type TenantConfig } from "./tenant-config";
import { createTemplate, deleteTemplate, listTemplates } from "@eccos/core/templates";
import { sendMessage } from "@eccos/core/send";
import { isPublicConfigKey } from "./private-config-keys";
import { reconcileWaba, resubscribeWaba } from "./provisioning";
import type {
  AccountResources,
  ConnectExchangeResult,
  ConnectStartResult,
  CreateTemplateFailureCode,
  CreateTemplateInput,
  CreateTemplateResult,
  DeleteTemplateInput,
  DeleteTemplateResult,
  DeliveryListOpts,
  DeliveryRecord,
  EraseByPhoneResult,
  GatewayExport,
  GatewayApi,
  GatewayStatus,
  Health,
  InboundRow,
  ListOpts,
  ManualConnectResult,
  OperatorCounts,
  OutboundRow,
  ReconcileWabaResult,
  ResubscribeResult,
  SendTemplateTestInput,
  SendTemplateTestResult,
  SendTestFailureCode,
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

/** Digits only, E.164's 15-digit ceiling. The console normalizes; this re-checks. */
const TO_PATTERN = /^[0-9]{5,15}$/;
/** Meta's own template-name charset. */
const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
/** `en` / `es` / `en_US` / `pt_BR`. */
const LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const MAX_BODY_PARAMS = 30;
const MAX_BODY_PARAM_LENGTH = 1024;
/** Meta's body ceiling for a template component. */
const MAX_TEMPLATE_BODY_LENGTH = 1024;
/** Graph template ids (`hsm_id`) are numeric. */
const TEMPLATE_ID_PATTERN = /^[0-9]{1,32}$/;
/**
 * A pasted Meta access token: printable ASCII, no whitespace. Meta's tokens are
 * long opaque base64url-ish strings; the shape check exists to refuse a paste
 * that obviously is not one (a whole curl command, a wrapped multi-line copy)
 * before it reaches Graph, not to model Meta's alphabet.
 */
const META_TOKEN_PATTERN = /^[\x21-\x7e]{20,1024}$/;
/**
 * A WABA id named on the pasted-token path: the control plane's charset plus
 * a ceiling. The console validator is the strict one (digits only); this is
 * the mirrored throw, loose enough for the registry's own ids.
 */
const WABA_SELECTOR_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** The only two categories the console authors; AUTHENTICATION is a different
 * creation shape (preset content + OTP buttons) and is not offered. */
const TEMPLATE_CATEGORIES = new Set(["MARKETING", "UTILITY"]);

/**
 * Graph error codes worth naming, from Meta's Cloud API error reference.
 *
 * The map is small on purpose: anything not listed degrades to `graph` with
 * Meta's own message as the detail, which is legible and can never be wrong.
 * Adding a code here is a promise that the console has better words for it than
 * Meta does.
 */
const GRAPH_ERROR_CODES: Record<number, SendTestFailureCode> = {
  131030: "recipient_not_allowlisted",
  132000: "parameter_mismatch",
  132001: "template_not_found",
};

/** Pull Meta's `{ error: { code, error_subcode, message } }` out of a parsed
 * Graph body. The subcode matters because Meta reuses code 100 for every
 * malformed-request case and only the subcode says which one it was. */
function graphError(error: unknown): {
  code: number | null;
  subcode: number | null;
  message: string | null;
} {
  const body = error as
    | { error?: { code?: unknown; error_subcode?: unknown; message?: unknown } }
    | null;
  const inner = body && typeof body === "object" ? body.error : undefined;
  const message = typeof inner?.message === "string" ? inner.message.trim() : "";
  return {
    code: typeof inner?.code === "number" ? inner.code : null,
    subcode: typeof inner?.error_subcode === "number" ? inner.error_subcode : null,
    // A blank message is as good as no message: the caller falls back to the
    // HTTP status rather than rendering an empty detail line.
    message: message || null,
  };
}

/**
 * Why a template creation was refused, in the console's closed vocabulary.
 *
 * Kept separate from {@link GRAPH_ERROR_CODES} on purpose: that map is the
 * SEND vocabulary and is keyed on `code` alone, while this one has to read the
 * SUBCODE first — Meta answers a duplicate name+language with code 100,
 * subcode 2388024, and answers half a dozen unrelated format problems with a
 * bare code 100. Anything unlisted degrades to `graph` with Meta's own
 * sentence, which is legible and can never be wrong.
 */
function createTemplateFailure(code: number | null, subcode: number | null): CreateTemplateFailureCode {
  if (subcode === 2388024) return "name_taken";
  if (code === 80008) return "rate_limited";
  if (code === 100) return "invalid";
  return "graph";
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
   * fails closed.
   *
   * `anyStatus` widens that to a WABA the account owns whatever its
   * provisioning status. Deliberately asymmetric: reads and writes of
   * WABA-LEVEL resources — the template list, the subscriber config — need only
   * the WABA id and its stored Meta token, and are exactly what an operator
   * prepares on an account still waiting for its phone number. The DATA PLANE
   * is not safe that way and stays active-only: sends, logs, status, erasure and
   * export all keep `getWaba`. Ownership is enforced either way —
   * `getWabaRecord` is account-scoped too. */
  private async scoped(
    wabaId: string,
    accountId?: string,
    opts?: { anyStatus?: boolean },
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
    const controlPlane = getControlPlaneStub(this.env);
    const waba = opts?.anyStatus
      ? await controlPlane.getWabaRecord(account, wabaId)
      : await controlPlane.getWaba(account, wabaId);
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

  /** WABA-level read: the Graph call needs only the WABA id and its token, so a
   * connected-but-unprovisioned WABA can list its templates. */
  async listTemplates(wabaId: string, limit: number | undefined, accountId: string): Promise<TemplatesResult> {
    const { config: cfg } = await this.scoped(wabaId, accountId, { anyStatus: true });
    return listTemplates(cfg, limit);
  }

  /**
   * Create one message template on the WABA ("New template").
   *
   * WABA-level **write**, reachable on a WABA of any provisioning status — the
   * same asymmetry `setSubscriberConfig` documents: the Graph call needs only
   * the WABA id and its stored token, and preparing templates on an account
   * still waiting for its phone number is exactly the awaiting-a-phone use
   * case. Ownership is still enforced (`getWabaRecord` is account-scoped).
   *
   * Deliberately does NOT draw on `SEND_RATE_LIMITER`: that budget is the send
   * budget, shared with the API-key path, and burning it on authoring would let
   * template creation starve message delivery. Meta's own 80008 is the creation
   * limiter, and it maps to `rate_limited`.
   *
   * Nothing is sent, so there is no `logOutbound` row — and no line of this
   * method ever logs the body text or an example value.
   */
  async createTemplate(input: CreateTemplateInput, accountId: string): Promise<CreateTemplateResult> {
    const { config: cfg } = await this.scoped(input.wabaId, accountId, { anyStatus: true });

    // Defense in depth, throw-not-code: the dashboard validator is the strict
    // one and the only caller, so reaching any of these means that validator
    // regressed — a programmer error, which belongs in the logs as a throw
    // rather than in the UI as a failure code.
    const examples = input.bodyExamples ?? [];
    if (!TEMPLATE_NAME_PATTERN.test(input.name)) throw new Error("invalid template name");
    if (!LANGUAGE_PATTERN.test(input.language)) throw new Error("invalid template language");
    if (!TEMPLATE_CATEGORIES.has(input.category)) throw new Error("invalid template category");
    if (typeof input.bodyText !== "string" || input.bodyText.length === 0) {
      throw new Error("template body is required");
    }
    if (input.bodyText.length > MAX_TEMPLATE_BODY_LENGTH) throw new Error("template body is too long");
    if (examples.length > MAX_BODY_PARAMS) throw new Error("too many template parameters");
    for (const value of examples) {
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_BODY_PARAM_LENGTH) {
        throw new Error("example values must be 1-1024 characters");
      }
    }

    const result = await createTemplate(cfg, {
      name: input.name,
      language: input.language,
      category: input.category,
      bodyText: input.bodyText,
      ...(examples.length > 0 ? { examples } : {}),
    });
    if (!result.ok) {
      const { code, subcode, message } = graphError(result.error);
      const mapped = createTemplateFailure(code, subcode);
      return {
        ok: false,
        code: mapped,
        detail: mapped === "graph" ? (message ?? `HTTP ${result.status}`) : message,
      };
    }

    // Meta's answer, not the console's request: `category` here is the one it
    // ASSIGNED, which may differ from the one asked for, and the console says
    // so rather than pretending otherwise.
    const data = result.data as { id?: unknown; status?: unknown; category?: unknown } | null;
    return {
      ok: true,
      id: typeof data?.id === "string" ? data.id : "",
      status: typeof data?.status === "string" ? data.status : "PENDING",
      category: typeof data?.category === "string" ? data.category : input.category,
    };
  }

  /** Delete ONE translation of a template (by `hsm_id`). Same WABA-level
   * reachability and ownership rules as {@link GatewayRPC.createTemplate}.
   * `wabaId` is re-read from the scoped record so the Graph call can never be
   * addressed at a WABA the account does not own. */
  async deleteTemplate(input: DeleteTemplateInput, accountId: string): Promise<DeleteTemplateResult> {
    const { config: cfg } = await this.scoped(input.wabaId, accountId, { anyStatus: true });
    // Defense in depth again: only a regressed console can produce these.
    if (!TEMPLATE_NAME_PATTERN.test(input.name)) throw new Error("invalid template name");
    if (!TEMPLATE_ID_PATTERN.test(input.templateId)) throw new Error("invalid template id");

    const result = await deleteTemplate(cfg, { name: input.name, hsmId: input.templateId });
    if (!result.ok) {
      const { message } = graphError(result.error);
      return { ok: false, code: "graph", detail: message ?? `HTTP ${result.status}` };
    }
    return { ok: true };
  }

  /** Operator-visible forwarding target (DO config first, env fallback). Never returns the secret.
   * WABA-level: the forwarding target is what you set up BEFORE traffic exists. */
  async getSubscriberConfig(wabaId: string, accountId: string): Promise<SubscriberConfig> {
    const { stub } = await this.scoped(wabaId, accountId, { anyStatus: true });
    return stub.getSubscriberConfig();
  }

  /** Rotate the forwarding target. Persists to DO config; the secret is only stored when provided.
   * WABA-level, and safe in the awaiting-a-phone state: the provisioning saga's
   * own `saveConfig` writes only the META_ and CONNECTED_AT keys, so a
   * SUBSCRIBER_ value written here survives the WABA turning active. */
  async setSubscriberConfig(
    input: SetSubscriberConfigInput,
    wabaId: string,
    accountId: string,
  ): Promise<{ ok: true }> {
    const { stub } = await this.scoped(wabaId, accountId, { anyStatus: true });
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

  /**
   * Send one template message on the operator's behalf ("Send test").
   *
   * Deliberately does NOT go through `scoped()`: that helper configures for
   * `phones[0]`, and a test send names its own phone. The internals are mirrored
   * from the HTTP send path in `worker.ts` instead — same `getWaba` (not
   * `getWabaRecord`, so a non-active WABA fails closed exactly as
   * `POST /v1/wabas/:wabaId/messages` does), same rate-limiter key, same
   * outbound log row — so the console can never become a softer send surface
   * than the public API.
   */
  async sendTemplateTest(
    input: SendTemplateTestInput,
    accountId: string,
  ): Promise<SendTemplateTestResult> {
    const account = requireAccountId(accountId, "accountId is required");
    const waba = await getControlPlaneStub(this.env).getWaba(account, input.wabaId);
    if (!waba) throw new Error(`WABA "${input.wabaId}" is not owned by account "${account}"`);

    // A result, not a throw: the account's phones genuinely change between the
    // page load that offered this phone and the click that used it.
    if (!waba.phones.some((phone) => phone.phoneNumberId === input.phoneNumberId)) {
      return {
        ok: false,
        code: "no_phone",
        detail: `phone "${input.phoneNumberId}" is not registered on this WhatsApp Business account`,
      };
    }

    // Defense in depth. The dashboard validator is the strict one and the only
    // caller; reaching any of these means that validator regressed, which is a
    // programmer error and belongs in the logs as a throw, not in the UI as a
    // failure code.
    const bodyParams = input.bodyParams ?? [];
    if (!TO_PATTERN.test(input.to)) throw new Error("to must be 5-15 digits");
    if (!TEMPLATE_NAME_PATTERN.test(input.templateName)) throw new Error("invalid templateName");
    if (!LANGUAGE_PATTERN.test(input.languageCode)) throw new Error("invalid languageCode");
    if (bodyParams.length > MAX_BODY_PARAMS) throw new Error("too many body parameters");
    for (const value of bodyParams) {
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_BODY_PARAM_LENGTH) {
        throw new Error("body parameters must be 1-1024 characters");
      }
      if (/[\n\t]/.test(value)) throw new Error("body parameters must not contain newlines or tabs");
    }

    if (this.env.SEND_RATE_LIMITER) {
      // The SAME key as the HTTP middleware (`worker.ts`): console sends and
      // API-key sends draw from one per-tenant budget. The budget protects the
      // tenant's standing with Meta and caps blast radius — it does not
      // authenticate the transport, so a session must not buy a bigger one.
      const { success } = await this.env.SEND_RATE_LIMITER.limit({
        key: `${account}:${waba.wabaId}`,
      });
      if (!success) return { ok: false, code: "rate_limited", detail: null };
    }

    const metaBody: Record<string, unknown> = {
      to: input.to,
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
        ...(bodyParams.length > 0
          ? {
              components: [
                {
                  type: "body",
                  parameters: bodyParams.map((text) => ({ type: "text", text })),
                },
              ],
            }
          : {}),
      },
    };

    const cfg = tenantConfig(getAppConfig(this.env), {
      wabaId: waba.wabaId,
      phoneNumberId: input.phoneNumberId,
      metaAccessToken: waba.metaAccessToken,
    });
    const result = await sendMessage(cfg, metaBody);
    const stub = this.stubFor(waba.wabaId);

    if (!result.ok) {
      // The data-plane log carries the full body, parameters included — it is
      // retention- and erasure-governed exactly like an API send. The AUDIT log
      // is the one that must stay content-free.
      await stub.logOutbound(
        null,
        input.to,
        JSON.stringify(metaBody),
        "failed",
        JSON.stringify(result.error),
        input.phoneNumberId,
      );
      const { code, message } = graphError(result.error);
      const mapped = code === null ? undefined : GRAPH_ERROR_CODES[code];
      return {
        ok: false,
        code: mapped ?? "graph",
        detail: mapped ? message : (message ?? `HTTP ${result.status}`),
      };
    }

    await stub.logOutbound(
      result.id,
      input.to,
      JSON.stringify(metaBody),
      "sent",
      null,
      input.phoneNumberId,
    );
    return { ok: true, messageId: result.id };
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

  /**
   * Connect a WABA from a token the operator pasted into the console
   * (eccos-up9).
   *
   * WHY THIS EXISTS. Embedded Signup onboards *businesses*, so it never
   * surfaces Meta's own Cloud API test WABA — and that test number is what App
   * Review screencasts are filmed on. Pasting its token is the only way to
   * attach it. The alternative was an admin API key plus a curl; removing the
   * need for that shortcut is the point of this method.
   *
   * WHY IT CANNOT BE A GENERAL "ATTACH ANY TOKEN" DOOR. `debug_token` only
   * introspects tokens issued by the app doing the asking, so this deployment
   * can classify its OWN app's tokens and nothing else. That limitation is the
   * gate: a managed customer's own-app token comes back `foreign_app` and is
   * sent to Embedded Signup, which is the flow built for them. Workability is a
   * property of the token, not of the deployment, so there is no config flag —
   * a flag would either hide the form from the one operator it exists for, or
   * show a working form to every customer it cannot serve.
   *
   * THE TOKEN'S PATH ENDS AT REST. It is inspected, used as a Bearer for
   * discovery, and handed to `registerWabasForToken`, which seals it into the
   * control plane's AES-256-GCM envelope. It is never logged, never thrown in a
   * message, and never part of the returned shape.
   *
   * WHY THE SELECTOR SEEDS DISCOVERY. `debug_token`'s `target_ids` is
   * nullable and, measured on a System User token with the WABA assigned as
   * an asset, simply absent — so a token that reads the WABA perfectly well
   * would answer `no_waba` and there was no way to attach an id known for
   * days. When the operator names a WABA, discovery is skipped and the token
   * is proven against that id directly with `probeWabaWithToken`: Meta's live
   * answer to the read is a stronger authorization check than issuance-time
   * metadata it may omit. Meta refusing fails closed (`no_access`); another
   * account owning it still fails closed (`owned`, decided by the shared
   * registration path, which this never bypasses).
   *
   * `onboardingType: "standard"` is deliberate and is the one thing that must
   * not be copied from the Embedded Signup call site: a pasted token had no ES
   * handoff, so claiming `coexistence` would invent a once-only sync obligation
   * out of an omission — the rule `connect.ts` states.
   */
  async connectWabaWithToken(
    accountId: string,
    token: string,
    wabaId?: string,
  ): Promise<ManualConnectResult> {
    const account = requireAccountId(accountId, "accountId is required");

    // Defense in depth, throw-not-code, the `sendTemplateTest` pattern: the
    // dashboard validator is the strict one and the only caller, so reaching
    // these means it regressed. The messages name the SHAPE, never the value —
    // an error string carrying a live credential would be the one leak this
    // whole path is built to avoid.
    const businessToken = typeof token === "string" ? token.trim() : "";
    if (!businessToken) throw new Error("token is required");
    if (!META_TOKEN_PATTERN.test(businessToken)) throw new Error("token is malformed");
    const selector = wabaId?.trim() || undefined;
    if (selector !== undefined && !WABA_SELECTOR_PATTERN.test(selector)) {
      throw new Error("wabaId is malformed");
    }

    const publicOrigin = this.env.GATEWAY_PUBLIC_URL?.trim();
    // Same rule as `startConnectForAccountId`: there is no request to derive an
    // origin from, and a webhook callback URL guessed wrong is a number that
    // registers and then never delivers.
    if (!publicOrigin) throw new Error("GATEWAY_PUBLIC_URL is required to connect a pasted token");

    const appConfig = getAppConfig(this.env);
    let discovered: Awaited<ReturnType<typeof wabaMatchesForTargetIds>>;
    try {
      // Always first, selector or not: the two token verdicts gate every read,
      // and no id an operator types can make a foreign or dead token usable.
      const inspection = await inspectToken(appConfig, businessToken);
      if (inspection.kind !== "ok") {
        // The console owns the wording for both verdicts, and for `foreign_app`
        // it says something Meta's sentence does not: use Embedded Signup. So
        // no detail travels — Meta's text here would only compete with it.
        return { ok: false, code: inspection.kind, detail: null };
      }
      if (selector) {
        // Seed, not filter — see the method comment. `target_ids` is not
        // consulted at all here; Meta's answer to the read is the check.
        const probe = await probeWabaWithToken(appConfig, selector, businessToken);
        if (probe.kind === "no_access") {
          return { ok: false, code: "no_access", detail: probe.error.graphMessage };
        }
        if (probe.phones.length === 0) {
          return { ok: false, code: "no_phone", detail: null };
        }
        discovered = [{ wabaId: selector, phones: probe.phones }];
      } else {
        if (inspection.targetIds.length === 0) {
          // Real and measured: `granular_scopes[].target_ids` is nullable. A
          // question, not a verdict — the console asks for the id.
          return { ok: false, code: "no_waba", detail: null };
        }
        discovered = await wabaMatchesForTargetIds(appConfig, inspection.targetIds, businessToken);
        if (discovered.length === 0) {
          return { ok: false, code: "no_waba", detail: null };
        }
        // Ambiguity NEVER auto-attaches. A system-user token can see every WABA
        // a business manages, so registering them all on one paste would
        // mass-attach an agency's clients — the Embedded Signup semantics are
        // safe there only because the customer picked the account inside Meta's
        // own dialog. One extra round-trip on the resubmit is the price of
        // asking.
        if (discovered.length > 1) {
          return {
            ok: false,
            code: "multiple",
            detail: null,
            candidates: discovered.map((match) => ({
              wabaId: match.wabaId,
              phones: match.phones.map((phone) => ({
                phoneNumberId: phone.id,
                displayPhoneNumber: phone.display_phone_number ?? "",
              })),
            })),
          };
        }
      }
    } catch (err) {
      return { ok: false, code: "failed", detail: errorDetail(err) };
    }

    const result = await registerWabasForToken(this.env, (work) => this.ctx.waitUntil(work), {
      accountId: account,
      businessToken,
      callbackOrigin: publicOrigin,
      onboardingType: "standard",
      ...(selector ? { wabaSelector: selector } : {}),
      discovered,
    });
    if (result.ok) {
      const { ok: _ok, ...rest } = result;
      return { ok: true, ...rest };
    }
    // The shared path answers in the Embedded Signup vocabulary; only three of
    // its codes are reachable from here, and anything else is `failed` rather
    // than a code this surface has no words for. Its `no_waba` is now
    // unreachable by construction — `discovered` is never empty when we get
    // here — and stays mapped as defence, not as a live branch.
    const code =
      result.code === "no_waba" || result.code === "owned" ? result.code : "failed";
    return { ok: false, code, detail: result.error };
  }
}

/** An error's message, for a `detail` line. Never a token: the only values that
 * reach here are Graph's own sentences and this module's shape complaints. */
function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
