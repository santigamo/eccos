/**
 * A stand-in for the gateway's `GatewayRPC` entrypoint, for the Worker tests. Only the methods
 * the MCP tools call exist. Every call records the account id it was made for, so a test can
 * prove an actor of one account never reaches another; a WABA the account does not own is
 * refused, as the real ownership check does. Secret claims follow the control plane's rules
 * (apps/gateway/src/secret-claims.ts): a token shaped `<selector>.<secret>`, 20 pending per
 * account, a subscriber claim cancels the WABA's older ones and needs a WABA the account owns.
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
  ConnectLinkSummary,
  GatewayStatus,
  IssuedApiKey,
  IssuedConnectLink,
  IssuedSecretClaim,
  ReconcileWabaResult,
  ResubscribeResult,
  SecretClaim,
  SecretClaimCreator,
  SecretClaimRequest,
  SetSubscriberConfigInput,
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
  status?: Record<string, GatewayStatus>;
  reconcile?: Record<string, ReconcileWabaResult>;
  resubscribe?: Record<string, ResubscribeResult>;
  connectLink?: ConnectLinkSummary;
  /** Pending claims, newest last; a test may seed them to fill the account's quota. */
  claims?: SecretClaim[];
}

export interface GatewayCall {
  method: string;
  accountId: string;
  /** The write's input, as the gateway received it. */
  input?: unknown;
}

export interface ConnectLinkIssue {
  accountId: string;
  creatorUserId: string;
  replace: boolean | undefined;
}

const EMPTY: AccountResources = { account: null, keys: [], wabas: [], phones: [] };
const LINK_TTL_MS = 7 * 86_400_000;
const CLAIM_TTL_MS = 10 * 60_000;
const MAX_PENDING_CLAIMS = 20;
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

let accounts = new Map<string, AccountFixture>();
let calls: GatewayCall[] = [];
let failing: { method: string; message: string } | null = null;
let issues: ConnectLinkIssue[] = [];
let tokens: string[] = [];

function owned(method: string, accountId: string, wabaId?: string, input?: unknown): AccountFixture {
  calls.push({ method, accountId, ...(input === undefined ? {} : { input }) });
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

  async hasSubscriber(wabaId: string, accountId: string): Promise<boolean> {
    const fixture = owned("hasSubscriber", accountId, wabaId);
    return (fixture.subscriber?.[wabaId]?.url ?? null) !== null;
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

  /** As the real one: an unowned WABA throws; an omitted secret keeps the stored one, null removes it. */
  async setSubscriberConfig(input: SetSubscriberConfigInput, wabaId: string, accountId: string): Promise<{ ok: true }> {
    const fixture = owned("setSubscriberConfig", accountId, wabaId, input);
    if (input.url !== null && !input.url.startsWith("https://")) throw new Error("invalid subscriber URL: must use https");
    const current = fixture.subscriber?.[wabaId] ?? { url: null, hasSecret: false, lastForward: null };
    const hasSecret = input.secret === undefined ? current.hasSecret : input.secret !== null;
    fixture.subscriber = { ...fixture.subscriber, [wabaId]: { ...current, url: input.url, hasSecret } };
    if (input.secret !== undefined) {
      fixture.claims = (fixture.claims ?? []).filter((claim) => !(claim.kind === "subscriber_secret" && claim.wabaId === wabaId));
    }
    accounts.set(accountId, fixture);
    return { ok: true };
  }

  async resubscribe(wabaId: string, accountId: string): Promise<ResubscribeResult> {
    const fixture = owned("resubscribe", accountId);
    if (!fixture.resources.wabas.some((waba) => waba.wabaId === wabaId)) {
      return { ok: false, error: `WABA "${wabaId}" is not owned by account "${accountId}"` };
    }
    return fixture.resubscribe?.[wabaId] ?? { ok: true };
  }

  async issueApiKey(accountId: string, label?: string): Promise<IssuedApiKey> {
    const fixture = owned("issueApiKey", accountId, undefined, { label });
    const keyId = `key_${crypto.randomUUID().replaceAll("-", "")}`;
    const apiKey = `ek_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    fixture.resources.keys = [...fixture.resources.keys, { keyId, label: label ?? null, createdAt: Date.now(), revokedAt: null }];
    accounts.set(accountId, fixture);
    return { keyId, apiKey };
  }

  /** As the control plane: false for a key that is not the account's or is already revoked. */
  async revokeApiKey(accountId: string, keyId: string): Promise<boolean> {
    const fixture = owned("revokeApiKey", accountId, undefined, { keyId });
    const key = fixture.resources.keys.find((candidate) => candidate.keyId === keyId && candidate.revokedAt === null);
    if (!key) return false;
    key.revokedAt = Date.now();
    return true;
  }

  async createSecretClaim(
    accountId: string,
    request: SecretClaimRequest,
    creator: SecretClaimCreator,
  ): Promise<IssuedSecretClaim | "too_many_pending"> {
    const wabaId = request.kind === "subscriber_secret" ? request.wabaId : undefined;
    const fixture = owned("createSecretClaim", accountId, wabaId, { request, creator });
    const now = Date.now();
    const pending = (fixture.claims ?? []).filter(
      (claim) => claim.expiresAt > now && !(claim.kind === "subscriber_secret" && claim.wabaId === wabaId),
    );
    if (pending.length >= MAX_PENDING_CLAIMS) return "too_many_pending";
    const claimId = base64url(crypto.getRandomValues(new Uint8Array(8)));
    const token = `${claimId}.${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    const base = {
      claimId,
      accountId,
      organizationId: `org-of-${accountId}`,
      creatorUserId: creator.userId,
      clientId: creator.clientId,
      createdAt: now,
      expiresAt: now + CLAIM_TTL_MS,
    };
    const claim: SecretClaim =
      request.kind === "api_key" ? { ...base, kind: "api_key", label: request.label ?? null } : { ...base, kind: "subscriber_secret", wabaId: request.wabaId };
    fixture.claims = [...pending, claim];
    accounts.set(accountId, fixture);
    tokens.push(token);
    return { claimId, token, expiresAt: claim.expiresAt };
  }

  async listSecretClaims(accountId: string): Promise<SecretClaim[]> {
    const now = Date.now();
    return (owned("listSecretClaims", accountId).claims ?? []).filter((claim) => claim.expiresAt > now).reverse();
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
    tokens = [];
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

  async connectLinkIssues(): Promise<ConnectLinkIssue[]> {
    return issues;
  }

  /** Every claim token handed out, so a test can look for it where it must not be. */
  async claimTokens(): Promise<string[]> {
    return tokens;
  }
}

export default { fetch: () => new Response("Not Found", { status: 404 }) };
