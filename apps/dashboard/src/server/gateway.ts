import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import type { Auth } from "../auth/auth";
import { getAuthForRequest } from "../auth/request-auth";
import { auditEvent } from "./audit";
import { funnelLedgerFailed, noteConnectError, scheduleRecovery } from "./funnel-recovery";
import { billingPage, billingReturnUrl, billingState, checkoutUrl, portalUrl, type BillingPage, type BillingState } from "../billing/account";
import { syncSubscription } from "../billing/webhook";
import { billingEnabled } from "../billing/config";
import { billingFor, type Billing } from "../billing/context";
import { selectWaba, type ScopeMode } from "@eccos/gateway-contract/select-waba";
import { blocksSends } from "@eccos/gateway-contract/billing-status";
import { linkPeople } from "./connect-link-people";
import { timedProxy } from "./timing";
import { classifyFailure } from "./classify-failure";
import { connectAudit } from "../lib/connect-result";
import { CONNECT_LINK_PATH } from "../lib/connect-link/api";
import { linkIsLive } from "../lib/connect-link/status";
import {
  type EmbeddedSignupConfig,
  embeddedSignupConfig,
  validateCodeAndState,
  validateSessionEvent,
} from "../lib/embedded-signup";
import { normalizeBroadcastId, normalizeRecipientStatus, normalizeSeqCursor } from "../lib/broadcasts";
import { normalizeScheduledStatus, normalizeScheduleKey } from "../lib/scheduled";
// The console's template rules, shared with the create and send sheets — and,
// by construction, the same module as `analyzeTemplate`, which is what makes
// them agree.
import {
  TEMPLATE_ID_PATTERN,
  TEMPLATE_NAME_PATTERN,
  validateTemplateDraft,
  validateTemplateEdit,
  validateTemplateSend,
} from "@eccos/core/template-rules";
import { isBsuid } from "@eccos/core/bsuid";
import { normalizeCustomerId } from "../lib/customer-id";
import {
  requireAuthContext,
  requireGatewayPermission,
} from "../auth/server-auth";
import type { Grant } from "../auth/step-up";
import { ForbiddenError, memberRole, resolveMemberships } from "../auth/tenant";
import { roleAllows } from "../auth/identity";
import type { ForbiddenReason, GatewayAction, Membership } from "../auth/tenant";
import type {
  HeldEvents,
  ReplayHeldResult,
  BroadcastDetail,
  BroadcastRecipientStatus,
  BroadcastSummary,
  ScheduledCancelResult,
  ScheduledPage,
  ScheduledStatus,
  AccountKeyResource,
  AccountResources,
  ConnectExchangeResult,
  ConnectLinkSummary,
  ConnectStartResult,
  ConversationListOpts,
  ConversationOpts,
  ConversationSummary,
  CreateTemplateInput,
  CreateTemplateResult,
  CursorPage,
  DeleteTemplateInput,
  DeleteTemplateResult,
  DeliveryListOpts,
  EditTemplateInput,
  EditTemplateResult,
  DeliveryRecord,
  GatewayApi,
  GatewayStatus,
  InboundListOpts,
  InboundRow,
  IssuedApiKey,
  ManualConnectResult,
  MessageRecord,
  ThreadView,
  OutboundListOpts,
  OutboundRow,
  ReconcileWabaResult,
  ResubscribeResult,
  RetryFailedResult,
  ScopedOrg,
  ScopedRead,
  SendTemplateTestInput,
  SendTemplateTestResult,
  SendReactionInput,
  SendTextInput,
  SendTextResult,
  SetSubscriberConfigInput,
  SubscriberConfig,
} from "@eccos/gateway-contract";

type DashboardListOpts = Omit<DeliveryListOpts, "wabaId">;
type DashboardInboundOpts = Omit<InboundListOpts, "wabaId">;
type DashboardOutboundOpts = Omit<OutboundListOpts, "wabaId">;
type DashboardConversationListOpts = Omit<ConversationListOpts, "wabaId">;
type DashboardConversationOpts = Omit<ConversationOpts, "wabaId">;

// Re-export the shared contract types the routes render against, so the whole
// dashboard reads the operator surface from a single source of truth
// (`@eccos/gateway-contract`) — no more hand-mirrored shapes.
export type {
  AccountKeyResource,
  AccountResources,
  BroadcastDetail,
  BroadcastRecipientRow,
  BroadcastRecipientStatus,
  BroadcastStatus,
  BroadcastSummary,
  ScheduledCancelResult,
  ScheduledPage,
  ScheduledSend,
  ScheduledStatus,
  ConnectExchangeResult,
  ConnectStartResult,
  ConversationSummary,
  CreateTemplateFailureCode,
  CreateTemplateResult,
  CursorPage,
  DeleteTemplateResult,
  DeliveryRecord,
  EditTemplateFailureCode,
  EditTemplateResult,
  GatewayStatus,
  Health,
  InboundRow,
  IssuedApiKey,
  ManualConnectFailureCode,
  ManualConnectResult,
  MessageRecord,
  OperatorCounts,
  OutboundRow,
  OutboundTrailEvent,
  ThreadView,
  ProvisioningStatus,
  ReconcileWabaResult,
  HeldEvents,
  ReplayHeldResult,
  ResubscribeResult,
  RetryFailedResult,
  SendTemplateTestResult,
  SendTestFailureCode,
  SendTextFailureCode,
  SendTextResult,
  SetSubscriberConfigInput,
  SubscriberConfig,
  TokenWabaCandidate,
} from "@eccos/gateway-contract";

/**
 * Which class of failure a server function hit (eccos-k5a).
 *
 * Decided at the boundary from the THROWN ERROR'S TYPE, never from its message.
 * `UnauthorizedError` / `ForbiddenError` come out of the identity plane long
 * before any RPC is attempted, so a page that receives one must not claim the
 * gateway is unreachable: only `"unreachable"` has established that.
 */
export type FailureKind = "unreachable" | "unauthenticated" | "forbidden";

/** The `{ ok: false }` half of {@link Result}, carrying what actually failed. */
export interface Failure {
  ok: false;
  kind: FailureKind;
  /** The underlying message. Diagnostic detail, never the UI's discriminator. */
  error: string;
  /** Which authorization dead end this is. Present for `kind: "forbidden"`. */
  reason?: ForbiddenReason;
  /**
   * The organizations to choose between. Populated only for
   * `reason: "select-organization"`, where the choice IS the remedy.
   */
  organizations?: Membership[];
}

/**
 * Discriminated result wrapper. Every server function narrows an unconfigured
 * or unreachable gateway — and every authorization refusal — to `{ ok: false }`
 * instead of throwing, so pages render a graceful state and a plain
 * `vite build` / SSR without a running gateway never crashes.
 */
export type Result<T> = { ok: true; data: T } | Failure;

export type { ForbiddenReason, Membership } from "../auth/tenant";
export type { BillingPage, BillingState } from "../billing/account";

/**
 * Identity-plane access (contract §1/§5): every server function resolves the
 * session server-side and re-validates the organization permission via the
 * `auth/server-auth` seam. There is no installation identity, no
 * browser-supplied accountId, and no cross-request authorization caching.
 */

/** Build the request-scoped auth instance from the Worker bindings. */
function requestAuth(): Auth {
  return getAuthForRequest(getRequest(), env);
}

/** Authenticated actor context for audit events. */
interface ActorContext {
  organizationId: string;
  session: { userId: string; email: string };
}

async function requireActor(grant: Grant): Promise<ActorContext> {
  // One auth instance and one Request per actor resolution; the request-scoped
  // session memo (request-memo.ts) additionally dedupes the underlying
  // `auth.api.getSession` to a single D1 read per request (eccos-ya5).
  const auth = requestAuth();
  const request = getRequest();
  const organizationId = await requireGatewayPermission(auth, request, grant);
  const { session } = await requireAuthContext(auth, request);
  return { organizationId, session };
}

/**
 * Arbitrary JSON value. TanStack Start validates that server-function return
 * types are serializable and rejects bare `unknown`, so the contract's
 * `TemplatesResult` (whose `data` / `error` are `unknown`) is surfaced across
 * the boundary through this JSON type — semantically the same untyped payload,
 * just serialization-checkable. The templates route re-narrows `data`.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type TemplatesResult = { ok: true; data: Json } | { ok: false; error: Json };

export type GatewayStatusResult = { ok: true; status: GatewayStatus } | Failure;

export interface DashboardScope {
  accountId: string;
  selectedWabaId: string;
  resources: AccountResources;
}

export interface DashboardOverview {
  status: GatewayStatus;
  scope: DashboardScope;
}

export type DashboardOverviewResult = Result<DashboardOverview>;
export type DashboardState =
  | { stage: "unassigned" }
  | { stage: "no-organization" }
  | ({ stage: "account-ready"; resources: AccountResources; billing?: BillingFlag } & RoleFlag)
  | ({ stage: "ready"; status: GatewayStatus; scope: DashboardScope; billing?: BillingFlag } & RoleFlag);
/**
 * `canAdminister`: the member's role may connect numbers, manage keys and settings; the server refuses either way.
 * `role`: Better Auth's role string, for display.
 */
export type RoleFlag = { canAdminister: boolean; role: string };
/**
 * Present only while billing is on. `subscribed`: a closed account whose
 * subscription still exists, so billing opens its portal. `canManage`: the
 * member's role may start or manage it, the same permission the checkout requires.
 */
export type BillingFlag = { subscribed: boolean; canManage: boolean };
export type DashboardStateResult = Result<DashboardState>;
export type DashboardScopeInput = { wabaId?: string };

const WABA_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PHONE_NUMBER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Digits only, E.164's 15-digit ceiling — what the Cloud API accepts as `to`. */
const RECIPIENT_PATTERN = /^[0-9]{5,15}$/;
/** A pasted Meta access token: printable ASCII, no whitespace. */
const META_TOKEN_PATTERN = /^[\x21-\x7e]+$/;
const MIN_META_TOKEN_LENGTH = 20;
const MAX_META_TOKEN_LENGTH = 1024;
/**
 * A WhatsApp Business Account id the operator TYPED. Every other `wabaId` the
 * console sends came out of its own registry; this one is hand-copied from
 * Business settings, so the shape is Meta's (numeric) and the ceiling is real.
 */
