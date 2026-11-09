import { WorkerEntrypoint } from "cloudflare:workers";
import { getGatewayStubForWaba } from "./gateway-stub";
import { RECIPIENT_STATUSES, type RecipientStatus } from "./broadcasts";
import { SCHEDULE_KEY, SCHEDULED_STATUSES } from "./scheduled";
import { getControlPlaneStub } from "./control-plane-stub";
import {
  exchangeAndRegisterAll,
  registerWabasForToken,
  startConnectForAccount,
} from "./routes/connect";
import { inspectToken, probeWabaWithToken, wabaMatchesForTargetIds } from "./meta/connect-api";
import { diagnoseWaba } from "./meta/waba-diagnostics";
import { getAppConfig, tenantConfig, type TenantConfig } from "./tenant-config";
import { createTemplate, deleteTemplate, editTemplate, listTemplates } from "@eccos/core/templates";
import { isBsuid } from "@eccos/core/bsuid";
import { metaErrorCodes, sendMessage, sendOutcomeUnknown, type SendResult } from "@eccos/core/send";
import { isPublicConfigKey } from "./private-config-keys";
import { reconcileWaba, resubscribeWaba } from "./provisioning";
import { selectWaba } from "@eccos/gateway-contract/select-waba";
import { getMedia as getStoredMedia } from "./media-store";
import { isIdempotencyKey, sendBodyHash } from "./gateway";
import { checkSendRate } from "./send-rate-limit";
import type {
  AccountKeyResource,
  BroadcastDetail,
  BroadcastListOpts,
  BroadcastOpts,
  BroadcastSummary,
  AccountResources,
  ConnectExchangeResult,
  ConnectStartResult,
  ConversationListOpts,
  ConversationOpts,
  ConversationSummary,
  ThreadView,
  CreateTemplateFailureCode,
  CreateTemplateInput,
  CreateTemplateResult,
  EditTemplateFailureCode,
  EditTemplateInput,
  EditTemplateResult,
  CursorPage,
  DeleteTemplateInput,
  DeleteTemplateResult,
  DeliveryListOpts,
  DeliveryRecord,
  EraseByPhoneResult,
  GatewayExport,
  GatewayApi,
  GatewayStatus,
  Health,
  InboundListOpts,
  IssuedApiKey,
  InboundRow,
  ManualConnectResult,
  MediaObject,
  MediaRequest,
  MessageRecord,
  OperatorCounts,
  OutboundListOpts,
  OutboundRow,
  ReconcileWabaResult,
  ResubscribeResult,
  RetryFailedResult,
  RetryFailedWindow,
  SendTemplateTestInput,
  TemplateHeaderMediaFormat,
  SendTemplateTestResult,
  SendTestFailureCode,
  SendTextFailureCode,
  SendReactionInput,
  SendTextInput,
  SendTextResult,
  SetSubscriberConfigInput,
  SubscriberConfig,
  TemplatesResult,
  OrganizationAccountContext,
  ScheduledCancelResult,
  ScheduledListOpts,
  ScheduledPage,
  ScopedOrg,
  ScopedRead,
  AccountWabaResource,
} from "@eccos/gateway-contract";

/**
 * Delivery counts read as one word.
 *
 * `pending` is not a fault and never turns the gateway red: a backlog can simply
 * be waiting for a forwarding target the operator has not configured yet, which
 * the Durable Object's alarm holds rather than burns attempts against
 * (`gateway.ts`). Past ten such rows `degraded` is the honest report — events
 * are queued for a destination that does not exist yet, nothing is lost, and
 * the gateway is neither broken nor fine. A `failed` row, by contrast, means a
 * configured destination refused six times: that is `unhealthy`, and no held
 * state is allowed to reach this branch.
 */
function healthFromCounts(counts: OperatorCounts): Health {
  if ((counts.deliveries.failed ?? 0) > 0) return "unhealthy";
  if ((counts.deliveries.pending ?? 0) > 10 || (counts.outbound.failed ?? 0) > 0) return "degraded";
  return "healthy";
}

function publicConfig(config: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => isPublicConfigKey(key)));
}

/** Audit line for an operator sync recovery; ids only. */
function logOperatorSyncAction(
  event: string,
  accountId: string,
  wabaId: string,
  syncKind: "contacts" | "history",
  changed: boolean,
): void {
  console.log(JSON.stringify({ event, accountId, wabaId, syncKind, changed }));
}

/** Names the account and WABA an RPC call acts on. Workers Logs adds the RPC method to
 * the line, so console traffic can be attributed to a customer. Ids only. */
function logScope(accountId: string, wabaId: string): void {
  console.log(JSON.stringify({ level: "info", area: "rpc", event: "rpc_scope", accountId, wabaId }));
}

/** The `outbound_send` line of a console send, shaped like the HTTP route's. Ids and codes only. */
function logSend(source: string, wabaId: string, phoneNumberId: string, messageType: string, result: SendResult): void {
  const outcome = result.ok
    ? { ok: true, messageId: result.id }
    : { ok: false, httpStatus: result.status, ...metaErrorCodes(result.error) };
  console.log(
    JSON.stringify({ level: result.ok ? "info" : "error", area: "rpc", event: "outbound_send", source, wabaId, phoneNumberId, messageType, ...outcome }),
  );
}

