/**
 * The ConsoleRPC contract: what the console Worker serves to `apps/mcp` over a private
 * service binding (design § 2.2, openspec/changes/add-mcp-server).
 *
 * The console implements `ConsoleApi` on its `ConsoleRPC` entrypoint; `apps/mcp` calls it
 * through the `CONSOLE` binding. Types plus the scope vocabulary, no implementation.
 *
 * Refusals come back as values, never as thrown errors: an error crossing Workers RPC keeps
 * only its message, and `OAuthResourceServer` must build its challenge in the MCP Worker.
 */

import type { ConnectPolicy } from "@eccos/gateway-contract";

/**
 * The OAuth scopes the MCP resource advertises, each mapped to the one action it grants
 * (design § 3.2). `offline_access` grants no action and is not listed. There is no scope for
 * erasure.
 */
export const AGENT_SCOPES = {
  "eccos:view": "view",
  "eccos:operate": "operate",
  "eccos:send": "send",
  "eccos:configure": "configure",
  "eccos:administer": "administer",
} as const;

export type AgentScope = keyof typeof AGENT_SCOPES;

/**
 * What an agent may do. The role matrix's actions minus `erase`, plus `send`, which the
 * matrix grants to operator+ and the token grants only with `eccos:send`.
 */
export type AgentAction = (typeof AGENT_SCOPES)[AgentScope];

export type MemberRole = "owner" | "admin" | "operator" | "viewer";

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
  /** Epoch ms until which the grant is elevated, or null. Only step-up tools read it. */
  elevatedUntil: number | null;
  clientId: string;
}

/**
 * The grant a console call is about: (user, client, workspace) and its account. `apps/mcp`
 * passes only an actor that `authorize` returned on the same request. It names the grant; it
 * is not evidence of a role, so the console re-reads whatever it needs to decide.
 */
export type ActorRef = Pick<Actor, "userId" | "organizationId" | "accountId" | "clientId">;

/** Every reason stays inside Eccos: `apps/mcp` answers each with the same `401` challenge. */
export type AuthorizeRefusal = "invalid_token" | "revoked" | "not_a_member" | "no_account";

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
      clientId: string;
    }
  | { ok: false; reason: AuthorizeRefusal };

/** An open approval request for a grant's elevation (design § 3.3). */
export interface ElevationRequest {
  /** Sealed into the URL-mode elicitation's `requestState`; never a capability. */
  requestId: string;
  /** The console's approval page. Only the grant's own user, still owner or admin, can approve. */
  url: string;
  /** Epoch ms. A request lives 10 minutes. */
  expiresAt: number;
}

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
 * A Creem link for a person to open. `checkout` starts a subscription; `portal` manages the
 * existing one, which is what `startCheckout` returns while a subscription still exists.
 */
export type BillingLink =
  | { ok: true; kind: "checkout" | "portal"; url: string }
  | { ok: false; reason: BillingRefusal };

/**
 * `billing_disabled`: this deployment runs without billing. `no_billing_account`: the portal
 * was asked for before the workspace ever checked out. `forbidden`: the user's live role does
 * not allow it.
 */
export type BillingRefusal = "billing_disabled" | "no_billing_account" | "forbidden";

export interface ConsoleApi {
  /**
   * Verify the token for this resource and re-derive everything else (design § 2.2): signature,
   * issuer, audience, expiry; the grant still exists; the current membership and role; an
   * `active` account link; the grant's elevation. Called on every MCP request. Never throws for
   * a bad token.
   */
  authorize(resource: string, token: string): Promise<AuthorizeResult>;

  /**
   * Open an approval request for this grant, or return the one already pending, so every
   * step-up call made while it is pending carries the same URL. `tool` is the tool that asked,
   * shown to the person on the approval page.
   */
  requestElevation(actor: ActorRef, tool: string): Promise<ElevationRequest>;

  /** The workspace's billing, or null when this deployment runs without billing. */
  getBilling(actor: ActorRef): Promise<BillingState | null>;

  /** A checkout for a new subscription, or the portal while one still exists. */
  startCheckout(actor: ActorRef): Promise<BillingLink>;

  /** The portal for the workspace's existing billing account. */
  openBillingPortal(actor: ActorRef): Promise<BillingLink>;
}