const TYPED_WABA_ID_PATTERN = /^[0-9]{1,32}$/;

function inputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid dashboard request");
  }
  return input as Record<string, unknown>;
}

function optionalWabaId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("wabaId must be a string");
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (!WABA_ID_PATTERN.test(normalized)) throw new Error("invalid wabaId");
  return normalized;
}

/**
 * The typed twin of {@link optionalWabaId}, for the one input an operator
 * writes by hand. Same trim / empty→undefined contract; a stricter shape
 * (Meta's ids are digits) and a sentence the panel can show, naming the
 * shape and never the value.
 */
function typedWabaId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("wabaId must be a string");
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (!TYPED_WABA_ID_PATTERN.test(normalized)) {
    throw new Error(
      "that does not look like a WhatsApp Business Account id — digits only, without spaces or a URL",
    );
  }
  return normalized;
}

function validateScopeInput(input: unknown): DashboardScopeInput | undefined {
  if (input === undefined) return undefined;
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  return wabaId ? { wabaId } : {};
}

/** One optional short string filter — a status, a kind. Bounded so a hand-built
 * request cannot push an unbounded value into a SQL parameter. */
function optionalFilter(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 100) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

/** The `before` cursor: a row id, so a positive safe integer and nothing else. */
function optionalCursor(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function validateDeliveryInput(input: unknown): (DashboardListOpts & DashboardScopeInput) | undefined {
  if (input === undefined) return undefined;
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  const status = optionalFilter(record.status, "status");
  const limit = optionalCursor(record.limit, "limit");
  const before = optionalCursor(record.before, "before");
  return { ...(wabaId ? { wabaId } : {}), ...(status !== undefined ? { status } : {}), ...(limit !== undefined ? { limit } : {}), ...(before !== undefined ? { before } : {}) };
}

/**
 * The event log's narrowing. `type` is an `inbound_events.type` value and
 * `deliveryStatus` a `deliveries.status` value — the route translates the
 * console's words (`waiting`, `forwarded`) before they get here, so the wire
 * carries the database's vocabulary and only that.
 */
function validateInboundInput(input: unknown): (DashboardInboundOpts & DashboardScopeInput) | undefined {
  if (input === undefined) return undefined;
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  const type = optionalFilter(record.type, "type");
  const deliveryStatus = optionalFilter(record.deliveryStatus, "deliveryStatus");
  const limit = optionalCursor(record.limit, "limit");
  const before = optionalCursor(record.before, "before");
  return {
    ...(wabaId ? { wabaId } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(deliveryStatus !== undefined ? { deliveryStatus } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(before !== undefined ? { before } : {}),
  };
}

const CURSOR_TOKEN_PATTERN = /^[A-Za-z0-9+/=]{1,128}$/;

/** A conversation page cursor is opaque to the console: it is only ever passed back as-is. */
function optionalCursorToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !CURSOR_TOKEN_PATTERN.test(value)) {
    throw new Error("cursor must be a page cursor from a previous page");
  }
  return value;
}

const MAX_CONVERSATION_QUERY_LENGTH = 100;

/** The inbox search: a name or a customer id, trimmed. Blank means no filter. */
function optionalConversationQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("q must be a string");
  const q = value.trim();
  if (q.length > MAX_CONVERSATION_QUERY_LENGTH) {
    throw new Error(`q must be at most ${MAX_CONVERSATION_QUERY_LENGTH} characters`);
  }
  return q || undefined;
}

