/**
 * A stand-in for the console's `ConsoleRPC` entrypoint (apps/dashboard), for the Worker tests
 * and for `wrangler dev` evidence runs. Never deployed.
 *
 * Tokens are opaque strings a test registers with the result `authorize` should give. Every
 * `authorize` call is recorded, so a test can count them. An elevation approved here shows up in
 * the next `authorize` result's `actor.elevatedUntil`, as the real console's would.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActorRef,
  AuthorizeResult,
  BillingLink,
  BillingResult,
  ConsoleApi,
  ElevationRequest,
  ElevationResult,
} from "@eccos/console-contract";
import type { GatewayApi } from "@eccos/gateway-contract";

const APPROVAL_PAGE = "https://console.example.test/agents/approve";
const REQUEST_TTL_MS = 10 * 60_000;

interface State {
  grants: Map<string, AuthorizeResult>;
  authorizeCalls: { resource: string; token: string }[];
  elevations: Map<string, number>;
  pending: Map<string, ElevationRequest>;
  elevationCalls: { actor: ActorRef; tool: string }[];
  billing: Map<string, BillingResult>;
  elevationRefusal: ElevationResult | null;
}

const fresh = (): State => ({
  grants: new Map(),
  authorizeCalls: [],
  elevations: new Map(),
  pending: new Map(),
  elevationCalls: [],
  billing: new Map(),
  elevationRefusal: null,
});

let state = fresh();

const grantKey = (actor: Pick<ActorRef, "userId" | "clientId" | "organizationId">) =>
  `${actor.userId}:${actor.clientId}:${actor.organizationId}`;

export class ConsoleRPC extends WorkerEntrypoint implements ConsoleApi {
  async authorize(resource: string, token: string): Promise<AuthorizeResult> {
    state.authorizeCalls.push({ resource, token });
    const result = state.grants.get(token);
    if (!result) return { ok: false, code: "invalid_token" };
    if (!result.ok) return result;
    const elevatedUntil = state.elevations.get(grantKey(result.actor)) ?? result.actor.elevatedUntil;
    return { ...result, actor: { ...result.actor, elevatedUntil } };
  }

  async requestElevation(actor: ActorRef, tool: string): Promise<ElevationResult> {
    state.elevationCalls.push({ actor, tool });
    if (state.elevationRefusal) return state.elevationRefusal;
    const key = grantKey(actor);
    const open = state.pending.get(key);
    if (open && open.expiresAt > Date.now()) return { ok: true, request: open };
    const requestId = crypto.randomUUID();
    const request = { requestId, url: `${APPROVAL_PAGE}?request=${requestId}`, expiresAt: Date.now() + REQUEST_TTL_MS };
    state.pending.set(key, request);
    return { ok: true, request };
  }

  async getBilling(actor: ActorRef): Promise<BillingResult> {
    return state.billing.get(actor.accountId) ?? { ok: false, code: "billing_disabled" };
  }

  async startCheckout(): Promise<BillingLink> {
    return { ok: false, code: "billing_disabled" };
  }

  async openBillingPortal(): Promise<BillingLink> {
    return { ok: false, code: "billing_disabled" };
  }

  // Test controls. The real ConsoleRPC has none of these.

  async reset(): Promise<void> {
    state = fresh();
  }

  async grant(token: string, result: AuthorizeResult): Promise<void> {
    state.grants.set(token, result);
  }

  async revoke(token: string): Promise<void> {
    state.grants.set(token, { ok: false, code: "revoked" });
  }

  /** What a person approving the pending request does: elevate the grant until `until`. */
  async approve(actor: Pick<ActorRef, "userId" | "clientId" | "organizationId">, until: number): Promise<void> {
    const key = grantKey(actor);
    state.elevations.set(key, until);
    state.pending.delete(key);
  }

  async setBilling(accountId: string, billing: BillingResult): Promise<void> {
    state.billing.set(accountId, billing);
  }

  async refuseElevation(refusal: ElevationResult | null): Promise<void> {
    state.elevationRefusal = refusal;
  }

  async authorizeCalls(): Promise<{ resource: string; token: string }[]> {
    return state.authorizeCalls;
  }

  async elevationCalls(): Promise<{ actor: ActorRef; tool: string }[]> {
    return state.elevationCalls;
  }
}

/**
 * `wrangler dev` evidence runs drive the controls over HTTP: `POST /control/<method>` with a JSON
 * array of arguments. With a GATEWAY binding (tests/dev/wrangler.console.jsonc),
 * `POST /control/provision` creates a workspace's account in the local gateway, as the console's
 * onboarding does, and issues one API key.
 */
export default {
  async fetch(request: Request, env: { GATEWAY?: Pick<GatewayApi, "ensureOrganizationAccount" | "issueApiKey"> }, ctx: ExecutionContext): Promise<Response> {
    const method = new URL(request.url).pathname.replace(/^\/control\//, "");
    if (method === "provision" && request.method === "POST" && env.GATEWAY) {
      const [organizationId, name] = (await request.json()) as [string, string];
      const { accountId } = await env.GATEWAY.ensureOrganizationAccount(organizationId, name);
      const { keyId } = await env.GATEWAY.issueApiKey(accountId, "mcp-evidence");
      return Response.json({ accountId, keyId });
    }
    const controls = new ConsoleRPC(ctx, env as never) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const control = controls[method];
    if (request.method !== "POST" || typeof control !== "function") return new Response("Not Found", { status: 404 });
    const args = (await request.json()) as unknown[];
    return Response.json((await control.apply(controls, args)) ?? null);
  },
};