function clampLimit(n: number | undefined, max: number, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), max) : fallback;
}

function requireAccountId(accountId: string | undefined, message: string): string {
  const id = accountId?.trim();
  if (!id) throw new Error(message);
  return id;
}

/** Digits only, E.164's 15-digit ceiling. The console normalizes; this re-checks. */
const TO_PATTERN = /^[0-9]{5,15}$/;
const TO_ERROR = "to must be 5-15 digits or a BSUID";
/** Meta's own template-name charset. */
const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
/** `en` / `es` / `en_US` / `pt_BR`. */
const LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const MAX_BODY_PARAMS = 30;
const MAX_BODY_PARAM_LENGTH = 1024;
/** Meta's ceiling for a free-text message body. */
const MAX_TEXT_LENGTH = 4096;
/** Code units a reaction's emoji may span; the one-grapheme rule is the dashboard validator's. */
const MAX_EMOJI_LENGTH = 32;
/** A BUTTONS component carries at most 3 URL buttons — the same cap the
 * create validator applies, so a later-created template can always be sent. */
const MAX_BUTTON_PARAMS = 3;
/** Upper bound for a URL button's 0-based slot index in the BUTTONS
 * component. Meta caps BUTTONS at 3 buttons, so this is a loose ceiling that
 * exists to bound the index, not to mirror Meta's exact count. */
const MAX_BUTTON_URL_INDEX = 9;
/** The header formats a template can carry that a single link can fill. */
const HEADER_MEDIA_FORMATS: TemplateHeaderMediaFormat[] = ["image", "video", "document"];
const MAX_HEADER_LINK_LENGTH = 2048;
/** Meta's body ceiling for a template component. */
const MAX_TEMPLATE_BODY_LENGTH = 1024;
/** Meta documents ~60 chars for a footer; the console's create validator uses
 * the same explicit ceiling so the gateway's mirrored throw is reachable only
 * by a regressed caller. */
const MAX_FOOTER_LENGTH = 60;
/** A BUTTONS component takes at most 3 URL buttons (Meta's own cap). */
const MAX_CREATE_BUTTONS = 3;
/** Meta's conservative button label ceiling — the console validates the same
 * figure, and a longer label is refused at create time, never at send. */
const MAX_BUTTON_TEXT_LENGTH = 25;
/** Ceiling for a URL or an example URL on a URL button. */
const MAX_BUTTON_URL_LENGTH = 2000;
/** Graph template ids (`hsm_id`) are numeric. */
const TEMPLATE_ID_PATTERN = /^[0-9]{1,32}$/;
/** What the console's template list reads. Named explicitly: quality, rejection
 * reason and last edit are not in Meta's default response. */
const TEMPLATE_LIST_FIELDS = [
  "id",
  "name",
  "language",
  "status",
  "category",
  "sub_category",
  "previous_category",
  "components",
  "parameter_format",
  "rejected_reason",
  "quality_score",
  "last_updated_time",
] as const;
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