export function validateConversationListInput(
  input: unknown,
): (DashboardConversationListOpts & DashboardScopeInput) | undefined {
  if (input === undefined) return undefined;
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  const limit = optionalCursor(record.limit, "limit");
  const cursor = optionalCursorToken(record.cursor);
  const q = optionalConversationQuery(record.q);
  return {
    ...(wabaId ? { wabaId } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(q !== undefined ? { q } : {}),
  };
}

/** Marking a conversation read or unread: the customer's number or BSUID, and the flag. */
export function validateMarkConversationInput(input: unknown): { wabaId?: string; waId: string; read: boolean } {
  const record = inputRecord(input);
  const waId = normalizeCustomerId(record.waId);
  if (!waId) throw new Error("waId must be a phone number or a BSUID");
  if (typeof record.read !== "boolean") throw new Error("read must be true or false");
  const wabaId = optionalWabaId(record.wabaId);
  return { ...(wabaId ? { wabaId } : {}), waId, read: record.read };
}

/** A thread read needs the customer's number (digits or formatted) or BSUID. */
export function validateConversationInput(input: unknown): DashboardConversationOpts & DashboardScopeInput {
  const record = inputRecord(input);
  const waId = normalizeCustomerId(record.waId);
  if (!waId) throw new Error("waId must be a phone number or a BSUID");
  const wabaId = optionalWabaId(record.wabaId);
  const limit = optionalCursor(record.limit, "limit");
  const cursor = optionalCursorToken(record.cursor);
  return {
    ...(wabaId ? { wabaId } : {}),
    waId,
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

function validateOutboundInput(input: unknown): (DashboardOutboundOpts & DashboardScopeInput) | undefined {
  if (input === undefined) return undefined;
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  const status = optionalFilter(record.status, "status");
  const before = optionalCursor(record.before, "before");
  return {
    ...(wabaId ? { wabaId } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(before !== undefined ? { before } : {}),
  };
}

/** Page sizes: a broadcast summary is two aggregate queries over up to 10 000 recipients. */
const BROADCAST_PAGE_SIZE = 20;
const RECIPIENT_PAGE_SIZE = 100;

function requiredBroadcastId(value: unknown): string {
  const id = normalizeBroadcastId(value);
  if (!id) throw new Error("invalid broadcastId");
  return id;
}

export function validateBroadcastListInput(input: unknown): { wabaId?: string; cursor?: string } | undefined {
  if (input === undefined) return undefined;
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (record.cursor !== undefined) requiredBroadcastId(record.cursor);
  return { ...(wabaId ? { wabaId } : {}), ...(record.cursor !== undefined ? { cursor: record.cursor as string } : {}) };
}

export function validateBroadcastInput(input: unknown): {
  wabaId?: string;
  broadcastId: string;
  status?: BroadcastRecipientStatus;
  cursor?: string;
} {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  const broadcastId = requiredBroadcastId(record.broadcastId);
  const status = normalizeRecipientStatus(record.status);
  if (record.status !== undefined && !status) throw new Error("invalid status");
  const cursor = typeof record.cursor === "string" ? normalizeSeqCursor(record.cursor) : undefined;
  if (record.cursor !== undefined && !cursor) throw new Error("invalid cursor");
  return {
    ...(wabaId ? { wabaId } : {}),
    broadcastId,
    ...(status ? { status } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export function validateCancelBroadcastInput(input: unknown): { wabaId: string; broadcastId: string } {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  return { wabaId, broadcastId: requiredBroadcastId(record.broadcastId) };
}

const SCHEDULED_PAGE_SIZE = 50;

function requiredScheduleKey(value: unknown): string {
  const key = normalizeScheduleKey(value);
  if (!key) throw new Error("invalid key");
  return key;
}

export function validateScheduledListInput(
  input: unknown,
): { wabaId?: string; status?: ScheduledStatus; cursor?: string } | undefined {
  if (input === undefined) return undefined;
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  const status = normalizeScheduledStatus(record.status);
  if (record.status !== undefined && !status) throw new Error("invalid status");
  if (record.cursor !== undefined && !normalizeScheduleKey(record.cursor)) throw new Error("invalid cursor");
  return {
    ...(wabaId ? { wabaId } : {}),
    ...(status ? { status } : {}),
    ...(record.cursor !== undefined ? { cursor: record.cursor as string } : {}),
  };
}

export function validateCancelScheduledInput(input: unknown): { wabaId: string; key: string } {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  return { wabaId, key: requiredScheduleKey(record.key) };
}

function validateRetryInput(input: unknown): { id: number; wabaId: string } {
  const record = inputRecord(input);
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id) || record.id <= 0) {
    throw new Error("id must be a positive integer");
  }
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  return { id: record.id, wabaId };
}

/**
 * The bulk retry's request: a WABA and a window of epoch milliseconds.
 *
 * Zod refuses what the gateway would otherwise throw on (`NaN`, `Infinity`, a
 * fraction, an inverted window) so the operator reads a sentence naming the
 * field instead of a Durable Object error, and a hand-built request never gets
 * as far as the RPC. Unknown keys are stripped, which is how a browser-supplied
 * `accountId` stays what it always is here: UX input that never reaches the
 * gateway. Both ends are inclusive, matching `RetryFailedWindow`.
 */
const retryFailedInput = z
  .object({
    wabaId: z
      .string("wabaId is required")
      .trim()
      .min(1, "wabaId is required")
      .regex(WABA_ID_PATTERN, "invalid wabaId"),
    from: z
      .number("from must be a number of epoch milliseconds")
      .int("from must be a whole number of epoch milliseconds"),
    to: z
      .number("to must be a number of epoch milliseconds")
      .int("to must be a whole number of epoch milliseconds"),
  })
  .refine((window) => window.from <= window.to, { message: "from must not be after to", path: ["to"] });

export function validateRetryFailedInput(input: unknown): z.infer<typeof retryFailedInput> {
  const parsed = retryFailedInput.safeParse(inputRecord(input));
  // The first issue only, as a plain sentence: a ZodError's own message is a
  // JSON dump of every issue, which is not something to show an operator.
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "invalid dashboard request");
  return parsed.data;
}

/** A WABA the operator is asking about by id; the account is never theirs to pick. */
function validateWabaInput(input: unknown): { wabaId: string } {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  return { wabaId };
}

/**
 * The forwarding-target write, in the vocabulary the contract now speaks
 * ({@link SetSubscriberConfigInput}): every field states ONE intention.
 *
 * `url` is a string to set the target and `null` to REMOVE it. It used to be
 * `required`, so the console had no way to say "stop forwarding" at all — the
 * only exit was a URL nobody listens on, which keeps failing deliveries against
 * a destination that is gone.
 *
 * `secret` is absent to keep the stored one, a string to replace it, and `null`
 * to remove it. The EMPTY STRING IS REFUSED here exactly as the gateway refuses
 * it: it used to mean "keep", which made an untouched password box and a
 * cleared one the same request. Clearing has its own spelling now, so the
 * ambiguity has nowhere left to live — and a caller that sends `""` is stating
 * something it cannot mean, which is worth an error rather than a guess.
 */
function validateSubscriberInput(input: unknown): SetSubscriberConfigInput & DashboardScopeInput {
  const record = inputRecord(input);
  if (record.url !== null && (typeof record.url !== "string" || record.url.trim() === "")) {
    throw new Error("url must be a non-empty string, or null to remove the target");
  }
  if (record.secret !== undefined && record.secret !== null && typeof record.secret !== "string") {
    throw new Error("secret must be a string, or null to remove it");
  }
  if (typeof record.secret === "string" && record.secret.trim() === "") {
    throw new Error("secret cannot be empty: pass null to remove it, or omit it to keep the stored one");
  }
  const wabaId = optionalWabaId(record.wabaId);
  const url = record.url === null ? null : (record.url as string).trim();
  const secret = typeof record.secret === "string" ? record.secret.trim() : record.secret;
  return {
    url,
    ...(secret === undefined ? {} : { secret }),
    ...(wabaId ? { wabaId } : {}),
  };
}

/**
 * A send's `to`: a BSUID verbatim (the gateway maps it to Meta's `recipient`),
 * or a number as operators paste it — "+34 600-00 00 11", "(600) 000 011" —
 * stripped to the digits the Cloud API accepts.
 */
function validateRecipient(value: unknown): string {
  if (typeof value !== "string") throw new Error("recipient is required");
  if (isBsuid(value.trim())) return value.trim();
  const to = value.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  if (!RECIPIENT_PATTERN.test(to)) {
    throw new Error("recipient must be 5 to 15 digits in international format, or a BSUID");
  }
  return to;
}

/**
 * The console's send validator — the strict one (the gateway re-checks the same
 * shapes as defense in depth, but this is where an operator's typing is turned
 * into a Meta-shaped request). The template half of it is
 * `validateTemplateSend` in `@eccos/core/template-rules`.
 *
 * `wabaId` and `phoneNumberId` are REQUIRED: a test send must never silently
 * fall back to "the account's first WABA". Which number the message leaves from
 * is the whole point of the exercise.
 *
 * Exported, unlike its siblings, so the refusal matrix can be asserted
 * directly — one call per rejected shape is cheaper than one route call each.
 * That is a convenience, not a necessity: the suite's shared
 * `@tanstack/react-start` fake DOES run `.validator()`
 * (tests/helpers/server-fn-mocks.ts), so route-level normalization is proven
 * through the route itself by the tripwire in tests/gateway.test.ts.
 */
export function validateSendTestInput(input: unknown): SendTemplateTestInput {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  if (typeof record.phoneNumberId !== "string" || !PHONE_NUMBER_ID_PATTERN.test(record.phoneNumberId.trim())) {
    throw new Error("phoneNumberId is required");
  }
  const to = validateRecipient(record.to);
  return {
    wabaId,
    phoneNumberId: record.phoneNumberId.trim(),
    to,
    ...validateTemplateSend(record),
    ...idempotencyKey(record.idempotencyKey),
  };
}

/** A UUID from the console's send gate; optional, so a missing key just sends. */
function idempotencyKey(value: unknown): { idempotencyKey?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error("invalid idempotency key");
  return { idempotencyKey: value };
}

/** Meta's ceiling for a free-text body. */
const MAX_TEXT_LENGTH = 4096;
/** A Meta message id (`wamid.…`): the charset Meta uses, bounded before it reaches Meta. */
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9.+/=_:-]{1,256}$/;
/** One emoji, as an operator types it: a single grapheme, which is bounded in code units too. */
const MAX_EMOJI_LENGTH = 32;
const EMOJI_GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function messageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return MESSAGE_ID_PATTERN.test(id) ? id : null;
}

/** The quoted message of a reply; optional, so a plain send carries none. */
function replyToMessageId(value: unknown): { replyToMessageId?: string } {
  if (value === undefined) return {};
  const id = messageId(value);
  if (!id) throw new Error("replyToMessageId is not a valid message id");
  return { replyToMessageId: id };
}

/**
 * The composer's one free-text message. The body is trimmed, because a message
 * of only whitespace is not a message; the recipient is normalized exactly as
 * the template sheet normalizes it.
 */
export function validateSendTextInput(input: unknown): SendTextInput {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  if (typeof record.phoneNumberId !== "string" || !PHONE_NUMBER_ID_PATTERN.test(record.phoneNumberId.trim())) {
    throw new Error("phoneNumberId is required");
  }
  const to = validateRecipient(record.to);
  if (typeof record.text !== "string") throw new Error("message text is required");
  const text = record.text.trim();
  if (!text) throw new Error("message text is required");
  if (text.length > MAX_TEXT_LENGTH) throw new Error("message text is too long");
  return {
    wabaId,
    phoneNumberId: record.phoneNumberId.trim(),
    to,
    text,
    ...replyToMessageId(record.replyToMessageId),
    ...idempotencyKey(record.idempotencyKey),
  };
}

/**
 * The composer's reaction. `emoji` is one grapheme, or "" to remove the reaction:
 * the gateway passes it to Meta as typed, so this is where a second emoji or a
 * word is refused.
 */
export function validateSendReactionInput(input: unknown): SendReactionInput {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  if (typeof record.phoneNumberId !== "string" || !PHONE_NUMBER_ID_PATTERN.test(record.phoneNumberId.trim())) {
    throw new Error("phoneNumberId is required");
  }
  const to = validateRecipient(record.to);
  const reactedTo = messageId(record.messageId);
  if (!reactedTo) throw new Error("messageId is required");
  if (typeof record.emoji !== "string") throw new Error("emoji must be a string");
  const emoji = record.emoji;
  if (emoji.length > MAX_EMOJI_LENGTH || (emoji !== "" && [...EMOJI_GRAPHEMES.segment(emoji)].length !== 1)) {
    throw new Error("emoji must be one emoji, or empty to remove the reaction");
  }
  return {
    wabaId,
    phoneNumberId: record.phoneNumberId.trim(),
    to,
    messageId: reactedTo,
    emoji,
    ...idempotencyKey(record.idempotencyKey),
  };
}

/**
 * The console's authoring validator — the strict one, and the place where the
 * agreement with the send surface is enforced on the SERVER rather than only in
 * the sheet.
 *
 * The rules are `validateTemplateDraft` in `@eccos/core/template-rules`, which
 * runs the very `analyzeDraftBody` the form runs, so a request that skipped the
 * UI cannot author a body the "Send test" sheet would later refuse; the gateway
 * re-checks the same shapes and THROWS, which is only unreachable while this
 * stays the strict one.
 *
 * Exported for the same reason as {@link validateSendTestInput}: one call per
 * rejected shape is cheaper than one route call each.
 */
export function validateCreateTemplateInput(input: unknown): CreateTemplateInput {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  return { wabaId, ...validateTemplateDraft(record) };
}

/**
 * One template translation's new content. `name` and `language` identify it
 * and cannot change; `category` is optional because Meta refuses to change an
 * APPROVED template's.
 */
export function validateEditTemplateInput(input: unknown): EditTemplateInput {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  return { wabaId, ...validateTemplateEdit(record) };
}

/** One translation of one template, named by BOTH its name and its Graph id.
 * The id is required because the name-only Meta call deletes every language. */
export function validateDeleteTemplateInput(input: unknown): DeleteTemplateInput {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  if (typeof record.name !== "string" || !TEMPLATE_NAME_PATTERN.test(record.name.trim())) {
    throw new Error("invalid template name");
  }
  if (typeof record.templateId !== "string" || !TEMPLATE_ID_PATTERN.test(record.templateId.trim())) {
    throw new Error("invalid template id");
  }
  return { wabaId, name: record.name.trim(), templateId: record.templateId.trim() };
}

function validateSetupInput(input: unknown): { name?: string } | undefined {
  if (input === undefined) return undefined;
  const record = inputRecord(input);
  if (record.name === undefined) return {};
  if (typeof record.name !== "string") throw new Error("name must be a string");
  const name = record.name.trim();
  if (name.length > 200) throw new Error("name must be at most 200 characters");
  return name ? { name } : {};
}

/**
 * Read the `GATEWAY` service binding and invoke the gateway's RPC entrypoint.
 *
 * `env.GATEWAY` is re-typed as a `Service` over the shared `GatewayApi` contract
 * in `src/env.d.ts` — the same interface the gateway's `GatewayRPC implements` —
 * so no cast is needed here. That declaration is the single type tying the two
 * Workers together. The runtime `if (!gateway)` guard still covers a genuinely
 * missing binding (e.g. running the dashboard without the gateway).
 */
async function withGateway<T>(
  fn: (gateway: GatewayApi, organizationId: string | undefined) => Promise<T>,
  grant?: Grant,
): Promise<Result<T>> {
  const gateway = env.GATEWAY;
  if (!gateway) {
    return { ok: false, kind: "unreachable", error: "GATEWAY service binding is not configured" };
  }
  try {
    // The permission check runs INSIDE the boundary on purpose: an
    // authorization refusal must come back classified as one, not escape as a
    // thrown server-function error (or, worse, get reported as a dead gateway).
    const organizationId = grant
      ? await requireGatewayPermission(requestAuth(), getRequest(), grant)
      : undefined;
    return { ok: true, data: await fn(timedProxy(getRequest().headers, gateway, "rpc-"), organizationId) };
  } catch (err) {
    return classifyFailure(err);
  }
}

type ResolvedScope = {
  wabaId: string;
  accountId: string;
  resources: AccountResources;
};

type ResolvedAccount = {
  accountId: string;
  resources: AccountResources;
};

const accountsByRequest = new WeakMap<Headers, { organizationId: string; account: Promise<ResolvedAccount> }>();

/**
 * Resolve the Eccos account for the signed-in user's organization (contract §1):
 * session → membership → organization_accounts link → account. The link is the
 * server-owned mapping in the control plane; a pending/disabled/unknown link
 * fails closed, and a missing one is reconciled there (contract §2) — all in
 * ONE gateway call. The org id is re-validated against membership inside
 * requirePermission before any RPC runs.
 *
 * Memoized per Request (never across requests, contract §5/§10): SSR consumers
 * of one request share a single control-plane trip. A rejection is not cached.
 */
async function resolveOrganizationAccount(
  gateway: GatewayApi,
): Promise<ResolvedAccount> {
  const organizationId = await requireGatewayPermission(requestAuth(), getRequest(), "view");
  const headers = getRequest().headers;
  const cached = accountsByRequest.get(headers);
  if (cached?.organizationId === organizationId) return cached.account;
  const account = gateway.resolveOrganizationScope(organizationId);
  const entry = { organizationId, account };
  accountsByRequest.set(headers, entry);
  account.catch(() => {
    if (accountsByRequest.get(headers) === entry) accountsByRequest.delete(headers);
  });
  return account;
}

function resolveScopeFromAccount(
  account: ResolvedAccount,
  requestedWabaId?: string,
  rejectUnknown = false,
  mode: ScopeMode = "active",
): ResolvedScope {
  const { accountId, resources } = account;
  const { wabaId } = selectWaba(accountId, resources.wabas, requestedWabaId, rejectUnknown, mode);
  return { wabaId, accountId, resources };
}

async function resolveScope(
  gateway: GatewayApi,
  requestedWabaId?: string,
  rejectUnknown = false,
  mode: ScopeMode = "active",
): Promise<ResolvedScope> {
  const account = await resolveOrganizationAccount(gateway);
  return resolveScopeFromAccount(account, requestedWabaId, rejectUnknown, mode);
}

function dashboardScope(scope: ResolvedScope): DashboardScope {
  return {
    accountId: scope.accountId,
    selectedWabaId: scope.wabaId,
    resources: {
      ...scope.resources,
      keys: [...scope.resources.keys].sort((a, b) => a.keyId.localeCompare(b.keyId)),
      wabas: [...scope.resources.wabas]
        .sort((a, b) => a.wabaId.localeCompare(b.wabaId))
        .map((waba) => ({
          ...waba,
          phones: [...waba.phones].sort((a, b) => a.phoneNumberId.localeCompare(b.phoneNumberId)),
        })),
      phones: [...scope.resources.phones].sort(
        (a, b) => a.wabaId.localeCompare(b.wabaId) || a.phoneNumberId.localeCompare(b.phoneNumberId),
      ),
    },
  };
}

/** The WABA comes from the resolved scope, never from the browser's options. */
function withoutWaba<T extends { wabaId?: string }>(opts: T | undefined): Omit<T, "wabaId"> {
  const { wabaId: _wabaId, ...rest } = opts ?? ({} as T);
  return rest;
}

/** What a scoped server function needs from its caller. */
interface ScopedOptions {
  /** What the operation requires, checked inside the failure boundary. */
  action: Grant;
  /** WABA the operator asked about; the account is never theirs to pick. */
  wabaId?: string;
  /** Refuse a WABA the account does not own instead of falling back to its first. */
  rejectUnknown?: boolean;
  /** Whether a not-yet-active WABA is acceptable. Defaults to `"active"`. */
  scope?: ScopeMode;
}

async function withScopedGateway<T>(
  options: ScopedOptions,
  fn: (gateway: GatewayApi, scope: ResolvedScope) => Promise<T>,
): Promise<Result<T>> {
  return withGateway(async (gateway) => {
    const scope = await resolveScope(
      gateway,
      options.wabaId,
      options.rejectUnknown ?? false,
      options.scope ?? "active",
    );
    return fn(gateway, scope);
  }, options.action);
}

/**
 * A scoped READ: one gateway call that resolves the account, enforces WABA
 * ownership and reads the data (`read*`), returning the scope it resolved.
 * `organizationId` is the one the auth layer just validated.
 */
async function withScopedRead<T>(
  options: ScopedOptions,
  read: (gateway: GatewayApi, org: ScopedOrg) => Promise<ScopedRead<T>>,
): Promise<Result<ScopedRead<T>>> {
  return withGateway((gateway, organizationId) => {
    // Always set: the permission check runs because `options.action` is passed.
    if (!organizationId) throw new Error("organization was not resolved");
    return read(gateway, {
      organizationId,
      wabaId: options.wabaId,
      rejectUnknown: options.rejectUnknown,
      mode: options.scope,
    });
  }, options.action);
}

const dataOf = <T>(res: Result<ScopedRead<T>>): Result<T> => (res.ok ? { ok: true, data: res.data.data } : res);

const withScopedData = <T>(
  options: ScopedOptions,
  read: (gateway: GatewayApi, org: ScopedOrg) => Promise<ScopedRead<T>>,
): Promise<Result<T>> => withScopedRead(options, read).then(dataOf);

/** Status page loader — kept returning `{ status }` for the existing route. */
export const getGatewayStatus = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(
    async ({ data }): Promise<GatewayStatusResult> => {
      const res = await withScopedData({ action: "view", wabaId: data?.wabaId }, (gateway, org) =>
        gateway.readStatus(org),
      );
      return res.ok ? { ok: true, status: res.data } : res;
    },
  );

export const getDashboardScope = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(
    ({ data }): Promise<Result<DashboardScope>> =>
      withScopedGateway({ action: "view", wabaId: data?.wabaId }, (_, scope) =>
        Promise.resolve(dashboardScope(scope)),
      ),
  );

export const getDashboardState = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(
    ({ data }): Promise<DashboardStateResult> =>
      withGateway(async (gateway) => {
        // First-run onboarding (before the permission check): a session with
        // zero organization memberships cannot resolve a tenant, so the caller
        // is routed to /onboarding instead of failing closed with a gateway
        // error that reads as an infrastructure outage.
        const auth = requestAuth();
        const request = getRequest();
        await requireAuthContext(auth, request);
        const memberships = await resolveMemberships(auth, request.headers);
        if (memberships.length === 0) {
          return { stage: "no-organization" };
        }
        const organizationId = await requireGatewayPermission(auth, request, "view");
        const state = await gateway.readDashboardState({ organizationId, wabaId: data?.wabaId });
        // "account-ready" means "there is no data plane to show yet", not "there
        // are no WABAs": a WABA still awaiting its phone number is connected but
        // has no Durable Object worth reading, and resolving a scope for it
        // would throw — which the boundary would then report as a dead gateway
        // on EVERY page, /numbers included, where the note explaining the state
        // lives. Both consumers of this stage (the __root redirect and
        // numbers.tsx) already do the right thing with resources present.
        const role = await memberRole(auth, request.headers, organizationId);
        const canAdminister = roleAllows(role, "administer");
        const billing = billingEnabled(env)
          ? { billing: { subscribed: await closedSubscription(gateway, state), canManage: canAdminister } }
          : {};
        if (!state.status) return { stage: "account-ready", resources: state.resources, canAdminister, role, ...billing };
        return {
          stage: "ready",
          canAdminister,
          role,
          status: state.status.data,
          scope: dashboardScope(state.status.scope),
          ...billing,
        };
      }),
  );

/** Read only for an account pointed at billing (no new number, or sends blocked); any other never is. */
async function closedSubscription(
  gateway: GatewayApi,
  state: { accountId: string; resources: AccountResources },
): Promise<boolean> {
  const account = state.resources.account;
  if (!account || (account.canAddNumber !== false && !blocksSends(account.billingStatus))) return false;
  const stored = await gateway.getAccountBilling(state.accountId);
  return Boolean(stored?.subscriptionId && stored.customerId);
}

export const getDashboardOverview = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(
    ({ data }): Promise<DashboardOverviewResult> =>
      withScopedRead({ action: "view", wabaId: data?.wabaId }, (gateway, org) => gateway.readStatus(org)).then(
        (res): DashboardOverviewResult =>
          res.ok ? { ok: true, data: { status: res.data.data, scope: dashboardScope(res.data.scope) } } : res,
      ),
  );

export const getAccountResources = createServerFn({ method: "GET" }).handler(
  (): Promise<Result<AccountResources>> =>
    withGateway(async (gateway) => {
      const account = await resolveOrganizationAccount(gateway);
      return account.resources;
    }, "view"),
);

/**
 * Where Meta's callback hands the operator back (eccos-5z9). Derived from the
 * request origin, which the server entry has already narrowed to the canonical
 * customer host (or localhost in dev) before routing — so this is console
 * configuration, not browser input. The gateway re-validates it anyway.
 */
export const CONNECT_RETURN_PATH = "/numbers";

function connectReturnTo(request: Request): string {
  return new URL(CONNECT_RETURN_PATH, new URL(request.url).origin).href;
}


export const startConnect = createServerFn({ method: "POST" }).handler(
  (): Promise<Result<ConnectStartResult>> =>
    withGateway(async (gateway) => {
      // Embedded Signup is an admin+ step-up mutation (contract §4); the
      // account comes from the organization link. The step-up authorizes the
      // start: the state it issues then lives its normal 30 minutes.
      const actor = await requireActor("connect");
      const returnTo = connectReturnTo(getRequest());
      let link = await gateway.getOrganizationAccountLink(actor.organizationId);
      if (!link) {
        const ensured = await gateway.ensureOrganizationAccount(actor.organizationId);
        link = { accountId: ensured.accountId, status: "active" };
      }
      if (!link || link.status !== "active") {
        throw new Error("This organization is not linked to an Eccos account");
      }
      const result = await gateway.startConnectForAccountId(link.accountId, returnTo);
      auditEvent({
        action: "connect_start",
        actorUserId: actor.session.userId,
        organizationId: actor.organizationId,
        accountId: link.accountId,
        outcome: "success",
      });
      await scheduleRecovery(env.DB, { accountId: link.accountId, organizationId: actor.organizationId }).catch(
        funnelLedgerFailed,
      );
      return result;
    }),
);

/**
 * The public Meta identifiers the Embedded Signup JavaScript SDK page needs.
 *
 * `null` means the SDK path is not configured, and that is a supported state
 * rather than an error: the Connect button falls back to the server-side OAuth
 * redirect, which is the flow that has always worked and the only one a
 * self-hoster without a console has. Neither value is a credential — Meta's own
 * implementation guide puts both in client-side JavaScript — but the route is
 * still session-gated, because who may connect a number is an authorization
 * question regardless of how public the identifiers are.
 */
export type { EmbeddedSignupConfig };

export const getEmbeddedSignupConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<EmbeddedSignupConfig | null>> => {
    try {
      await requireActor("administer");
      return { ok: true, data: embeddedSignupConfig(env) };
    } catch (err) {
      return classifyFailure(err);
    }
  },
);

/**
 * Whether Connect can start, checked without creating a state or writing an
 * audit event: the caller may administer, the gateway answers, it has a public
 * address for Meta's redirect, and the organization's account (if it has one
 * yet) is active. `startConnect` fails on the same conditions, but only after
 * the customer has been through Meta's window.
 */
export const getConnectReadiness = createServerFn({ method: "GET" }).handler(
  (): Promise<Result<{ ready: true } | { ready: false; reason: string }>> =>
    withGateway(async (gateway, organizationId) => {
      if (!(await gateway.getPublicOrigin())) {
        return { ready: false as const, reason: "Connecting is not set up on this gateway yet: it has no public address. Ask whoever runs it." };
      }
      const link = organizationId ? await gateway.getOrganizationAccountLink(organizationId) : null;
      if (link && link.status !== "active") {
        return { ready: false as const, reason: "This workspace's account is not active, so numbers cannot be connected." };
      }
      return { ready: true as const };
    }, "administer"),
);

/**
 * Resolve the caller's Eccos account for an `administer` action (Embedded
 * Signup, token attach, API keys), creating the link if this is the
 * organization's first one. Shared so those actions cannot drift on who is
 * allowed to perform them. The ones that write name their step-up row.
 */
async function adminActorAccount(
  gateway: GatewayApi,
  grant: Grant = "administer",
): Promise<{ actor: ActorContext; accountId: string }> {
  const actor = await requireActor(grant);
  let link = await gateway.getOrganizationAccountLink(actor.organizationId);
  if (!link) {
    const ensured = await gateway.ensureOrganizationAccount(actor.organizationId);
    link = { accountId: ensured.accountId, status: "active" };
  }
  if (!link || link.status !== "active") {
    throw new Error("This organization is not linked to an Eccos account");
  }
  return { actor, accountId: link.accountId };
}

function validateConnectExchangeInput(input: unknown): {
  code: string;
  state: string;
  wabaId?: string;
} {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  return { ...validateCodeAndState(record), ...(wabaId ? { wabaId } : {}) };
}

/**
 * Finish Embedded Signup for a code the JavaScript SDK handed to the browser.
 *
 * This exists so the browser never needs an account API key. The page holds the
 * code for the length of one `fetch`; everything that can actually mint
 * credentials — the app secret, the token exchange, the registration — happens
 * behind the private service binding, reached only through this
 * session-authenticated route.
 *
 * Meta's code lives **30 seconds**, so this path stays deliberately short:
 * validate, resolve the account, forward. Nothing is queued or retried, because
 * a retry would arrive with an expired code and an already-consumed state.
 *
 * No step-up of its own, for the same reason: the code is single-use and a
 * refusal here would lose it. The account-bound state it must present was
 * issued by `startConnect`, which is the step-up row, minutes earlier.
 */
export const exchangeConnectCode = createServerFn({ method: "POST" })
  .validator(validateConnectExchangeInput)
  .handler(
    ({ data }): Promise<Result<ConnectExchangeResult>> =>
      withGateway(async (gateway) => {
        const { actor, accountId } = await adminActorAccount(gateway);
        const result = await gateway.exchangeConnectCodeForAccountId(
          accountId,
          data.code,
          data.state,
          data.wabaId,
        );
        auditEvent({
          action: "connect_exchange",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId,
          resource: result.ok
            ? { wabaId: result.waba_id, connected: result.connected.length, status: result.status }
            : { code: result.code },
          ...connectAudit(result),
        });
        return result;
      }),
  );

/**
 * A Meta access token an operator pasted, and optionally the WABA they chose.
 *
 * The console's validator is the strict one — the gateway re-checks the same
 * shape and THROWS, which stays unreachable only while this holds. Printable
 * ASCII with no whitespace refuses the two pastes that actually happen: a whole
 * `curl` command, and a token that wrapped across lines in a terminal.
 *
 * It is a shape check and nothing more. Whether the token WORKS is a question
 * only Meta can answer, and the gateway asks it — no amount of validating here
 * can tell an own-app token from a customer's.
 *
 * Exported for the same reason as {@link validateSendTestInput}: one call per
 * rejected shape is cheaper than one route call each.
 *
 * `wabaId`, when present, is either a candidate the gateway offered or an id
 * the operator typed to answer `no_waba`; both are Meta ids, so both must be
 * digits.
 */
export function validateTokenConnectInput(input: unknown): { token: string; wabaId?: string } {
  const record = inputRecord(input);
  if (typeof record.token !== "string") throw new Error("token is required");
  const token = record.token.trim();
  if (!token) throw new Error("token is required");
  if (token.length < MIN_META_TOKEN_LENGTH || token.length > MAX_META_TOKEN_LENGTH) {
    throw new Error("that does not look like a Meta access token");
  }
  if (!META_TOKEN_PATTERN.test(token)) {
    throw new Error("paste only the token — no spaces, quotes, or line breaks");
  }
  const wabaId = typedWabaId(record.wabaId);
  return { token, ...(wabaId ? { wabaId } : {}) };
}

/**
 * Attach a WABA from a token the operator pasted (eccos-up9).
 *
 * `administer`, the same class as `startConnect` / `exchangeConnectCode` and
 * for a stronger reason than either: this action DEPOSITS a long-lived Meta
 * credential into tenant state. `configure` would let a template admin paste
 * tokens, which is the wrong side of the credentials line this codebase draws.
 *
 * ── WHERE THE TOKEN GOES ────────────────────────────────────────────────────
 * In through this POST body, once, over a session-authenticated route; across
 * the private `GATEWAY` binding, never public HTTP; sealed at rest by the
 * control plane. It touches no log line and no audit field — see the
 * `connect_token` doc comment in `./audit.ts`, and the audit record below,
 * which carries identifiers and a failure code only.
 */
export const connectWithToken = createServerFn({ method: "POST" })
  .validator(validateTokenConnectInput)
  .handler(
    ({ data }): Promise<Result<ManualConnectResult>> =>
      withGateway(async (gateway) => {
        const { actor, accountId } = await adminActorAccount(gateway, "connect");
        const result = await gateway.connectWabaWithToken(accountId, data.token, data.wabaId);
        // NO token, and nothing derived from one. `candidates` is counted, not
        // listed, because the count is what makes the line legible; the WABA
        // id the operator named (if any) is recorded because a refusal is
        // about that id, and an id is an identifier, not a credential.
        auditEvent({
          action: "connect_token",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId,
          resource: result.ok
            ? { wabaId: result.waba_id, connected: result.connected.length }
            : {
                code: result.code,
                candidates: result.candidates?.length ?? 0,
                ...(data.wabaId ? { wabaId: data.wabaId } : {}),
              },
          outcome: result.ok ? "success" : "failed",
          ...(result.ok ? {} : { detail: result.code }),
        });
        return result;
      }),
  );

/**
 * Record one Embedded Signup session event in the audit log.
 *
 * This is the whole of what session logging buys that the server side does not
 * already know: which screen a customer abandoned on, and the error code and
 * session id when they report an error from inside the flow. Both are
 * unobtainable any other way, and the session id is the first thing Meta
 * support asks for.
 *
 * It is telemetry, so it never fails the flow — the caller ignores the result.
 * The payload is re-validated here rather than trusted: it originates in a
 * `postMessage` from another window, and although the client parser checks the
 * origin, a server route must never depend on a client-side check.
 */
export const recordConnectSessionEvent = createServerFn({ method: "POST" })
  .validator(validateSessionEvent)
  .handler(
    ({ data }): Promise<Result<{ recorded: true }>> =>
      withGateway(async (gateway) => {
        const { actor, accountId } = await adminActorAccount(gateway);
        auditEvent({
          action: "connect_session_event",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId,
          resource: {
            event: data.event,
            currentStep: data.currentStep ?? null,
            errorCode: data.errorCode ?? null,
            sessionId: data.sessionId ?? null,
            wabaId: data.wabaId ?? null,
          },
          outcome: data.errorCode ? "failed" : "success",
        });
        if (data.errorCode) await noteConnectError(env.DB, accountId, data.errorCode).catch(funnelLedgerFailed);
        return { recorded: true as const };
      }),
  );

/** The workspace's connection link. `url` is set only by the call that made the link. */
export interface ConnectLinkView {
  link: ConnectLinkSummary;
  url: string | null;
}

/**
 * Read the workspace's connection link, making one when there is none to wait
 * for (never made, expired, or dead with its creator's access) or when `fresh`
 * asks to replace it. `administer` to read, and the `connect` step-up row to
 * make one (contract §4): the link lets its bearer add a number to this account.
 */
export const openConnectLink = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ fresh: inputRecord(input ?? {}).fresh === true }))
  .handler(
    ({ data }): Promise<Result<ConnectLinkView>> =>
      withGateway(async (gateway) => {
        const { actor, accountId } = await adminActorAccount(gateway);
        const current = data.fresh ? null : await gateway.getConnectLink(accountId);
        // A live link whose creator may no longer connect resolves for nobody: replace it too.
        const dead =
          current &&
          linkIsLive(current) &&
          !(await linkPeople(env.DB, actor.organizationId, current.creatorUserId));
        if (current && current.state !== "expired" && !dead) return { link: current, url: null };
        await requireActor("connect");
        // Without `replace` the gateway keeps a live link, so two dialogs opening at once share one.
        const issued = await gateway.issueConnectLink(accountId, actor.session.userId, data.fresh || Boolean(dead));
        if (issued === "exists") {
          const link = await gateway.getConnectLink(accountId);
          if (!link) throw new Error("the connection link could not be read");
          return { link, url: null };
        }
        auditEvent({
          action: "connect_link_issue",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId,
          outcome: "success",
        });
        return {
          link: {
            state: "pending",
            expiresAt: issued.expiresAt,
            connectedPhone: null,
            creatorUserId: actor.session.userId,
          },
          // In the fragment, so the token reaches no server log and no Referer.
          url: `${new URL(getRequest().url).origin}${CONNECT_LINK_PATH}#${issued.token}`,
        };
      }),
  );

