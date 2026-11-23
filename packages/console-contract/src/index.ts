/**
 * The ConsoleRPC contract: what the console Worker serves to `apps/mcp` over a private
 * service binding (design § 2.2, openspec/changes/add-mcp-server).
 *
 * The console implements `ConsoleApi` on its `ConsoleRPC` entrypoint; `apps/mcp` calls it
 * through the `CONSOLE` binding. Types plus the scope vocabulary, no implementation.
 *
 * Every refusal comes back as a value with a `code`, never as a thrown error: an error crossing
 * Workers RPC keeps only its message, and `OAuthResourceServer` must build its challenge in the
 * MCP Worker. A thrown error means the console failed, not that it refused.
 */

import type { GatewayAction, roles } from "@eccos/auth-baseline/permissions";
import type { ConnectPolicy } from "@eccos/gateway-contract";

/**
 * What an agent may do: the role matrix's actions without `erase`, which is never reachable
 * over MCP, plus `send`, which the matrix grants to operator+ and a token grants only with
 * `eccos:send`.
 */
export type AgentAction = Exclude<GatewayAction, "erase"> | "send";

/**
 * The OAuth scopes the MCP resource advertises, each mapped to the one action it grants
 * (design § 3.2). `offline_access` grants no action and is not listed.
 */
export const AGENT_SCOPES = {
  "eccos:view": "view",
  "eccos:operate": "operate",
  "eccos:send": "send",
  "eccos:configure": "configure",
  "eccos:administer": "administer",
} as const satisfies Record<`eccos:${string}`, AgentAction>;

export type AgentScope = keyof typeof AGENT_SCOPES;

/** The organization roles, named by the auth baseline. */
export type MemberRole = keyof typeof roles;

/** Who an MCP request acts as, re-derived by `authorize` on that request and never cached. */
export interface Actor {
  userId: string;
  /** The workspace the grant is bound to; the token names it, membership confirms it. */
  organizationId: string;
  /** Resolved through an `active` organization-to-account link on this request. */
  accountId: string;
  /** The live role, read on this request. */
  role: MemberRole;
  /** The live role's actions intersected with the token's scopes. */
  actions: AgentAction[];
  /**
   * Epoch ms until which the grant is elevated, or null. The console returns null unless the
   * elevation was live when `authorize` ran (now < elevatedUntil); it never returns a lapsed
   * one. A caller still compares against its own clock before running a step-up tool, because
   * an elevation can lapse after `authorize` returned.
   */
  elevatedUntil: number | null;
  clientId: string;
}

/**
 * The grant a console call is about: (user, client, workspace) and its account. `apps/mcp`
 * passes only an actor that `authorize` returned on the same request. It names the grant; it
 * is not evidence of a role, so the console re-reads whatever it needs to decide.
 */
export type ActorRef = Pick<Actor, "userId" | "organizationId" | "accountId" | "clientId">;

/**
 * Why a grant no longer stands. `authorize` can answer any of these, and so can every other
 * method, because the grant can end between `authorize` and the call.
 */
export type GrantRefusalCode = "revoked" | "not_a_member" | "no_account";

/** Every code stays inside Eccos: `apps/mcp` answers each with the same `401` challenge. */
export type AuthorizeRefusalCode = "invalid_token" | GrantRefusalCode;

export type AuthorizeResult =
  | {
      ok: true;
      actor: Actor;
      /** The resource the token is bound to; equals the `resource` passed in. */
      audience: string;
      /** The token's `exp`, seconds since the epoch, as `OAuthResourceServer` expects. */
      expiresAt: number;
      /** The token's scopes, as granted at consent. */
      scope: string[];
    }
  | { ok: false; code: AuthorizeRefusalCode };

/** An open approval request for a grant's elevation (design § 3.3). */
export interface ElevationRequest {
  /** Sealed into the URL-mode elicitation's `requestState`; never a capability. */
  requestId: string;
  /** The console's approval page. Only the grant's own user, still owner or admin, can approve. */
  url: string;
  /** Epoch ms. A request lives 10 minutes. */
  expiresAt: number;
}

/** `forbidden`: the user's live role does not allow it. */
export type ElevationResult =
  | { ok: true; request: ElevationRequest }
  | { ok: false; code: GrantRefusalCode | "forbidden" };

/** The workspace's billing as Settings shows it, read from the control plane only. */
export interface BillingState {
  connectPolicy: ConnectPolicy;
  /** Numbers on active WABAs: what the subscription is priced for. */
  numbers: number;
  monthlyEuros: number;
  hasCustomer: boolean;
  /** The operator set this workspace's policy; false while it follows the deployment default. */
  explicitPolicy: boolean;
}

/**
 * Why a billing call was refused. `forbidden`: the user's live role may not see billing, which
 * in the console takes admin or owner, so an agent never sees more than its person.
 * `billing_disabled`: this deployment runs without billing.
 */
export type BillingRefusalCode = GrantRefusalCode | "forbidden" | "billing_disabled";

export type BillingResult =
  | { ok: true; billing: BillingState }
  | { ok: false; code: BillingRefusalCode };

/**
 * A Creem link for a person to open. `checkout` starts a subscription; `portal` manages the
 * existing one, which is what `startCheckout` returns while a subscription still exists.
 * `no_billing_account`: the portal was asked for before the workspace ever checked out.
 */
export type BillingLink =
  | { ok: true; kind: "checkout" | "portal"; url: string }
  | { ok: false; code: BillingRefusalCode | "no_billing_account" };

export interface ConsoleApi {
  /**
   * Verify the token for this resource and re-derive everything else (design § 2.2): signature,
   * issuer, audience, expiry; the grant still exists; the current membership and role; an
   * `active` account link; the grant's live elevation. Called on every MCP request.
   */
  authorize(resource: string, token: string): Promise<AuthorizeResult>;

  /**
   * Open an approval request for this grant, or return the one already pending, so every
   * step-up call made while it is pending carries the same URL. `tool` is the tool that asked,
   * shown to the person on the approval page.
   */
  requestElevation(actor: ActorRef, tool: string): Promise<ElevationResult>;

  /** The workspace's billing. Admin or owner only, as in the console. */
  getBilling(actor: ActorRef): Promise<BillingResult>;

  /** A checkout for a new subscription, or the portal while one still exists. Admin or owner. */
  startCheckout(actor: ActorRef): Promise<BillingLink>;

  /** The portal for the workspace's existing billing account. Admin or owner. */
  openBillingPortal(actor: ActorRef): Promise<BillingLink>;
}