/** The free-text send vocabulary: the window refusal is the one a composer must name. */
const TEXT_GRAPH_ERROR_CODES: Record<number, SendTextFailureCode> = {
  131030: "recipient_not_allowlisted",
  131047: "window_closed",
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

/** The content rules shared by create and edit: body, examples, footer, URL buttons. */
function assertTemplateContent(input: Pick<CreateTemplateInput, "bodyText" | "bodyExamples" | "footerText" | "buttons">) {
  const examples = input.bodyExamples ?? [];
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
  const footerText = input.footerText;
  if (footerText !== undefined) {
    if (typeof footerText !== "string" || footerText.length === 0) {
      throw new Error("footer text is required when present");
    }
    if (footerText.length > MAX_FOOTER_LENGTH) throw new Error("footer text is too long");
    if (/[\n\t]/.test(footerText)) throw new Error("footer text must not contain newlines or tabs");
    if (/\{\{/.test(footerText)) throw new Error("footer text cannot contain placeholders");
  }
  const buttons = input.buttons ?? [];
  if (buttons.length > MAX_CREATE_BUTTONS) throw new Error("a template can carry at most 3 buttons");
  for (const button of buttons) {
    if (typeof button !== "object" || button === null) {
      throw new Error("buttons must be objects");
    }
    const { text, url, exampleUrl } = button as {
      text?: unknown;
      url?: unknown;
      exampleUrl?: unknown;
    };
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_BUTTON_TEXT_LENGTH) {
      throw new Error("button text must be 1-25 characters");
    }
    if (typeof url !== "string" || url.length === 0 || url.length > MAX_BUTTON_URL_LENGTH) {
      throw new Error("button url is required");
    }
    if (!/^https?:\/\//.test(url)) throw new Error("button url must be http(s)");
    if (/[\n\t]/.test(text) || /[\n\t]/.test(url)) {
      throw new Error("button text and url cannot contain newlines or tabs");
    }
    const dynamic = url.includes("{{");
    if (dynamic && (typeof exampleUrl !== "string" || exampleUrl.length === 0)) {
      throw new Error("a dynamic URL button requires an example url");
    }
    if (exampleUrl !== undefined && typeof exampleUrl !== "string") {
      throw new Error("button example url must be a string");
    }
  }
  return { examples, footerText, buttons };
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
   * is not safe that way and stays active-only: sends, logs and status keep
   * `getWaba`; erasure and export check ownership only (`ownedStub`). Ownership
   * is enforced either way — `getWabaRecord` is account-scoped too. */
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
    logScope(account, waba.wabaId);
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
    return this.statusOf(stub, scopedWabaId, phoneNumberId, displayPhone, provisionedAt);
  }

  private async statusOf(
    stub: ReturnType<GatewayRPC["stubFor"]>,
    wabaId: string,
    phoneNumberId: string | null,
    displayPhone: string | null,
    provisionedAt: number | null,
  ): Promise<GatewayStatus> {
    const counts = await stub.getCounts();
    return {
      name: "eccos",
      version: "0.1.0",
      health: healthFromCounts(counts),
      connection: {
        wabaId,
        phoneNumberId,
        displayPhone,
        connectedAt: provisionedAt === null ? null : new Date(provisionedAt).toISOString(),
      },
      counts,
    };
  }

  /**
   * Organization-scoped read: one control-plane hop, then the WABA is selected
   * and its ownership enforced HERE with the shared `selectWaba`. The
   * `organizationId` is the one the console's auth layer validated — the same
   * trust the other methods place in the console's `accountId`.
   */
  private async selected(org: ScopedOrg) {
    const orgId = requireAccountId(org?.organizationId, "organizationId is required");
    const { accountId, resources } = await getControlPlaneStub(this.env).resolveOrganizationContext(orgId);
    const waba = selectWaba(accountId, resources.wabas, org.wabaId, org.rejectUnknown, org.mode);
    logScope(accountId, waba.wabaId);
    const scope = { accountId, wabaId: waba.wabaId, resources };
    return { waba, scope, stub: this.stubFor(waba.wabaId) };
  }

  async readStatus(org: ScopedOrg): Promise<ScopedRead<GatewayStatus>> {
    const { waba, scope, stub } = await this.selected(org);
    return { scope, data: await this.statusOfWaba(stub, waba) };
  }

  private statusOfWaba(stub: ReturnType<GatewayRPC["stubFor"]>, waba: AccountWabaResource) {
    const first = [...waba.phones].sort((a, b) => a.phoneNumberId.localeCompare(b.phoneNumberId))[0];
    return this.statusOf(
      stub,
      waba.wabaId,
      first?.phoneNumberId || null,
      first?.displayPhoneNumber || null,
      waba.provisionedAt ?? null,
    );
  }

  async readInbound(org: ScopedOrg, opts: Omit<InboundListOpts, "wabaId">): Promise<ScopedRead<InboundRow[]>> {
    const { scope, stub } = await this.selected(org);
    return { scope, data: await stub.listInbound(opts) };
  }

  async readOutbound(org: ScopedOrg, opts: Omit<OutboundListOpts, "wabaId">): Promise<ScopedRead<OutboundRow[]>> {
    const { scope, stub } = await this.selected(org);
    return { scope, data: await stub.listOutbound(opts) };
  }

  async readDeliveries(
    org: ScopedOrg,
    opts: Omit<DeliveryListOpts, "wabaId">,
  ): Promise<ScopedRead<DeliveryRecord[]>> {
    const { scope, stub } = await this.selected(org);
    return { scope, data: await stub.listDeliveries(opts) };
  }

  async readBroadcasts(
    org: ScopedOrg,
    opts: BroadcastListOpts,
  ): Promise<ScopedRead<CursorPage<BroadcastSummary>>> {
    const { scope, stub } = await this.selected(org);
    const limit = clampLimit(opts?.limit, 50, 20);
    const { items, hasMore } = await stub.listBroadcastPage(scope.accountId, limit, opts?.cursor);
    return { scope, data: { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null } };
  }

  async readBroadcast(org: ScopedOrg, opts: BroadcastOpts): Promise<ScopedRead<BroadcastDetail | null>> {
    const { scope, stub } = await this.selected(org);
    const id = requireAccountId(opts?.broadcastId, "broadcastId is required");
    if (opts.status !== undefined && !RECIPIENT_STATUSES.has(opts.status)) throw new Error("invalid status");
    const after = opts.cursor === undefined ? undefined : Number(opts.cursor);
    if (after !== undefined && !(Number.isSafeInteger(after) && after >= 0)) throw new Error("invalid cursor");
    const limit = clampLimit(opts.limit, 500, 100);
    const broadcast = await stub.getBroadcast(scope.accountId, id);
    if (!broadcast) return { scope, data: null };
    const rows =
      (await stub.listBroadcastRecipients(scope.accountId, id, {
        ...(opts.status ? { status: opts.status as RecipientStatus } : {}),
        ...(after !== undefined ? { after } : {}),
        limit: limit + 1,
      })) ?? [];
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor = rows.length > limit && last ? String(last.seq) : null;
    return { scope, data: { broadcast, recipients: { items, nextCursor } } };
  }

  async cancelBroadcast(
    input: { wabaId: string; broadcastId: string },
    accountId: string,
  ): Promise<BroadcastSummary | null> {
    // Ownership only, whatever the WABA's status: stopping sends is always safe.
    const stub = await this.ownedStub(input.wabaId, accountId);
    return stub.cancelBroadcast(accountId, input.broadcastId);
  }

  async readScheduled(org: ScopedOrg, opts: ScheduledListOpts): Promise<ScopedRead<ScheduledPage>> {
    const { scope, stub } = await this.selected(org);
    const status = opts?.status ?? "pending";
    if (!SCHEDULED_STATUSES.has(status)) throw new Error("invalid status");
    if (opts?.cursor !== undefined && !SCHEDULE_KEY.test(opts.cursor)) throw new Error("invalid cursor");
    const limit = clampLimit(opts?.limit, 100, 50);
    const { items, hasMore, counts } = await stub.listScheduledPage(scope.accountId, {
      status,
      cursor: opts?.cursor,
      limit,
    });
    return { scope, data: { items, counts, nextCursor: hasMore ? (items.at(-1)?.key ?? null) : null } };
  }

  async cancelScheduled(input: { wabaId: string; key: string }, accountId: string): Promise<ScheduledCancelResult> {
    // Ownership only, whatever the WABA's status: stopping a send is always safe.
    if (!SCHEDULE_KEY.test(input?.key ?? "")) throw new Error("invalid key");
    const stub = await this.ownedStub(input.wabaId, accountId);
    const { state, scheduled } = await stub.cancelScheduled(accountId, input.key);
    return { state, scheduled };
  }

  async readConversations(
    org: ScopedOrg,
    opts: Omit<ConversationListOpts, "wabaId">,
  ): Promise<ScopedRead<CursorPage<ConversationSummary>>> {
    const { scope, stub } = await this.selected(org);
    return { scope, data: await stub.listConversations(opts) };
  }

  async readConversation(
    org: ScopedOrg,
    opts: Omit<ConversationOpts, "wabaId">,
  ): Promise<ScopedRead<CursorPage<MessageRecord>>> {
    const { scope, stub } = await this.selected(org);
    return { scope, data: await stub.getConversation(opts) };
  }

  async readThreadView(org: ScopedOrg, opts: Omit<ConversationOpts, "wabaId">): Promise<ScopedRead<ThreadView>> {
    const { scope, stub } = await this.selected(org);
    return { scope, data: await stub.getThreadView(opts) };
  }

  async markConversation(org: ScopedOrg, opts: { waId: string; read: boolean }): Promise<ScopedRead<void>> {
    const { scope, stub } = await this.selected(org);
    await stub.markConversation(opts);
    return { scope, data: undefined };
  }

  async readSubscriberConfig(org: ScopedOrg): Promise<ScopedRead<SubscriberConfig>> {
    const { scope, stub } = await this.selected(org);
    return { scope, data: await stub.getSubscriberConfig() };
  }

  async readDashboardState(org: Pick<ScopedOrg, "organizationId" | "wabaId">) {
    const orgId = requireAccountId(org?.organizationId, "organizationId is required");
    const { accountId, resources } = await getControlPlaneStub(this.env).resolveOrganizationContext(orgId);
    // No active WABA is "nothing to read yet", not a failure (see the console's root loader).
    if (resources.wabas.every((waba) => waba.status !== "active")) {
      return { accountId, resources, status: null };
    }
    const waba = selectWaba(accountId, resources.wabas, org.wabaId);
    logScope(accountId, waba.wabaId);
    const scope = { accountId, wabaId: waba.wabaId, resources };
    return { accountId, resources, status: { scope, data: await this.statusOfWaba(this.stubFor(waba.wabaId), waba) } };
  }

  async getConfig(wabaId: string, accountId: string): Promise<Record<string, string>> {
    const { stub } = await this.scoped(wabaId, accountId);
    return publicConfig(await stub.getAllConfig());
  }

  async listInbound(opts: InboundListOpts, accountId: string): Promise<InboundRow[]> {
    const { stub } = await this.scoped(opts.wabaId, accountId);
    return stub.listInbound(opts);
  }

  async listOutbound(opts: OutboundListOpts, accountId: string): Promise<OutboundRow[]> {
    const { stub } = await this.scoped(opts.wabaId, accountId);
    return stub.listOutbound(opts);
  }

  // Conversation store (eccos-yqbz.2): the per-number read model over `messages`.
  async listConversations(opts: ConversationListOpts, accountId: string): Promise<CursorPage<ConversationSummary>> {
    const { stub } = await this.scoped(opts.wabaId, accountId);
    return stub.listConversations(opts);
  }

  async getConversation(opts: ConversationOpts, accountId: string): Promise<CursorPage<MessageRecord>> {
    const { stub } = await this.scoped(opts.wabaId, accountId);
    return stub.getConversation(opts);
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

  /** Bulk re-enqueue of failed deliveries inside an explicit window (eccos-r92o). */
  async retryFailedDeliveries(
    window: RetryFailedWindow,
    wabaId: string,
    accountId: string,
  ): Promise<RetryFailedResult> {
    const { stub } = await this.scoped(wabaId, accountId);
    return stub.retryFailedDeliveries(window.from, window.to);
  }

  /** WABA-level read: the Graph call needs only the WABA id and its token, so a
   * connected-but-unprovisioned WABA can list its templates. */
  async listTemplates(wabaId: string, limit: number | undefined, accountId: string): Promise<TemplatesResult> {
    const { config: cfg } = await this.scoped(wabaId, accountId, { anyStatus: true });
    const result = await listTemplates(cfg, limit, { fields: TEMPLATE_LIST_FIELDS });
    // The review fields are extras: if Meta ever refuses one of them, the list
    // still loads with its default fields rather than not at all.
    if (!result.ok && graphError(result.error).code === 100) return listTemplates(cfg, limit);
    return result;
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
    if (!TEMPLATE_NAME_PATTERN.test(input.name)) throw new Error("invalid template name");
    if (!LANGUAGE_PATTERN.test(input.language)) throw new Error("invalid template language");
    if (!TEMPLATE_CATEGORIES.has(input.category)) throw new Error("invalid template category");
    const { examples, footerText, buttons } = assertTemplateContent(input);

    const result = await createTemplate(cfg, {
      name: input.name,
      language: input.language,
      category: input.category,
      bodyText: input.bodyText,
      ...(examples.length > 0 ? { examples } : {}),
      ...(footerText !== undefined ? { footerText } : {}),
      ...(buttons.length > 0 ? { buttons } : {}),
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

  /**
   * Replace one translation's content ("Edit"). Same reachability, role and
   * limiter stance as {@link GatewayRPC.createTemplate}.
   *
   * Meta's edit is addressed to the template id alone, so the id is first
   * looked up among THIS WABA's templates of that name and language: a token
   * that can reach another WABA's template must still not edit it from here.
   */
  async editTemplate(input: EditTemplateInput, accountId: string): Promise<EditTemplateResult> {
    const { config: cfg } = await this.scoped(input.wabaId, accountId, { anyStatus: true });
    if (!TEMPLATE_NAME_PATTERN.test(input.name)) throw new Error("invalid template name");
    if (!LANGUAGE_PATTERN.test(input.language)) throw new Error("invalid template language");
    if (!TEMPLATE_ID_PATTERN.test(input.templateId)) throw new Error("invalid template id");
    if (input.category !== undefined && !TEMPLATE_CATEGORIES.has(input.category)) {
      throw new Error("invalid template category");
    }
    const { examples, footerText, buttons } = assertTemplateContent(input);

    const found = await listTemplates(cfg, 100, { fields: ["id", "name", "language"], name: input.name });
    if (!found.ok) {
      const { message } = graphError(found.error);
      return { ok: false, code: "graph", detail: message ?? `HTTP ${found.status}` };
    }
    const rows =
      (found.data as { data?: { id?: unknown; name?: unknown; language?: unknown }[] } | null)?.data ?? [];
    const owned = rows.some(
      (row) => row.id === input.templateId && row.name === input.name && row.language === input.language,
    );
    if (!owned) {
      return { ok: false, code: "not_found", detail: null };
    }

    const result = await editTemplate(cfg, input.templateId, {
      bodyText: input.bodyText,
      ...(examples.length > 0 ? { examples } : {}),
      ...(footerText !== undefined ? { footerText } : {}),
      ...(buttons.length > 0 ? { buttons } : {}),
      ...(input.category ? { category: input.category } : {}),
    });
    if (!result.ok) {
      const { code, message } = graphError(result.error);
      const mapped: EditTemplateFailureCode =
        code === 80008 ? "rate_limited" : code === 100 ? "invalid" : "graph";
      return { ok: false, code: mapped, detail: message ?? `HTTP ${result.status}` };
    }
    return { ok: true };
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

  /** Operator-visible forwarding target (DO config only). Never returns the secret.
   * WABA-level: the forwarding target is what you set up BEFORE traffic exists.
   * Carries `lastForward` — the newest delivery row — so the console can answer
   * "is my receiver getting events?" without a second round-trip. */
  async getSubscriberConfig(wabaId: string, accountId: string): Promise<SubscriberConfig> {
    const { stub } = await this.scoped(wabaId, accountId, { anyStatus: true });
    return stub.getSubscriberConfig();
  }

  /** Write the forwarding target. Persists to DO config; see
   * {@link SetSubscriberConfigInput} for what each field means — a null `url`
   * removes the target and a null `secret` removes the secret, as separate
   * intentions. WABA-level, and safe in the awaiting-a-phone state: the
   * provisioning saga's own `saveConfig` writes only the META_ and CONNECTED_AT
   * keys, so a SUBSCRIBER_ value written here survives the WABA turning active. */
  async setSubscriberConfig(
    input: SetSubscriberConfigInput,
    wabaId: string,
    accountId: string,
  ): Promise<{ ok: true }> {
    const { stub } = await this.scoped(wabaId, accountId, { anyStatus: true });
    await stub.setSubscriberConfig(input);
    return { ok: true };
  }

  /** Right-to-erasure (GDPR Art. 17): delete/redact every stored trace of a customer,
   * named by phone number or by BSUID. Returns per-table counts as erasure evidence. */
  async eraseByPhone(phone: string, wabaId: string, accountId: string): Promise<EraseByPhoneResult> {
    return (await this.ownedStub(wabaId, accountId)).eraseByPhone(phone);
  }

  async exportData(wabaId: string, accountId: string): Promise<GatewayExport> {
    return (await this.ownedStub(wabaId, accountId)).exportData();
  }

  /** Ownership only, whatever the WABA's status: erasure and export must reach the content
   * held while it is not active (held-webhooks.ts). */
  private async ownedStub(wabaId: string, accountId: string) {
    const account = requireAccountId(accountId, "accountId is required");
    if (!(await getControlPlaneStub(this.env).ownsWaba(account, wabaId))) {
      throw new Error(`WABA "${wabaId}" is not owned by account "${account}"`);
    }
    logScope(account, wabaId);
    return this.stubFor(wabaId);
  }

  /** A stored WhatsApp media object, streamed from R2. Account-scoped like every data-plane
   * read: a WABA the account does not own fails closed before R2 is touched. Only a media id
   * whose state is `stored` is served; an erased one may still have its object until the purge. */
  async getMedia(input: MediaRequest, accountId: string): Promise<MediaObject | null> {
    const { stub, wabaId } = await this.scoped(input.wabaId, accountId);
    if (!(await stub.isMediaStored(input.mediaId))) return null;
    const stored = await getStoredMedia(this.env.MEDIA, wabaId, input.mediaId, input.range);
    if (!stored) return null;
    return {
      body: stored.body,
      contentType: stored.contentType ?? "application/octet-stream",
      size: stored.size,
      range: stored.range,
    };
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
   * Operator-only: outside `GatewayApi`, so the console's types do not expose it,
   * but the dashboard binds this same entrypoint. See `docs/operations.md`, "Coexistence sync failures".
   */
  async resetUnconfirmedCoexistenceSync(
    wabaId: string,
    accountId: string,
    syncKind: "contacts" | "history",
  ): Promise<boolean> {
    const account = requireAccountId(accountId, "accountId is required");
    try {
      const changed = await getControlPlaneStub(this.env).resetUnconfirmedCoexistenceSync(
        account,
        wabaId,
        syncKind,
      );
      logOperatorSyncAction("coexistence_sync_reset", account, wabaId, syncKind, changed);
      return changed;
    } catch (err) {
      logOperatorSyncAction("coexistence_sync_reset_refused", account, wabaId, syncKind, false);
      throw err;
    }
  }

  /** Operator-only and outside `GatewayApi`, like the reset above. */
  async settleCoexistenceSyncNotPermitted(
    wabaId: string,
    accountId: string,
    syncKind: "contacts" | "history",
  ): Promise<boolean> {
    const account = requireAccountId(accountId, "accountId is required");
    const changed = await getControlPlaneStub(this.env).settleCoexistenceSyncNotPermitted(
      account,
      wabaId,
      syncKind,
    );
    logOperatorSyncAction("coexistence_sync_settled_not_permitted", account, wabaId, syncKind, changed);
    return changed;
  }

  /** Operator-only and outside `GatewayApi`, like the reset above: read-only Graph view of a WABA. */
  async diagnoseWaba(wabaId: string, accountId: string) {
    const account = requireAccountId(accountId, "accountId is required");
    const waba = await getControlPlaneStub(this.env).getWabaRecord(account, wabaId);
    if (!waba) throw new Error(`WABA "${wabaId}" is not owned by account "${account}"`);
    return diagnoseWaba(
      getAppConfig(this.env),
      waba.wabaId,
      waba.phones[0]?.phoneNumberId ?? null,
      waba.metaAccessToken,
    );
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
    const buttonParams = input.buttonParams ?? [];
    if (!TO_PATTERN.test(input.to) && !isBsuid(input.to)) throw new Error(TO_ERROR);
    if (!TEMPLATE_NAME_PATTERN.test(input.templateName)) throw new Error("invalid templateName");
    if (!LANGUAGE_PATTERN.test(input.languageCode)) throw new Error("invalid languageCode");
    if (bodyParams.length > MAX_BODY_PARAMS) throw new Error("too many body parameters");
    for (const value of bodyParams) {
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_BODY_PARAM_LENGTH) {
        throw new Error("body parameters must be 1-1024 characters");
      }
      if (/[\n\t]/.test(value)) throw new Error("body parameters must not contain newlines or tabs");
    }
    if (buttonParams.length > MAX_BUTTON_PARAMS) throw new Error("too many button parameters");
    for (const button of buttonParams) {
      if (typeof button !== "object" || button === null) throw new Error("button parameters must be objects");
      const { index, text } = button as { index?: unknown; text?: unknown };
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > MAX_BUTTON_URL_INDEX) {
        throw new Error("button parameter index must be an integer 0-9");
      }
      if (typeof text !== "string" || text.length === 0 || text.length > MAX_BODY_PARAM_LENGTH) {
        throw new Error("button parameter text must be 1-1024 characters");
      }
      if (/[\n\t]/.test(text)) throw new Error("button parameters must not contain newlines or tabs");
    }
    const headerMedia = input.headerMedia;
    if (headerMedia !== undefined) {
      if (typeof headerMedia !== "object" || headerMedia === null) {
        throw new Error("headerMedia must be an object");
      }
      if (!HEADER_MEDIA_FORMATS.includes(headerMedia.format)) {
        throw new Error("headerMedia format must be image, video or document");
      }
      const link = headerMedia.link;
      if (typeof link !== "string" || link.length === 0 || link.length > MAX_HEADER_LINK_LENGTH) {
        throw new Error("headerMedia link must be 1-2048 characters");
      }
      // `https` only. Meta dereferences this from its own network, so `http`
      // leaks the asset in transit and no other scheme is fetchable at all.
      // Eccos never opens it — this checks the string and nothing more.
      if (!link.startsWith("https://")) throw new Error("headerMedia link must be https");
      if (/[\s]/.test(link)) throw new Error("headerMedia link must not contain whitespace");
    }

    if (!(await checkSendRate(this.env, account, waba.wabaId))) {
      return { ok: false, code: "rate_limited", detail: null };
    }

    const components: Record<string, unknown>[] = [];
    // Header first, which is both Meta's documented order and the order the
    // message renders in. `{ type: "image", image: { link } }` — Meta fetches
    // the link itself, so this path uploads nothing and Eccos makes no request
    // of its own.
    if (headerMedia) {
      components.push({
        type: "header",
        parameters: [{ type: headerMedia.format, [headerMedia.format]: { link: headerMedia.link } }],
      });
    }
    if (bodyParams.length > 0) {
      components.push({
        type: "body",
        parameters: bodyParams.map((text) => ({ type: "text", text })),
      });
    }
    // One component per button param, after the body — lowercase orthography,
    // exactly like `body` above: UPPER is the CREATE-side Graph shape, this is
    // the SEND-side one. A wrong fill maps to parameter_mismatch via
    // GRAPH_ERROR_CODES; the console validator plus the re-checks above are what
    // keep a wrong fill from getting here.
    for (const button of buttonParams) {
      components.push({
        type: "button",
        sub_type: "url",
        index: String(button.index),
        parameters: [{ type: "text", text: button.text }],
      });
    }

    const metaBody: Record<string, unknown> = {
      to: input.to,
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
        ...(components.length > 0 ? { components } : {}),
      },
    };

    const cfg = tenantConfig(getAppConfig(this.env), {
      wabaId: waba.wabaId,
      phoneNumberId: input.phoneNumberId,
      metaAccessToken: waba.metaAccessToken,
    });
    const stub = this.stubFor(waba.wabaId);
    const keyed = { key: input.idempotencyKey, bodyHash: await sendBodyHash(input.phoneNumberId, metaBody) };
    return this.sendOnce(stub, account, waba.wabaId, keyed, async (): Promise<SendTemplateTestResult> => {
      const result = await sendMessage(cfg, metaBody);
      logSend("send_test", waba.wabaId, input.phoneNumberId, "template", result);

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
        if (sendOutcomeUnknown(result)) return { ok: false, code: "unknown", detail: null };
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
        result.waId,
      );
      return { ok: true, messageId: result.id };
    });
  }

  /**
   * Send one free-text message from the conversation composer.
   *
   * Mirrors `sendTemplateTest` on every rule that matters (see
   * {@link sendConsoleMessage}). Free-form bodies are only deliverable inside
   * Meta's 24-hour customer service window, so 131047 is an expected answer the
   * console turns into "send a template", not a fault to chase.
   */
  async sendText(input: SendTextInput, accountId: string): Promise<SendTextResult> {
    if (typeof input.text !== "string" || input.text.length === 0 || input.text.length > MAX_TEXT_LENGTH) {
      throw new Error("text must be 1-4096 characters");
    }
    return this.sendConsoleMessage(accountId, input, "send_text", {
      to: input.to,
      type: "text",
      text: { body: input.text, preview_url: false },
      ...(input.replyToMessageId ? { context: { message_id: input.replyToMessageId } } : {}),
    });
  }

  /** React to one message from the conversation: `emoji` "" removes the reaction. */
  async sendReaction(input: SendReactionInput, accountId: string): Promise<SendTextResult> {
    if (typeof input.messageId !== "string" || input.messageId === "") throw new Error("messageId is required");
    if (typeof input.emoji !== "string" || input.emoji.length > MAX_EMOJI_LENGTH) {
      throw new Error("emoji must be one emoji, or empty");
    }
    return this.sendConsoleMessage(accountId, input, "send_reaction", {
      to: input.to,
      type: "reaction",
      reaction: { message_id: input.messageId, emoji: input.emoji },
    });
  }

  /**
   * The send both console messages share: the same `getWaba` ownership read (a
   * non-active WABA fails closed), the same `accountId:wabaId` limiter key, the
   * same idempotent claim and the same outbound row. `metaBody` is the Graph
   * message object, built by the caller from the validated input.
   */
  private async sendConsoleMessage(
    accountId: string,
    input: { wabaId: string; phoneNumberId: string; to: string; idempotencyKey?: string },
    source: "send_text" | "send_reaction",
    metaBody: Record<string, unknown>,
  ): Promise<SendTextResult> {
    const account = requireAccountId(accountId, "accountId is required");
    const waba = await getControlPlaneStub(this.env).getWaba(account, input.wabaId);
    if (!waba) throw new Error(`WABA "${input.wabaId}" is not owned by account "${account}"`);

    if (!waba.phones.some((phone) => phone.phoneNumberId === input.phoneNumberId)) {
      return {
        ok: false,
        code: "no_phone",
        detail: `phone "${input.phoneNumberId}" is not registered on this WhatsApp Business account`,
      };
    }

    // Defense in depth: the dashboard validator is the strict one, so a failure here
    // is a regressed caller, not a UI state.
    if (!TO_PATTERN.test(input.to) && !isBsuid(input.to)) throw new Error(TO_ERROR);

    if (!(await checkSendRate(this.env, account, waba.wabaId))) {
      return { ok: false, code: "rate_limited", detail: null };
    }

    const cfg = tenantConfig(getAppConfig(this.env), {
      wabaId: waba.wabaId,
      phoneNumberId: input.phoneNumberId,
      metaAccessToken: waba.metaAccessToken,
    });
    const stub = this.stubFor(waba.wabaId);
    const keyed = { key: input.idempotencyKey, bodyHash: await sendBodyHash(input.phoneNumberId, metaBody) };
    return this.sendOnce(stub, account, waba.wabaId, keyed, async (): Promise<SendTextResult> => {
      const result = await sendMessage(cfg, metaBody);
      logSend(source, waba.wabaId, input.phoneNumberId, String(metaBody.type), result);

      if (!result.ok) {
        await stub.logOutbound(
          null,
          input.to,
          JSON.stringify(metaBody),
          "failed",
          JSON.stringify(result.error),
          input.phoneNumberId,
        );
        if (sendOutcomeUnknown(result)) return { ok: false, code: "unknown", detail: null };
        const { code, message } = graphError(result.error);
        const mapped = code === null ? undefined : TEXT_GRAPH_ERROR_CODES[code];
        return { ok: false, code: mapped ?? "graph", detail: message ?? `HTTP ${result.status}` };
      }

      await stub.logOutbound(
        result.id,
        input.to,
        JSON.stringify(metaBody),
        "sent",
        null,
        input.phoneNumberId,
        result.waId,
      );
      return { ok: true, messageId: result.id };
    });
  }

  /**
   * Runs `send` at most once per (account, key) on the WABA's Durable Object.
   * The claim is stored before `send` runs, so a concurrent duplicate gets
   * `in_progress` and sends nothing; a later one gets the stored result back.
   * Every answer is stored, a Meta refusal included: a retry with the same key
   * never resends, and sending again is a new key. An `unknown` outcome is not
   * stored, so the key stays pending and a retry gets `in_progress`. A key reused
   * for another body gets `key_reused`. No key: `send` just runs.
   */
  private async sendOnce<T extends SendTemplateTestResult | SendTextResult>(
    stub: ReturnType<GatewayRPC["stubFor"]>,
    accountId: string,
    wabaId: string,
    { key, bodyHash }: { key: string | undefined; bodyHash: string },
    send: () => Promise<T>,
  ): Promise<T | { ok: false; code: "in_progress" | "key_reused"; detail: null }> {
    if (key === undefined) return send();
    if (!isIdempotencyKey(key)) throw new Error("invalid idempotencyKey");
    const claim = await stub.claimSendKey(accountId, key, bodyHash);
    if (claim.state === "pending") return { ok: false, code: "in_progress", detail: null };
    if (claim.state === "reused") return { ok: false, code: "key_reused", detail: null };
    if (claim.state === "done") {
      console.log(JSON.stringify({ level: "info", area: "rpc", event: "outbound_send", wabaId, deduped: true }));
      return JSON.parse(claim.result) as T;
    }
    const result = await send();
    if (result.ok || result.code !== "unknown") await stub.settleSendKey(accountId, key, JSON.stringify(result));
    return result;
  }

  /** One control-plane hop from organization to account + resources (see
   * {@link GatewayApi.resolveOrganizationScope}). */
  async resolveOrganizationScope(organizationId: string): Promise<OrganizationAccountContext> {
    return getControlPlaneStub(this.env).resolveOrganizationContext(organizationId);
  }

  /** Enumerate the durable resources owned by one account (registry). */
  async listAccountResources(accountId: string): Promise<AccountResources> {
    const account = requireAccountId(accountId, "accountId is required");
    return getControlPlaneStub(this.env).listAccountResources(account);
  }

  async getPublicOrigin(): Promise<string | null> {
    return this.env.GATEWAY_PUBLIC_URL?.trim() || null;
  }

  /** Account-key management for the console (eccos-bm92): the same control-plane
   * methods the admin HTTP routes use, scoped to the dashboard-resolved account. */
  async listApiKeys(accountId: string): Promise<AccountKeyResource[]> {
    const account = requireAccountId(accountId, "accountId is required");
    return getControlPlaneStub(this.env).listApiKeys(account);
  }

  async issueApiKey(accountId: string, label?: string): Promise<IssuedApiKey> {
    const account = requireAccountId(accountId, "accountId is required");
    return getControlPlaneStub(this.env).issueApiKey(account, label);
  }

  async revokeApiKey(accountId: string, keyId: string): Promise<boolean> {
    const account = requireAccountId(accountId, "accountId is required");
    return getControlPlaneStub(this.env).revokeApiKey(account, keyId);
  }

  /** Conversation retention for the account: null keeps conversations forever. */
  async getConversationRetention(accountId: string): Promise<number | null> {
    const account = requireAccountId(accountId, "accountId is required");
    return getControlPlaneStub(this.env).getConversationRetentionDays(account);
  }

  /** Stores the account's conversation retention. The control plane is the only copy. */
  async setConversationRetention(accountId: string, days: number | null): Promise<number | null> {
    const account = requireAccountId(accountId, "accountId is required");
    return getControlPlaneStub(this.env).setConversationRetentionDays(account, days);
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