// --- API keys (/api-keys, eccos-bm92) ---

const KEY_ID_PATTERN = /^key_[A-Za-z0-9]{1,64}$/;
const MAX_KEY_LABEL_LENGTH = 200;

export function validateIssueKeyInput(input: unknown): { label?: string } {
  const label = inputRecord(input).label;
  if (label === undefined || label === null) return {};
  if (typeof label !== "string") throw new Error("label must be a string");
  const trimmed = label.trim();
  if (trimmed.length > MAX_KEY_LABEL_LENGTH) {
    throw new Error(`label must be at most ${MAX_KEY_LABEL_LENGTH} characters`);
  }
  return trimmed ? { label: trimmed } : {};
}

export function validateRevokeKeyInput(input: unknown): { keyId: string } {
  const keyId = inputRecord(input).keyId;
  if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) throw new Error("invalid keyId");
  return { keyId };
}

/** Key metadata for the caller's account. `administer`, like issuing: which
 * keys exist is part of managing them. */
export const listApiKeys = createServerFn({ method: "GET" }).handler(
  (): Promise<Result<AccountKeyResource[]>> =>
    withGateway(async (gateway) => {
      const { accountId } = await adminActorAccount(gateway);
      return gateway.listApiKeys(accountId);
    }),
);

/** The gateway origin the API-key snippet points at; null when unconfigured. */
export const getGatewayOrigin = createServerFn({ method: "GET" }).handler(
  (): Promise<Result<string | null>> => withGateway((gateway) => gateway.getPublicOrigin(), "view"),
);

