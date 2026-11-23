/**
 * A stand-in for the gateway's `GatewayRPC` entrypoint, for the Worker tests. Only the methods
 * the MCP tools call exist. Every call records the account id it was made for, so a test can
 * prove an actor of one account never reaches another; a WABA the account does not own is
 * refused, as the real ownership check does.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountKeyResource,
  AccountResources,
  ConnectLinkSummary,
  GatewayStatus,
  IssuedConnectLink,
  ReconcileWabaResult,
  SubscriberConfig,
  TemplatesResult,
} from "@eccos/gateway-contract";

export interface AccountFixture {
  resources: AccountResources;
  subscriber?: Record<string, SubscriberConfig>;
  templates?: Record<string, TemplatesResult>;
  status?: Record<string, GatewayStatus>;
  reconcile?: Record<string, ReconcileWabaResult>;
  connectLink?: ConnectLinkSummary;
}

export interface ConnectLinkIssue {
  accountId: string;
  creatorUserId: string;
  replace: boolean | undefined;
}

const EMPTY: AccountResources = { account: null, keys: [], wabas: [], phones: [] };
const LINK_TTL_MS = 7 * 86_400_000;

let accounts = new Map<string, AccountFixture>();
let calls: { method: string; accountId: string }[] = [];
let failing: { method: string; message: string } | null = null;
let issues: ConnectLinkIssue[] = [];

function owned(method: string, accountId: string, wabaId?: string): AccountFixture {
  calls.push({ method, accountId });
  if (failing?.method === method) throw new Error(failing.message);
  const fixture = accounts.get(accountId) ?? { resources: EMPTY };
  if (wabaId !== undefined && !fixture.resources.wabas.some((waba) => waba.wabaId === wabaId)) {
    throw new Error(`WABA "${wabaId}" is not owned by account "${accountId}"`);
  }
  return fixture;
}

const isLive = (link: ConnectLinkSummary | undefined) => link?.state === "pending" || link?.state === "opened";

export class GatewayRPC extends WorkerEntrypoint {
  async listAccountResources(accountId: string): Promise<AccountResources> {
    return owned("listAccountResources", accountId).resources;
  }

  async listApiKeys(accountId: string): Promise<AccountKeyResource[]> {
    return owned("listApiKeys", accountId).resources.keys;
  }

  async getSubscriberConfig(wabaId: string, accountId: string): Promise<SubscriberConfig> {
    const fixture = owned("getSubscriberConfig", accountId, wabaId);
    return fixture.subscriber?.[wabaId] ?? { url: null, hasSecret: false, lastForward: null };
  }

  async listTemplates(wabaId: string, _limit: number | undefined, accountId: string): Promise<TemplatesResult> {
    const fixture = owned("listTemplates", accountId, wabaId);
    return fixture.templates?.[wabaId] ?? { ok: true, data: { data: [] } };
  }

  /** As the real one: only an active WABA the account owns has a status. */
  async getStatus(wabaId: string, accountId: string): Promise<GatewayStatus> {
    const fixture = owned("getStatus", accountId);
    const waba = fixture.resources.wabas.find((candidate) => candidate.wabaId === wabaId && candidate.status === "active");
    if (!waba) throw new Error(`WABA "${wabaId}" is not owned by account "${accountId}"`);
    return (
      fixture.status?.[wabaId] ?? {
        name: "eccos",
        version: "0.1.0",
        health: "healthy",
        connection: { wabaId, phoneNumberId: null, displayPhone: null, connectedAt: null },
        counts: { inbound: 0, outbound: {}, deliveries: {} },
      }
    );
  }

  /** As the real one: an unowned WABA is a refusal value, not a throw. */
  async reconcileWaba(wabaId: string, accountId: string): Promise<ReconcileWabaResult> {
    const fixture = owned("reconcileWaba", accountId);
    if (!fixture.resources.wabas.some((waba) => waba.wabaId === wabaId)) {
      return { ok: false, error: `WABA "${wabaId}" is not owned by account "${accountId}"` };
    }
    return fixture.reconcile?.[wabaId] ?? { ok: true, status: "active", error: null };
  }

  async getConnectLink(accountId: string): Promise<ConnectLinkSummary | null> {
    return owned("getConnectLink", accountId).connectLink ?? null;
  }

  /** As the control plane: a live link is kept unless `replace`, which supersedes it. */
  async issueConnectLink(accountId: string, creatorUserId: string, replace?: boolean): Promise<IssuedConnectLink | "exists"> {
    const fixture = owned("issueConnectLink", accountId);
    issues.push({ accountId, creatorUserId, replace });
    if (!replace && isLive(fixture.connectLink)) return "exists";
    const issued = { token: `ecl_${crypto.randomUUID().replaceAll("-", "")}`, expiresAt: Date.now() + LINK_TTL_MS };
    fixture.connectLink = { state: "pending", expiresAt: issued.expiresAt, connectedPhone: null, creatorUserId };
    accounts.set(accountId, fixture);
    return issued;
  }

  // Test controls.

  async reset(): Promise<void> {
    accounts = new Map();
    calls = [];
    failing = null;
    issues = [];
  }

  async seed(accountId: string, fixture: AccountFixture): Promise<void> {
    accounts.set(accountId, fixture);
  }

  /** Make `method` throw with `message`, as a failing gateway would. */
  async fail(method: string, message: string): Promise<void> {
    failing = { method, message };
  }

  async calls(): Promise<{ method: string; accountId: string }[]> {
    return calls;
  }

  async connectLinkIssues(): Promise<ConnectLinkIssue[]> {
    return issues;
  }
}

export default { fetch: () => new Response("Not Found", { status: 404 }) };
