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
  SubscriberConfig,
  TemplatesResult,
} from "@eccos/gateway-contract";

export interface AccountFixture {
  resources: AccountResources;
  subscriber?: Record<string, SubscriberConfig>;
  templates?: Record<string, TemplatesResult>;
}

const EMPTY: AccountResources = { account: null, keys: [], wabas: [], phones: [] };

let accounts = new Map<string, AccountFixture>();
let calls: { method: string; accountId: string }[] = [];
let failing: { method: string; message: string } | null = null;

function owned(method: string, accountId: string, wabaId?: string): AccountFixture {
  calls.push({ method, accountId });
  if (failing?.method === method) throw new Error(failing.message);
  const fixture = accounts.get(accountId) ?? { resources: EMPTY };
  if (wabaId !== undefined && !fixture.resources.wabas.some((waba) => waba.wabaId === wabaId)) {
    throw new Error(`WABA "${wabaId}" is not owned by account "${accountId}"`);
  }
  return fixture;
}

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

  async hasSubscriber(wabaId: string, accountId: string): Promise<boolean> {
    const fixture = owned("hasSubscriber", accountId, wabaId);
    return (fixture.subscriber?.[wabaId]?.url ?? null) !== null;
  }

  async listTemplates(wabaId: string, _limit: number | undefined, accountId: string): Promise<TemplatesResult> {
    const fixture = owned("listTemplates", accountId, wabaId);
    return fixture.templates?.[wabaId] ?? { ok: true, data: { data: [] } };
  }

  // Test controls.

  async reset(): Promise<void> {
    accounts = new Map();
    calls = [];
    failing = null;
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
}

export default { fetch: () => new Response("Not Found", { status: 404 }) };