/** Issue an `ek_` key. The raw key crosses this boundary once, in the return
 * value, and never reaches a log or audit line. */
export const issueApiKey = createServerFn({ method: "POST" })
  .validator(validateIssueKeyInput)
  .handler(
    ({ data }): Promise<Result<IssuedApiKey>> =>
      withGateway(async (gateway) => {
        const { actor, accountId } = await adminActorAccount(gateway, "api-keys");
        const issued = await gateway.issueApiKey(accountId, data.label);
        auditEvent({
          action: "api_key_issue",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId,
          resource: { keyId: issued.keyId },
          outcome: "success",
        });
        return issued;
      }),
  );

/** Revoke one key of the caller's account; `false` when it is not one. */
export const revokeApiKey = createServerFn({ method: "POST" })
  .validator(validateRevokeKeyInput)
  .handler(
    ({ data }): Promise<Result<boolean>> =>
      withGateway(async (gateway) => {
        const { actor, accountId } = await adminActorAccount(gateway, "api-keys");
        const revoked = await gateway.revokeApiKey(accountId, data.keyId);
        auditEvent({
          action: "api_key_revoke",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId,
          resource: { keyId: data.keyId },
          outcome: revoked ? "success" : "failed",
        });
        return revoked;
      }),
  );

export const listDeliveries = createServerFn({ method: "GET" })
  .validator(validateDeliveryInput)
  .handler(
    ({ data }): Promise<Result<DeliveryRecord[]>> =>
      withScopedData({ action: "view", wabaId: data?.wabaId }, (gateway, org) =>
        gateway.readDeliveries(org, withoutWaba(data)),
      ),
  );

