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
import type {
  AccountResources,
  ConnectStartResult,
  DashboardInitializationResult,
  DeliveryListOpts,
  DeliveryRecord,
  GatewayApi,
  GatewayStatus,
  InboundRow,
  OutboundRow,
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
  DashboardInitializationResult,
  DeliveryRecord,
  GatewayStatus,
  Health,
  InboundRow,
  OperatorCounts,
  OutboundRow,
  ResubscribeResult,
  SetSubscriberConfigInput,
  SubscriberConfig,
} from "@eccos/gateway-contract";

/**
 * Discriminated result wrapper. Every server function narrows an unconfigured
 * or unreachable gateway to `{ ok: false }` instead of throwing, so pages render
 * a graceful "unreachable" state and a plain `vite build` / SSR without a
 * running gateway never crashes.
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

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
  const organizationId = await requireGatewayPermission(requestAuth(), getRequest(), action);
  const { session } = await requireAuthContext(requestAuth(), getRequest());
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

export type GatewayStatusResult =
  | { ok: true; status: GatewayStatus }
  | { ok: false; error: string };

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
async function withGateway<T>(fn: (gateway: GatewayApi) => Promise<T>): Promise<Result<T>> {
  const gateway = env.GATEWAY;
  if (!gateway) {
    return { ok: false, error: "GATEWAY service binding is not configured" };
  }
  try {
    return { ok: true, data: await fn(gateway) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
  const link = await gateway.getOrganizationAccountLink(organizationId);
  if (!link || link.status !== "active") {
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

async function withScopedGateway<T>(
  fn: (gateway: GatewayApi, scope: ResolvedScope) => Promise<T>,
  requestedWabaId?: string,
  rejectUnknown = false,
): Promise<Result<T>> {
  return withGateway(async (gateway) => {
    const scope = await resolveScope(gateway, requestedWabaId, rejectUnknown);
    return fn(gateway, scope);
  });
}

/** Status page loader — kept returning `{ status }` for the existing route. */
export const getGatewayStatus = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(
    async ({ data }): Promise<GatewayStatusResult> => {
      await requireGatewayPermission(requestAuth(), getRequest(), "view");
      const res = await withScopedGateway(
        (gateway, scope) => gateway.getStatus(scope.wabaId, scope.accountId),
        data?.wabaId,
      );
      return res.ok ? { ok: true, status: res.data } : res;
    },
  );

export const getDashboardScope = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(
    async ({ data }): Promise<Result<DashboardScope>> => {
      await requireGatewayPermission(requestAuth(), getRequest(), "view");
      return withScopedGateway((_, scope) => Promise.resolve(dashboardScope(scope)), data?.wabaId);
    },
  );

export const getDashboardState = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(
    ({ data }): Promise<DashboardStateResult> =>
      withGateway(async (gateway) => {
        await requireGatewayPermission(requestAuth(), getRequest(), "view");
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
    async ({ data }): Promise<DashboardOverviewResult> => {
      await requireGatewayPermission(requestAuth(), getRequest(), "view");
      return withScopedGateway(
        async (gateway, scope) => ({
          status: await gateway.getStatus(scope.wabaId, scope.accountId),
          scope: dashboardScope(scope),
        }),
        data?.wabaId,
      );
    },
  );

export const getAccountResources = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<AccountResources>> => {
    await requireGatewayPermission(requestAuth(), getRequest(), "view");
    return withGateway(async (gateway) => {
      const account = await resolveOrganizationAccount(gateway);
      return account.resources;
    });
  },
);

export const startConnect = createServerFn({ method: "POST" }).handler(
  (): Promise<Result<ConnectStartResult>> =>
    withGateway(async (gateway) => {
      // Embedded Signup is an admin+ mutation (contract §4): step-up policy is
      // enforced by eccos-0x0.7; the account comes from the organization link.
      const actor = await requireActor("administer");
      const link = await gateway.getOrganizationAccountLink(actor.organizationId);
      if (!link || link.status !== "active") {
        throw new Error("This organization is not linked to an Eccos account");
      }
      const result = await gateway.startConnectForAccountId(link.accountId);
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
    async ({ data }): Promise<Result<DeliveryRecord[]>> => {
      await requireGatewayPermission(requestAuth(), getRequest(), "view");
      return withScopedGateway(
        (gateway, scope) => gateway.listDeliveries({ ...data, wabaId: scope.wabaId }, scope.accountId),
        data?.wabaId,
      );
    },
  );

export const listInbound = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(async ({ data }): Promise<Result<InboundRow[]>> => {
    await requireGatewayPermission(requestAuth(), getRequest(), "view");
    return withScopedGateway(
      (gateway, scope) => gateway.listInbound({ wabaId: scope.wabaId }, scope.accountId),
      data?.wabaId,
    );
  });

export const listOutbound = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(async ({ data }): Promise<Result<OutboundRow[]>> => {
    await requireGatewayPermission(requestAuth(), getRequest(), "view");
    return withScopedGateway(
      (gateway, scope) => gateway.listOutbound({ wabaId: scope.wabaId }, scope.accountId),
      data?.wabaId,
    );
  });

export const listTemplates = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(async ({ data }): Promise<Result<TemplatesResult>> => {
    await requireGatewayPermission(requestAuth(), getRequest(), "view");
    return withScopedGateway(
      async (gateway, scope) =>
        (await gateway.listTemplates(scope.wabaId, 100, scope.accountId)) as TemplatesResult,
      data?.wabaId,
    );
  });

export const retryDelivery = createServerFn({ method: "POST" })
  .validator(validateRetryInput)
  .handler(
    async ({ data }): Promise<Result<{ ok: boolean; previousStatus: string | null }>> => {
      await requireGatewayPermission(requestAuth(), getRequest(), "operate");
      return withScopedGateway(
        (gateway, scope) => gateway.retryDelivery(data.id, scope.wabaId, scope.accountId),
        data.wabaId,
        true,
      );
    },
  );

// --- Operator actions (settings page) ---

/** Read the current outbound-forwarding target. The secret is never exposed. */
export const getSubscriberConfig = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(async ({ data }): Promise<Result<SubscriberConfig>> => {
    await requireGatewayPermission(requestAuth(), getRequest(), "operate");
    return withScopedGateway(
      (gateway, scope) => gateway.getSubscriberConfig(scope.wabaId, scope.accountId),
      data?.wabaId,
    );
  });

/** Rotate the forwarding target. `secret` is only sent when the operator sets it. */
export const setSubscriberConfig = createServerFn({ method: "POST" })
  .validator(validateSubscriberInput)
  .handler(
    async ({ data }): Promise<Result<{ ok: true }>> => {
      await requireGatewayPermission(requestAuth(), getRequest(), "configure");
      return withScopedGateway(
        (gateway, scope) => {
          const { wabaId: _wabaId, ...input } = data;
          return gateway.setSubscriberConfig(input, scope.wabaId, scope.accountId);
        },
        data.wabaId,
        true,
      );
    },
  );

/**
 * Re-run the Meta webhook subscription handshake. Two layers: the outer
 * `Result` reports gateway reachability; the inner `ResubscribeResult` reports
 * whether Meta accepted the (re)subscription.
 */
export const resubscribe = createServerFn({ method: "POST" })
  .validator(validateScopeInput)
  .handler(async ({ data }): Promise<Result<ResubscribeResult>> => {
    await requireGatewayPermission(requestAuth(), getRequest(), "configure");
    return withScopedGateway(
      (gateway, scope) => gateway.resubscribe(scope.wabaId, scope.accountId),
      data?.wabaId,
      true,
    );
  });
