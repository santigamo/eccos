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
  CreateTemplateInput,
  CreateTemplateResult,
  DeleteTemplateInput,
  DeleteTemplateResult,
  EditTemplateInput,
  EditTemplateResult,
  SendTemplateTestInput,
  SendTemplateTestResult,
  SubscriberConfig,
  TemplatesResult,
} from "@eccos/gateway-contract";

export interface AccountFixture {
  resources: AccountResources;
  subscriber?: Record<string, SubscriberConfig>;
  templates?: Record<string, TemplatesResult>;
  /** What each write answers; a write without one succeeds. */
  results?: {
    createTemplate?: CreateTemplateResult;
    editTemplate?: EditTemplateResult;
    deleteTemplate?: DeleteTemplateResult;
    sendTemplateTest?: SendTemplateTestResult;
  };
}

export interface GatewayCall {
  method: string;
  accountId: string;
  /** The write's input, as the gateway received it. */
  input?: unknown;
}

const EMPTY: AccountResources = { account: null, keys: [], wabas: [], phones: [] };

let accounts = new Map<string, AccountFixture>();
let calls: GatewayCall[] = [];
let failing: { method: string; message: string } | null = null;

function owned(method: string, accountId: string, wabaId?: string, input?: unknown): AccountFixture {
  calls.push({ method, accountId, ...(input === undefined ? {} : { input }) });
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

  async listTemplates(wabaId: string, _limit: number | undefined, accountId: string): Promise<TemplatesResult> {
    const fixture = owned("listTemplates", accountId, wabaId);
    return fixture.templates?.[wabaId] ?? { ok: true, data: { data: [] } };
  }

  async createTemplate(input: CreateTemplateInput, accountId: string): Promise<CreateTemplateResult> {
    const fixture = owned("createTemplate", accountId, input.wabaId, input);
    return fixture.results?.createTemplate ?? { ok: true, id: "990001", status: "PENDING", category: input.category };
  }

  async editTemplate(input: EditTemplateInput, accountId: string): Promise<EditTemplateResult> {
    return owned("editTemplate", accountId, input.wabaId, input).results?.editTemplate ?? { ok: true };
  }

  async deleteTemplate(input: DeleteTemplateInput, accountId: string): Promise<DeleteTemplateResult> {
    return owned("deleteTemplate", accountId, input.wabaId, input).results?.deleteTemplate ?? { ok: true };
  }

  /** Like the real one: an unowned or non-active WABA throws, an unknown phone is a result. */
  async sendTemplateTest(input: SendTemplateTestInput, accountId: string): Promise<SendTemplateTestResult> {
    const fixture = owned("sendTemplateTest", accountId, input.wabaId, input);
    const waba = fixture.resources.wabas.find((candidate) => candidate.wabaId === input.wabaId);
    if (waba?.status !== "active") throw new Error(`WABA "${input.wabaId}" is not owned by account "${accountId}"`);
    if (!waba.phones.some((phone) => phone.phoneNumberId === input.phoneNumberId)) {
      return { ok: false, code: "no_phone", detail: null };
    }
    return fixture.results?.sendTemplateTest ?? { ok: true, messageId: "wamid.STUB1" };
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

  async calls(): Promise<GatewayCall[]> {
    return calls;
  }
}

export default { fetch: () => new Response("Not Found", { status: 404 }) };