export const listBroadcasts = createServerFn({ method: "GET" })
  .validator(validateBroadcastListInput)
  .handler(({ data }): Promise<Result<CursorPage<BroadcastSummary>>> =>
    withScopedData({ action: "view", wabaId: data?.wabaId }, (gateway, org) =>
      gateway.readBroadcasts(org, { cursor: data?.cursor, limit: BROADCAST_PAGE_SIZE }),
    ),
  );

/** One broadcast and a page of its recipients; null data when it is not this account's. */
export const getBroadcast = createServerFn({ method: "GET" })
  .validator(validateBroadcastInput)
  .handler(({ data }): Promise<Result<BroadcastDetail | null>> =>
    withScopedData({ action: "view", wabaId: data.wabaId }, (gateway, org) =>
      gateway.readBroadcast(org, {
        broadcastId: data.broadcastId,
        status: data.status,
        cursor: data.cursor,
        limit: RECIPIENT_PAGE_SIZE,
      }),
    ),
  );

/**
 * Stop a running broadcast (`operate`: it changes outbound traffic, it configures
 * nothing). Any WABA status is fine — stopping sends is always safe. The audit line
 * carries ids only, never a recipient (see `SensitiveAction`'s "broadcast_cancel").
 */
export const cancelBroadcast = createServerFn({ method: "POST" })
  .validator(validateCancelBroadcastInput)
  .handler(
    ({ data }): Promise<Result<BroadcastSummary | null>> =>
      withGateway(async (gateway) => {
        const actor = await requireActor("operate");
        const scope = await resolveScope(gateway, data.wabaId, true, "any");
        const broadcast = await gateway.cancelBroadcast(
          { wabaId: scope.wabaId, broadcastId: data.broadcastId },
          scope.accountId,
        );
        auditEvent({
          action: "broadcast_cancel",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId: scope.accountId,
          resource: { wabaId: scope.wabaId, broadcastId: data.broadcastId },
          outcome: broadcast?.status === "cancelled" ? "success" : "failed",
          ...(broadcast?.status === "cancelled" ? {} : { detail: broadcast ? "ended" : "not_found" }),
        });
        return broadcast;
      }),
  );

/** Scheduled sends of the selected WABA in one status (default pending), with per-status counts. */
export const listScheduled = createServerFn({ method: "GET" })
  .validator(validateScheduledListInput)
  .handler(({ data }): Promise<Result<ScheduledPage>> =>
    withScopedData({ action: "view", wabaId: data?.wabaId }, (gateway, org) =>
      gateway.readScheduled(org, { status: data?.status, cursor: data?.cursor, limit: SCHEDULED_PAGE_SIZE }),
    ),
  );

/**
 * Stop a pending scheduled send (`operate`, like `cancelBroadcast`). The audit line
 * carries ids only, never the recipient (see `SensitiveAction`'s "scheduled_cancel").
 */
export const cancelScheduled = createServerFn({ method: "POST" })
  .validator(validateCancelScheduledInput)
  .handler(
    ({ data }): Promise<Result<ScheduledCancelResult>> =>
      withGateway(async (gateway) => {
        const actor = await requireActor("operate");
        const scope = await resolveScope(gateway, data.wabaId, true, "any");
        const result = await gateway.cancelScheduled({ wabaId: scope.wabaId, key: data.key }, scope.accountId);
        // `unchanged` on a send that ended some other way (it expired meanwhile) did nothing.
        const done = result.state === "cancelled" || (result.state === "unchanged" && result.scheduled?.status === "cancelled");
        auditEvent({
          action: "scheduled_cancel",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId: scope.accountId,
          resource: { wabaId: scope.wabaId, key: data.key },
          outcome: done ? "success" : "failed",
          ...(done ? {} : { detail: result.state === "unchanged" ? "ended" : result.state }),
        });
        return result;
      }),
  );

export const listInbound = createServerFn({ method: "GET" })
  .validator(validateInboundInput)
  .handler(({ data }): Promise<Result<InboundRow[]>> =>
    withScopedData({ action: "view", wabaId: data?.wabaId }, (gateway, org) =>
      gateway.readInbound(org, withoutWaba(data)),
    ),
  );

export const listOutbound = createServerFn({ method: "GET" })
  .validator(validateOutboundInput)
  .handler(({ data }): Promise<Result<OutboundRow[]>> =>
    withScopedData({ action: "view", wabaId: data?.wabaId }, (gateway, org) =>
      gateway.readOutbound(org, withoutWaba(data)),
    ),
  );

export const listConversations = createServerFn({ method: "GET" })
  .validator(validateConversationListInput)
  .handler(({ data }): Promise<Result<CursorPage<ConversationSummary>>> =>
    withScopedData({ action: "view", wabaId: data?.wabaId }, (gateway, org) =>
      gateway.readConversations(org, withoutWaba(data)),
    ),
  );

export const getConversation = createServerFn({ method: "GET" })
  .validator(validateConversationInput)
  .handler(({ data }): Promise<Result<CursorPage<MessageRecord>>> =>
    withScopedData({ action: "view", wabaId: data.wabaId }, (gateway, org) =>
      gateway.readConversation(org, withoutWaba(data)),
    ),
  );

export const getThreadView = createServerFn({ method: "GET" })
  .validator(validateConversationInput)
  .handler(({ data }): Promise<Result<ThreadView>> =>
    withScopedData({ action: "view", wabaId: data.wabaId }, (gateway, org) =>
      gateway.readThreadView(org, withoutWaba(data)),
    ),
  );

/**
 * Marks a conversation read or unread for the whole workspace. `operate`: the read
 * state belongs to the team, so a viewer may not change it. Not audited: it is not
 * a sensitive action.
 */
export const markConversation = createServerFn({ method: "POST" })
  .validator(validateMarkConversationInput)
  .handler(({ data }): Promise<Result<void>> =>
    withScopedData({ action: "operate", wabaId: data.wabaId }, (gateway, org) =>
      gateway.markConversation(org, { waId: data.waId, read: data.read }),
    ),
  );

