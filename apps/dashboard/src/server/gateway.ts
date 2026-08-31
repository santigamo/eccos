import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { createAuth, type Auth } from "../auth/auth";
import { authConfigFromEnv } from "../auth/config";
import { auditEvent } from "./audit";
import {
  requireAuthContext,
  requireGatewayPermission,
  UnauthorizedError,
} from "../auth/server-auth";
import { ForbiddenError, resolveMemberships } from "../auth/tenant";
import type { ForbiddenReason, GatewayAction, Membership } from "../auth/tenant";
import type {
  AccountResources,
  ConnectStartResult,
  DeliveryListOpts,
  DeliveryRecord,
  GatewayApi,
  GatewayStatus,
  InboundRow,
  OutboundRow,
  ReconcileWabaResult,
  ResubscribeResult,
  SetSubscriberConfigInput,
  SubscriberConfig,
} from "@eccos/gateway-contract";

type DashboardListOpts = Omit<DeliveryListOpts, "wabaId">;

// Re-export the shared contract types the routes render against, so the whole
// dashboard reads the operator surface from a single source of truth
// (`@eccos/gateway-contract`) — no more hand-mirrored shapes.
export type {
  AccountResources,
  ConnectStartResult,
  DeliveryRecord,
  GatewayStatus,
  Health,
  InboundRow,
  OperatorCounts,
  OutboundRow,
  ProvisioningStatus,
  ReconcileWabaResult,
  ResubscribeResult,
  SetSubscriberConfigInput,
  SubscriberConfig,
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

/**
 * Identity-plane access (contract §1/§5): every server function resolves the
 * session server-side and re-validates the organization permission via the
 * `auth/server-auth` seam. There is no installation identity, no
 * browser-supplied accountId, and no cross-request authorization caching.
 */

/** Build the request-scoped auth instance from the Worker bindings. */
function requestAuth(): Auth {
  return createAuth(authConfigFromEnv(env));
}

/** Authenticated actor context for audit events. */
interface ActorContext {
  organizationId: string;
  session: { userId: string; email: string };
}

async function requireActor(action: "view" | "operate" | "configure" | "administer" | "erase"): Promise<ActorContext> {
  // One auth instance and one Request per actor resolution; the request-scoped
  // session memo (request-memo.ts) additionally dedupes the underlying
  // `auth.api.getSession` to a single D1 read per request (eccos-ya5).
  const auth = requestAuth();
  const request = getRequest();
  const organizationId = await requireGatewayPermission(auth, request, action);
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
  | { stage: "account-ready"; resources: AccountResources }
  | { stage: "ready"; status: GatewayStatus; scope: DashboardScope };
export type DashboardStateResult = Result<DashboardState>;
export type DashboardScopeInput = { wabaId?: string };

const WABA_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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

function validateScopeInput(input: unknown): DashboardScopeInput | undefined {
  if (input === undefined) return undefined;
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  return wabaId ? { wabaId } : {};
}

function validateDeliveryInput(input: unknown): (DashboardListOpts & DashboardScopeInput) | undefined {
  if (input === undefined) return undefined;
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  const status = record.status === undefined ? undefined : record.status;
  if (status !== undefined && (typeof status !== "string" || status.length === 0 || status.length > 100)) {
    throw new Error("status must be a non-empty string");
  }
  const limit = record.limit === undefined ? undefined : record.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)) {
    throw new Error("limit must be a positive integer");
  }
  const before = record.before === undefined ? undefined : record.before;
  if (before !== undefined && (typeof before !== "number" || !Number.isSafeInteger(before) || before <= 0)) {
    throw new Error("before must be a positive integer");
  }
  return { ...(wabaId ? { wabaId } : {}), ...(status !== undefined ? { status } : {}), ...(limit !== undefined ? { limit } : {}), ...(before !== undefined ? { before } : {}) };
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

/** A WABA the operator is asking about by id; the account is never theirs to pick. */
function validateWabaInput(input: unknown): { wabaId: string } {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  return { wabaId };
}

function validateSubscriberInput(input: unknown): SetSubscriberConfigInput & DashboardScopeInput {
  const record = inputRecord(input);
  if (typeof record.url !== "string" || record.url.trim() === "") throw new Error("url must be a non-empty string");
  if (record.secret !== undefined && typeof record.secret !== "string") throw new Error("secret must be a string");
  const wabaId = optionalWabaId(record.wabaId);
  const secret = typeof record.secret === "string" ? record.secret.trim() : "";
  return { url: record.url, ...(secret ? { secret } : {}), ...(wabaId ? { wabaId } : {}) };
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
  fn: (gateway: GatewayApi) => Promise<T>,
  action?: GatewayAction,
): Promise<Result<T>> {
  const gateway = env.GATEWAY;
  if (!gateway) {
    return { ok: false, kind: "unreachable", error: "GATEWAY service binding is not configured" };
  }
  try {
    // The permission check runs INSIDE the boundary on purpose: an
    // authorization refusal must come back classified as one, not escape as a
    // thrown server-function error (or, worse, get reported as a dead gateway).
    if (action) await requireGatewayPermission(requestAuth(), getRequest(), action);
    return { ok: true, data: await fn(gateway) };
  } catch (err) {
    return classifyFailure(err);
  }
}

/**
 * Name the failure from the error's type (eccos-k5a).
 *
 * `ForbiddenError` and `UnauthorizedError` are raised by the identity plane
 * before the RPC is attempted, so they say nothing about the gateway; anything
 * else escaping the call is a transport or RPC failure, which is the only case
 * allowed to blame the service binding. `instanceof` is the discriminator, with
 * the class's own `name` brand as the fallback that survives a duplicated
 * module copy (bundler chunk, test mock) — never the message text.
 */
async function classifyFailure(err: unknown): Promise<Failure> {
  if (err instanceof UnauthorizedError || isNamed(err, "UnauthorizedError")) {
    return { ok: false, kind: "unauthenticated", error: message(err) };
  }
  if (err instanceof ForbiddenError || isNamed(err, "ForbiddenError")) {
    const reason = (err as ForbiddenError).reason ?? "other";
    if (reason === "select-organization") {
      // The remedy is the choice itself, so this one branch pays to fetch it.
      // A failure to list them degrades to the sentence without a picker,
      // never to a wrong cause.
      const organizations = await resolveMemberships(requestAuth(), getRequest().headers).catch(
        () => [] as Membership[],
      );
      return { ok: false, kind: "forbidden", reason, error: message(err), organizations };
    }
    return { ok: false, kind: "forbidden", reason, error: message(err) };
  }
  return { ok: false, kind: "unreachable", error: message(err) };
}

function isNamed(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/**
 * Resolve the Eccos account for the signed-in user's organization (contract §1):
 * session → membership → organization_accounts link → account. The link is the
 * server-owned mapping in the control plane; a pending/disabled/unknown link
 * fails closed. The org id is re-validated against membership inside
 * requirePermission before any RPC runs.
 */
async function resolveOrganizationAccount(
  gateway: GatewayApi,
): Promise<ResolvedAccount> {
  const organizationId = await requireGatewayPermission(requestAuth(), getRequest(), "view");
  let link = await gateway.getOrganizationAccountLink(organizationId);
  if (!link) {
    // Self-healing reconcile (contract §2): the organization exists in the
    // identity plane but predates its account link (e.g. created during the
    // cutover). The idempotent saga converges to exactly one account + one
    // active link and never issues an API key; verified callers only (a
    // gateway:view permission was already required above).
    // ensureOrganizationAccount always activates on create; "existing"
    // cannot occur here because the link was just read as absent.
    const ensured = await gateway.ensureOrganizationAccount(organizationId);
    link = { accountId: ensured.accountId, status: "active" };
  }
  if (link.status !== "active") {
    throw new Error("This organization is not linked to an Eccos account");
  }
  const resources = await gateway.listAccountResources(link.accountId);
  if (!resources.account) throw new Error(`Account "${link.accountId}" is not configured`);
  return { accountId: link.accountId, resources };
}

function resolveScopeFromAccount(
  account: ResolvedAccount,
  requestedWabaId?: string,
  rejectUnknown = false,
): ResolvedScope {
  const requested = requestedWabaId?.trim() || undefined;
  const { accountId, resources } = account;
  const wabas = [...resources.wabas].sort((a, b) => a.wabaId.localeCompare(b.wabaId));
  const requestedIsOwned = requested ? wabas.some((waba) => waba.wabaId === requested) : false;
  if (requested && !requestedIsOwned && rejectUnknown) {
    throw new Error(`WABA "${requested}" is not owned by account "${accountId}"`);
  }
  const selectedWaba = requestedIsOwned ? wabas.find((waba) => waba.wabaId === requested) : wabas[0];
  const wabaId = selectedWaba?.wabaId;
  if (!wabaId) throw new Error(`Account "${accountId}" has no registered WABAs`);
  if (selectedWaba?.status === "pending") throw new Error(`WABA "${wabaId}" is still provisioning`);
  if (selectedWaba?.status === "failed") throw new Error(`WABA "${wabaId}" provisioning failed`);
  return { wabaId, accountId, resources };
}

async function resolveScope(
  gateway: GatewayApi,
  requestedWabaId?: string,
  rejectUnknown = false,
): Promise<ResolvedScope> {
  const account = await resolveOrganizationAccount(gateway);
  return resolveScopeFromAccount(account, requestedWabaId, rejectUnknown);
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

/** What a scoped server function needs from its caller. */
interface ScopedOptions {
  /** Permission the operation requires, checked inside the failure boundary. */
  action: GatewayAction;
  /** WABA the operator asked about; the account is never theirs to pick. */
  wabaId?: string;
  /** Refuse a WABA the account does not own instead of falling back to its first. */
  rejectUnknown?: boolean;
}

async function withScopedGateway<T>(
  options: ScopedOptions,
  fn: (gateway: GatewayApi, scope: ResolvedScope) => Promise<T>,
): Promise<Result<T>> {
  return withGateway(async (gateway) => {
    const scope = await resolveScope(gateway, options.wabaId, options.rejectUnknown ?? false);
    return fn(gateway, scope);
  }, options.action);
}

/** Status page loader — kept returning `{ status }` for the existing route. */
export const getGatewayStatus = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(
    async ({ data }): Promise<GatewayStatusResult> => {
      const res = await withScopedGateway(
        { action: "view", wabaId: data?.wabaId },
        (gateway, scope) => gateway.getStatus(scope.wabaId, scope.accountId),
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
        await requireGatewayPermission(auth, request, "view");
        const account = await resolveOrganizationAccount(gateway);
        const wabas = [...account.resources.wabas].sort((a, b) => a.wabaId.localeCompare(b.wabaId));
        if (wabas.length === 0) {
          return { stage: "account-ready", resources: account.resources };
        }
        const scope = resolveScopeFromAccount(account, data?.wabaId);
        return {
          stage: "ready",
          status: await gateway.getStatus(scope.wabaId, scope.accountId),
          scope: dashboardScope(scope),
        };
      }),
  );

export const getDashboardOverview = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(
    ({ data }): Promise<DashboardOverviewResult> =>
      withScopedGateway({ action: "view", wabaId: data?.wabaId }, async (gateway, scope) => ({
        status: await gateway.getStatus(scope.wabaId, scope.accountId),
        scope: dashboardScope(scope),
      })),
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
      // Embedded Signup is an admin+ mutation (contract §4): step-up policy is
      // enforced by eccos-0x0.7; the account comes from the organization link.
      const actor = await requireActor("administer");
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
      return result;
    }),
);

export const listDeliveries = createServerFn({ method: "GET" })
  .validator(validateDeliveryInput)
  .handler(
    ({ data }): Promise<Result<DeliveryRecord[]>> =>
      withScopedGateway({ action: "view", wabaId: data?.wabaId }, (gateway, scope) =>
        gateway.listDeliveries({ ...data, wabaId: scope.wabaId }, scope.accountId),
      ),
  );

export const listInbound = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(({ data }): Promise<Result<InboundRow[]>> =>
    withScopedGateway({ action: "view", wabaId: data?.wabaId }, (gateway, scope) =>
      gateway.listInbound({ wabaId: scope.wabaId }, scope.accountId),
    ),
  );

export const listOutbound = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(({ data }): Promise<Result<OutboundRow[]>> =>
    withScopedGateway({ action: "view", wabaId: data?.wabaId }, (gateway, scope) =>
      gateway.listOutbound({ wabaId: scope.wabaId }, scope.accountId),
    ),
  );

export const listTemplates = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(({ data }): Promise<Result<TemplatesResult>> =>
    withScopedGateway(
      { action: "view", wabaId: data?.wabaId },
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

// --- Operator actions (settings page) ---

/** Read the current outbound-forwarding target. The secret is never exposed. */
export const getSubscriberConfig = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(({ data }): Promise<Result<SubscriberConfig>> =>
    withScopedGateway({ action: "operate", wabaId: data?.wabaId }, (gateway, scope) =>
      gateway.getSubscriberConfig(scope.wabaId, scope.accountId),
    ),
  );

/** Rotate the forwarding target. `secret` is only sent when the operator sets it. */
export const setSubscriberConfig = createServerFn({ method: "POST" })
  .validator(validateSubscriberInput)
  .handler(
    ({ data }): Promise<Result<{ ok: true }>> =>
      withScopedGateway(
        { action: "configure", wabaId: data.wabaId, rejectUnknown: true },
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
      { action: "configure", wabaId: data?.wabaId, rejectUnknown: true },
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