export const listTemplates = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(({ data }): Promise<Result<TemplatesResult>> =>
    withScopedGateway(
      // `scope: "any"`: listing templates needs the WABA id and its stored Meta
      // token, nothing from the data plane — so it works on a connected WABA
      // that is still waiting for its phone number.
      { action: "view", wabaId: data?.wabaId, scope: "any" },
      async (gateway, scope) =>
        (await gateway.listTemplates(scope.wabaId, 100, scope.accountId)) as TemplatesResult,
    ),
  );

export const retryDelivery = createServerFn({ method: "POST" })
  .validator(validateRetryInput)
  .handler(
    ({ data }): Promise<Result<{ ok: boolean; previousStatus: string | null }>> =>
      withScopedGateway(
        { action: "operate", wabaId: data.wabaId, rejectUnknown: true },
        (gateway, scope) => gateway.retryDelivery(data.id, scope.wabaId, scope.accountId),
      ),
  );

/**
 * Re-send every failed delivery of one WABA enqueued inside a window.
 *
 * `operate`, the same class and the same scope rules as `retryDelivery`: it is
 * that act at scale, so it is neither easier nor harder to reach. The WABA is
 * validated against the account resolved from the session (`rejectUnknown`),
 * and the window is the only thing the browser decides. The gateway applies it
 * to the `created_at` of each row, and counts what retention already emptied
 * instead of replaying it.
 *
 * Like `retryDelivery`, it writes no audit line.
 */
export const retryFailedDeliveries = createServerFn({ method: "POST" })
  .validator(validateRetryFailedInput)
  .handler(
    ({ data }): Promise<Result<RetryFailedResult>> =>
      withScopedGateway(
        { action: "operate", wabaId: data.wabaId, rejectUnknown: true },
        (gateway, scope) =>
          gateway.retryFailedDeliveries(
            { from: data.from, to: data.to },
            scope.wabaId,
            scope.accountId,
          ),
      ),
  );

/** Events stored while the workspace was paused that its forwarding target has not seen. */
export const getHeldEvents = createServerFn({ method: "GET" }).handler(
  (): Promise<Result<HeldEvents>> =>
    withGateway(async (gateway) => gateway.getHeldEvents((await resolveOrganizationAccount(gateway)).accountId), "view"),
);

/**
 * Forward the events held while the workspace was paused. `administer` (owner
 * or admin): a late backlog can make the customer's tool answer real people
 * hours later, which is the account's call, not an operator's.
 */
export const replayHeldEvents = createServerFn({ method: "POST" }).handler(
  (): Promise<Result<ReplayHeldResult>> =>
    withGateway(async (gateway) => {
      const { actor, accountId } = await adminActorAccount(gateway);
      const result = await gateway.replayHeldEvents(accountId);
      auditEvent({
        action: "held_replay",
        actorUserId: actor.session.userId,
        organizationId: actor.organizationId,
        accountId,
        resource: result.ok ? { replayed: result.replayed } : { code: result.code },
        outcome: result.ok ? "success" : "denied",
      });
      return result;
    }),
);

/**
 * Send one template message from the console ("Send test").
 *
 * `operate` (operator+), the same class as `retryDelivery`: it causes outbound
 * traffic on the tenant's behalf but changes no configuration and mints no
 * credentials. `viewer` is excluded because a send has external effect and
 * marginal cost; requiring `configure`/`administer` would be wrong the other
 * way, since an operator smoke-testing a template before a campaign is exactly
 * the persona, and forcing admin would push teams to over-grant admin.
 *
 * `withGateway` without an `action` plus `requireActor` inside is the
 * `startConnect`/`exchangeConnectCode` precedent for an audited mutation: one
 * permission check, with the actor available for the audit record.
 */
export const sendTemplateTest = createServerFn({ method: "POST" })
  .validator(validateSendTestInput)
  .handler(
    ({ data }): Promise<Result<SendTemplateTestResult>> =>
      withGateway(async (gateway) => {
        const actor = await requireActor("operate");
        const scope = await resolveScope(gateway, data.wabaId, true);
        const result = await gateway.sendTemplateTest(
          { ...data, wabaId: scope.wabaId },
          scope.accountId,
        );
        // No recipient, no parameter values — ever. See `SensitiveAction`'s
        // "template_test_send" doc comment for why the number stays out.
        auditEvent({
          action: "template_test_send",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId: scope.accountId,
          resource: {
            wabaId: scope.wabaId,
            phoneNumberId: data.phoneNumberId,
            template: data.templateName,
            language: data.languageCode,
            ...(result.ok ? { messageId: result.messageId } : {}),
          },
          outcome: result.ok ? "success" : "failed",
          ...(result.ok ? {} : { detail: result.code }),
        });
        return result;
      }),
  );

/**
 * Whether the signed-in member may send from the console (`operate`). Only the
 * composer's presence reads it: the send itself is refused by the server for a
 * viewer whatever the page shows.
 */
export const canSendMessages = createServerFn({ method: "GET" }).handler(
  async (): Promise<boolean> => (await withGateway(async () => true, "operate")).ok,
);

/**
 * One free-text message from the conversation composer.
 *
 * `operate`, like the template send: it causes traffic. The 24-hour window is
 * Meta's to enforce, so nothing here pre-checks it. A closed window comes back
 * as the typed `window_closed` and the composer offers a template instead.
 */
export const sendText = createServerFn({ method: "POST" })
  .validator(validateSendTextInput)
  .handler(
    ({ data }): Promise<Result<SendTextResult>> =>
      withGateway(async (gateway) => {
        const actor = await requireActor("operate");
        const scope = await resolveScope(gateway, data.wabaId, true);
        const result = await gateway.sendText({ ...data, wabaId: scope.wabaId }, scope.accountId);
        auditSend("text_send", actor, scope, data.phoneNumberId, result);
        return result;
      }),
  );

/** One emoji reaction from the composer's message menu. `operate`, as `sendText`. */
export const sendReaction = createServerFn({ method: "POST" })
  .validator(validateSendReactionInput)
  .handler(
    ({ data }): Promise<Result<SendTextResult>> =>
      withGateway(async (gateway) => {
        const actor = await requireActor("operate");
        const scope = await resolveScope(gateway, data.wabaId, true);
        const result = await gateway.sendReaction({ ...data, wabaId: scope.wabaId }, scope.accountId);
        auditSend("reaction_send", actor, scope, data.phoneNumberId, result);
        return result;
      }),
  );

/** The audit line of a console send: ids and the failure code only, never the recipient or the body. */
function auditSend(
  action: "text_send" | "reaction_send",
  actor: ActorContext,
  scope: { wabaId: string; accountId: string },
  phoneNumberId: string,
  result: SendTextResult,
): void {
  auditEvent({
    action,
    actorUserId: actor.session.userId,
    organizationId: actor.organizationId,
    accountId: scope.accountId,
    resource: {
      wabaId: scope.wabaId,
      phoneNumberId,
      ...(result.ok ? { messageId: result.messageId } : {}),
    },
    outcome: result.ok ? "success" : "failed",
    ...(result.ok ? {} : { detail: result.code }),
  });
}

/**
 * Create one message template ("New template").
 *
 * `configure` (admin+), NOT `operate`. The line this codebase draws is: reads
 * are `view`, acts that cause traffic are `operate`, and acts that change
 * DURABLE TENANT STATE are `configure`. A template is durable state at Meta
 * under the business's name: it counts against the WABA's template quota,
 * a rejected one affects the business's review standing, and — because
 * deleting an approved template locks its name for 30 days — even cleanup is
 * consequential. Splitting create (`operate`) from delete (`configure`) was the
 * alternative, and it is an escalation trap: an operator could author a
 * mistake they then cannot remove.
 *
 * `scope: "any"` (the `listTemplates` precedent, not `sendTemplateTest`'s
 * active-only rule): creation is a WABA-level write that needs the WABA id and
 * its stored token, nothing from the data plane. An account whose number is
 * still provisioning is exactly the one preparing its templates — authoring
 * precedes provisioning.
 */
export const createTemplate = createServerFn({ method: "POST" })
  .validator(validateCreateTemplateInput)
  .handler(
    ({ data }): Promise<Result<CreateTemplateResult>> =>
      withGateway(async (gateway) => {
        const actor = await requireActor("configure");
        const scope = await resolveScope(gateway, data.wabaId, true, "any");
        const result = await gateway.createTemplate(
          { ...data, wabaId: scope.wabaId },
          scope.accountId,
        );
        // NO body text and NO example value — ever. See `SensitiveAction`'s
        // "template_create" doc comment: both are message content, and the
        // audit log is not retention- or erasure-governed, so anything content
        // shaped written here could never be erased again. The template NAME is
        // an identifier and is already precedented by `template_test_send`.
        auditEvent({
          action: "template_create",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId: scope.accountId,
          resource: {
            wabaId: scope.wabaId,
            template: data.name,
            language: data.language,
            category: data.category,
            ...(result.ok ? { templateId: result.id, status: result.status } : {}),
          },
          outcome: result.ok ? "success" : "failed",
          ...(result.ok ? {} : { detail: result.code }),
        });
        return result;
      }),
  );

/** Replace one template translation's content ("Edit"). `configure`, like
 * creation: it changes durable state at Meta under the business's name. */
export const editTemplate = createServerFn({ method: "POST" })
  .validator(validateEditTemplateInput)
  .handler(
    ({ data }): Promise<Result<EditTemplateResult>> =>
      withGateway(async (gateway) => {
        const actor = await requireActor("configure");
        const scope = await resolveScope(gateway, data.wabaId, true, "any");
        const result = await gateway.editTemplate({ ...data, wabaId: scope.wabaId }, scope.accountId);
        // Identifiers only, never the body or an example (see "template_create").
        auditEvent({
          action: "template_edit",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId: scope.accountId,
          resource: {
            wabaId: scope.wabaId,
            template: data.name,
            language: data.language,
            templateId: data.templateId,
            ...(data.category ? { category: data.category } : {}),
          },
          outcome: result.ok ? "success" : "failed",
          ...(result.ok ? {} : { detail: result.code }),
        });
        return result;
      }),
  );

/**
 * Delete ONE translation of a template.
 *
 * `configure` for the same reason as creation, and with more force: deleting an
 * APPROVED template blocks its name from reuse for 30 days, which is the most
 * durable consequence anything on this page has.
 */
export const deleteTemplate = createServerFn({ method: "POST" })
  .validator(validateDeleteTemplateInput)
  .handler(
    ({ data }): Promise<Result<DeleteTemplateResult>> =>
      withGateway(async (gateway) => {
        const actor = await requireActor("configure");
        const scope = await resolveScope(gateway, data.wabaId, true, "any");
        const result = await gateway.deleteTemplate(
          { ...data, wabaId: scope.wabaId },
          scope.accountId,
        );
        auditEvent({
          action: "template_delete",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId: scope.accountId,
          resource: {
            wabaId: scope.wabaId,
            template: data.name,
            templateId: data.templateId,
          },
          outcome: result.ok ? "success" : "failed",
          ...(result.ok ? {} : { detail: result.code }),
        });
        return result;
      }),
  );

// --- Operator actions (webhooks page) ---

/** Read the current outbound-forwarding target. The secret is never exposed. */
/** Conversation retention for the caller's account; null keeps them forever. */
export const getConversationRetention = createServerFn({ method: "GET" }).handler(
  (): Promise<Result<number | null>> =>
    withGateway(async (gateway) => {
      const { accountId } = await adminActorAccount(gateway);
      return gateway.getConversationRetention(accountId);
    }),
);

/**
 * Sets the window for conversation history. `days` is null (keep forever) or a
 * whole number of days within the bounds the control plane enforces too.
 */
export function validateRetentionInput(input: unknown): { days: number | null } {
  const days = inputRecord(input).days;
  if (days === null) return { days: null };
  if (typeof days !== "number" || !Number.isInteger(days) || days < 30 || days > 3650) {
    throw new Error("days must be null (keep forever) or a whole number from 30 to 3650");
  }
  return { days };
}

export const setConversationRetention = createServerFn({ method: "POST" })
  .validator(validateRetentionInput)
  .handler(
    ({ data }): Promise<Result<number | null>> =>
      withGateway(async (gateway) => {
        const { actor, accountId } = await adminActorAccount(gateway, "conversation-retention");
        const stored = await gateway.setConversationRetention(accountId, data.days);
        auditEvent({
          action: "conversation_retention_set",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId,
          resource: { days: stored },
          outcome: "success",
        });
        return stored;
      }),
  );

function requireBilling(): Billing {
  const billing = billingFor(env);
  if (!billing) throw new Error("Billing is not enabled");
  return billing;
}

/** The workspace's billing state; null when billing is off. */
export const getBilling = createServerFn({ method: "GET" }).handler(
  (): Promise<Result<BillingState | null>> =>
    withGateway(async (gateway) => {
      if (!billingEnabled(env)) return null;
      const { accountId } = await adminActorAccount(gateway);
      return billingState(gateway, accountId);
    }),
);

/** /billing for every role; a member gets no payments and no way into the portal. Null when billing is off. */
export const getBillingPage = createServerFn({ method: "GET" }).handler(
  (): Promise<Result<BillingPage | null>> =>
    withGateway(async (gateway) => {
      const billing = billingFor(env);
      if (!billing) return null;
      const { actor, accountId } = await adminActorAccount(gateway, "view");
      const role = await memberRole(requestAuth(), getRequest().headers, actor.organizationId);
      return billingPage(billing, accountId, roleAllows(role, "administer"));
    }),
);

export function validateConfirmCheckoutInput(input: unknown): { subscriptionId: string } {
  const subscriptionId = inputRecord(input).subscriptionId;
  if (typeof subscriptionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(subscriptionId)) {
    throw new Error("subscriptionId is malformed");
  }
  return { subscriptionId };
}

/**
 * The checkout return: reads the subscription from Creem now instead of waiting
 * for its webhook. Answers its status, or null when it is not this account's.
 */
export const confirmCheckout = createServerFn({ method: "POST" })
  .validator(validateConfirmCheckoutInput)
  .handler(
    ({ data }): Promise<Result<string | null>> =>
      withGateway(async (gateway) => {
        const billing = requireBilling();
        const { accountId } = await adminActorAccount(gateway);
        return (await syncSubscription(billing, data.subscriptionId, accountId))?.status ?? null;
      }),
  );

export const startCheckout = createServerFn({ method: "POST" }).handler(
  (): Promise<Result<{ url: string }>> =>
    withGateway(async (gateway) => {
      const billing = requireBilling();
      const { actor, accountId } = await adminActorAccount(gateway);
      const successUrl = billingReturnUrl(env.BETTER_AUTH_URL, getRequest().url);
      const url = await checkoutUrl(billing, { accountId, email: actor.session.email, successUrl });
      auditEvent({
        action: "funnel_checkout_started",
        actorUserId: actor.session.userId,
        organizationId: actor.organizationId,
        accountId,
        outcome: "success",
      });
      return { url };
    }),
);

export const openPortal = createServerFn({ method: "POST" }).handler(
  (): Promise<Result<{ url: string }>> =>
    withGateway(async (gateway) => {
      const billing = requireBilling();
      const { accountId } = await adminActorAccount(gateway);
      return { url: await portalUrl(billing, accountId) };
    }),
);

export const getSubscriberConfig = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(({ data }): Promise<Result<SubscriberConfig>> =>
    // `scope: "any"`: the forwarding target is what an operator sets up BEFORE
    // any traffic arrives, so refusing to show it until a number exists gets
    // the order backwards.
    withScopedData({ action: "operate", wabaId: data?.wabaId, scope: "any" }, (gateway, org) =>
      gateway.readSubscriberConfig(org),
    ),
  );

/**
 * Whether a forwarding target exists: the one setup fact the root loader
 * cannot already see (`lib/setup-checklist.ts`).
 *
 * Not the config, on purpose: this rides every page load, and the URL itself is
 * nobody's business outside the Webhooks page. `action: "view"`, because seeing
 * that a step is done is not configuring anything.
 *
 * `null` when the read failed. The held banner fires on a single pending row,
 * so a failed read must not pass for "no target" on an account that has one.
 */
export const hasForwardingTarget = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(async ({ data }): Promise<boolean | null> => {
    const res = await withScopedRead({ action: "view", wabaId: data?.wabaId, scope: "any" }, (gateway, org) =>
      gateway.readSubscriberConfig(org),
    );
    return res.ok ? res.data.data.url !== null : null;
  });

/** Deployment-wide facts the console quotes; each is null when unset or unread. */
export interface Deployment {
  /** `SUPPORT_EMAIL`: where "contact Eccos support" leads. */
  supportEmail: string | null;
  /** The gateway's content window, which also bounds how long an event is held. */
  contentRetentionDays: number | null;
}

export const getDeployment = createServerFn({ method: "GET" }).handler(async (): Promise<Deployment> => {
  // A session is enough: these are the deployment's facts, not an organization's.
  const days = await withGateway(async (gateway) => {
    await requireAuthContext(requestAuth(), getRequest());
    return gateway.getContentRetentionDays();
  });
  return {
    supportEmail: (env as { SUPPORT_EMAIL?: string }).SUPPORT_EMAIL?.trim() || null,
    contentRetentionDays: days.ok ? Math.round(days.data) : null,
  };
});

/** Rotate the forwarding target. `secret` is only sent when the operator sets it. */
export const setSubscriberConfig = createServerFn({ method: "POST" })
  .validator(validateSubscriberInput)
  .handler(
    ({ data }): Promise<Result<{ ok: true }>> =>
      withScopedGateway(
        // `scope: "any"`, for the same reason as the read: a subscriber URL
        // written in the awaiting-a-phone state survives provisioning, because
        // the saga's own `saveConfig` only ever writes META_*/CONNECTED_AT keys.
        { action: "subscriber-config", wabaId: data.wabaId, rejectUnknown: true, scope: "any" },
        (gateway, scope) => {
          const { wabaId: _wabaId, ...input } = data;
          return gateway.setSubscriberConfig(input, scope.wabaId, scope.accountId);
        },
      ),
  );

/**
 * Re-run the Meta webhook subscription handshake. Two layers: the outer
 * `Result` reports gateway reachability; the inner `ResubscribeResult` reports
 * whether Meta accepted the (re)subscription.
 */
export const resubscribe = createServerFn({ method: "POST" })
  .validator(validateScopeInput)
  .handler(({ data }): Promise<Result<ResubscribeResult>> =>
    withScopedGateway(
      { action: "resubscribe", wabaId: data?.wabaId, rejectUnknown: true },
      (gateway, scope) => gateway.resubscribe(scope.wabaId, scope.accountId),
    ),
  );


/**
 * Re-run provisioning for one number the account owns (eccos-lpk).
 *
 * The connect callback normally leaves a number `active` before the operator
 * lands here, so this exists for the tail: a Meta hiccup left the row `pending`
 * and the operator should not have to sit through the five-minute cron without
 * a button. `withScopedGateway` is deliberately not used — it refuses a pending
 * WABA, which is the only kind worth re-checking. The account still comes from
 * the organization link and the WABA is re-checked against that account's own
 * registry before the RPC runs; the gateway verifies ownership again.
 */
export const recheckNumber = createServerFn({ method: "POST" })
  .validator(validateWabaInput)
  .handler(({ data }): Promise<Result<ReconcileWabaResult>> =>
    withGateway(async (gateway) => {
      const account = await resolveOrganizationAccount(gateway);
      if (!account.resources.wabas.some((waba) => waba.wabaId === data.wabaId)) {
        throw new Error(`WABA "${data.wabaId}" is not owned by account "${account.accountId}"`);
      }
      return gateway.reconcileWaba(data.wabaId, account.accountId);
    }, "configure"),
  );
