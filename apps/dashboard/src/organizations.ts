/**
 * Organization onboarding server functions (eccos-0x0.5, contract §7).
 *
 * Signup is allowlisted (contract §7): the first verified user creates their
 * organization; additional members join through verified-email invitations.
 * Organization creation triggers the idempotent organization→account
 * provisioning saga on the gateway control plane — no API key is issued.
 */

import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import * as Sentry from "@sentry/cloudflare";
import { env } from "cloudflare:workers";
import type { GatewayApi } from "@eccos/gateway-contract";
import type { Failure } from "./server/gateway";
import { auditEvent } from "./server/audit";
import { getAuthForRequest } from "./auth/request-auth";
import { UnauthorizedError, requireAuthContext, requireGatewayPermission } from "./auth/server-auth";
import { classifyFailure } from "./server/classify-failure";
import {
  ForbiddenError,
  resolveMemberships,
  verifyMembership,
  type Membership,
} from "./auth/tenant";
import { activeWorkspace } from "./lib/workspaces";
import { isReseller } from "./billing/reseller";
import {
  INVITATION_COPY,
  INVITATION_RETRY,
  INVITATION_SIGNED_OUT,
  INVITATION_UNAVAILABLE,
} from "./lib/invitation-copy";

export interface OrganizationView {
  id: string;
  name: string;
  role: string | null;
  accountId: string | null;
  linkStatus: "active" | "pending" | "disabled" | null;
}

export interface PendingInvitationView {
  invitationId: string;
  organizationName: string;
  inviterName: string;
  email: string;
  role: string | null;
}

function authInstance() {
  return getAuthForRequest(getRequest(), env);
}

/** The current request (server environment). */
function currentRequest(): Request {
  return getRequest();
}

function withGateway<T>(fn: (gateway: GatewayApi) => Promise<T>): Promise<T> {
  const gateway = env.GATEWAY;
  if (!gateway) throw new Error("GATEWAY service binding is not configured");
  return fn(gateway);
}

/** A reseller's new workspace opens without a subscription; a failure leaves it closed for the operator to open. */
async function openForReseller(userId: string, accountId: string): Promise<void> {
  if (!isReseller(userId, env.RESELLER_USER_IDS)) return;
  try {
    await withGateway((gateway) => gateway.setAccountBilling(accountId, { billingStatus: "open" }));
  } catch (err) {
    Sentry.captureException(err, { tags: { area: "billing", event: "reseller-open-failed" }, extra: { accountId } });
  }
}

/** List the signed-in user's organizations with their account-link state. */
export const listMyOrganizations = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ ok: true; data: OrganizationView[] } | { ok: false; error: string }> => {
    try {
      const auth = authInstance();
      const request = currentRequest();
      const { session } = await requireAuthContext(auth, request);
      const orgs = (await auth.api.listOrganizations({ headers: request.headers })) as Array<{
        id?: unknown;
        name?: unknown;
      }>;
      // Memberships only; the account link is read per organization for the UX.
      const views: OrganizationView[] = [];
      for (const org of orgs) {
        if (typeof org.id !== "string") continue;
        const link = await withGateway((gateway) =>
          gateway.getOrganizationAccountLink(org.id as string),
        );
        views.push({
          id: org.id,
          name: String(org.name ?? ""),
          role: null,
          accountId: link?.accountId ?? null,
          linkStatus: link?.status ?? null,
        });
      }
      void session;
      return { ok: true, data: views };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

/**
 * A workspace is created from its NAME alone.
 *
 * The slug is not an input. Better Auth's schema declares
 * `organization.slug text not null unique` — GLOBALLY unique, across every
 * tenant — and the console used to derive that value from the name the customer
 * typed. Two unrelated customers who both call a workspace "Citta" therefore
 * collided, and the collision was reported to the browser: a cross-tenant
 * existence oracle that tells a stranger who our customers are, in a product
 * whose whole auth surface refuses to confirm that an address or an account
 * exists (docs/auth-tenancy-contract.md §7/§8).
 *
 * Nothing is slug-addressed — there is no `/{slug}` route, and the form's own
 * copy promising one was false — so the value has no product left to pay for
 * that leak with. It is now minted server-side (below) and never shown.
 *
 * The consequence is the correct multi-tenant semantics: workspace NAMES may
 * now repeat freely, both across customers and inside one user's own list.
 */
export const createOrgInput = z
  .object({
    name: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * ─── Workspace-creation failure copy ─────────────────────────────────────────
 *
 * ALLOWLIST, never `err.message`. The provider's text is written for a
 * developer reading a stack trace, and passing it through is how an
 * implementation detail — "Organization already exists", a Kysely constraint
 * name, a binding error — reaches a customer's screen. Worse, it is the exact
 * shape of leak this change exists to close: an error string that varies with
 * the state of OTHER tenants is an oracle no matter which endpoint emits it.
 *
 * So the mapping is closed: three recognised, actionable conditions get their
 * own sentence, and EVERYTHING else — a slug collision included, which after
 * this change means a UUID collision and therefore a bug or a retry, never
 * another customer — collapses into the generic retry line. The unmapped cause
 * is written to the Worker log instead, where an operator can read it and a
 * customer cannot.
 */
const CREATE_WORKSPACE_RETRY =
  "Could not create the workspace right now. Please try again.";
const CREATE_WORKSPACE_SIGNED_OUT =
  "Your session has expired. Sign in again to create a workspace.";
const CREATE_WORKSPACE_NOT_ALLOWED = "This account cannot create a workspace.";
const CREATE_WORKSPACE_LIMIT =
  "This account has reached its workspace limit.";

/** The allowlisted Better Auth conditions and the copy each one earns. */
const CREATE_WORKSPACE_COPY: Record<string, string> = {
  UNAUTHORIZED: CREATE_WORKSPACE_SIGNED_OUT,
  YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION: CREATE_WORKSPACE_NOT_ALLOWED,
  YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS: CREATE_WORKSPACE_LIMIT,
};

/**
 * The machine-readable class of a thrown auth error, if it has one.
 *
 * Better Auth throws better-call's `APIError`, which carries `body.code` for
 * its own error catalogue and a string `status` ("UNAUTHORIZED", …) for the
 * ones raised straight from a status. Anything else — a plain `Error`, an RPC
 * failure — has no code and lands on the generic branch by construction.
 */
export function authErrorCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const e = err as { body?: { code?: unknown }; status?: unknown };
  if (typeof e.body?.code === "string") return e.body.code;
  if (typeof e.status === "string") return e.status;
  return "";
}

/**
 * Server-side only: the operator keeps the diagnosis the customer no longer
 * gets. The code and the error's class, never its message: that can carry an
 * organization or account id.
 */
export function warnUnmapped(event: string, code: string, err: unknown): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      area: "organizations",
      event,
      code: code || null,
      error: err instanceof Error ? err.name : typeof err,
    }),
  );
}

/** Map a creation failure to customer-facing copy, logging the unmapped ones. */
export function createWorkspaceErrorCopy(err: unknown): string {
  const code = authErrorCode(err);
  const mapped = CREATE_WORKSPACE_COPY[code];
  if (mapped) return mapped;
  warnUnmapped("create-workspace-failed", code, err);
  return CREATE_WORKSPACE_RETRY;
}

/**
 * Create an organization for the signed-in, verified user and provision its
 * Eccos account. Verified email is required (contract §7); provisioning is
 * idempotent and never issues an API key (contract §2).
 *
 * The slug is minted here as a random UUID: opaque, unguessable, and unique by
 * construction, so Better Auth's global `unique` constraint is satisfied
 * without any customer-supplied value ever taking part in it. It is never
 * returned to the browser (see `Membership` in `auth/tenant.ts`).
 */
export const createOrganization = createServerFn({ method: "POST" })
  .validator((input: unknown) => createOrgInput.parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: true; data: { organizationId: string; accountId: string } }
      | { ok: false; error: string }
    > => {
      try {
        const auth = authInstance();
        const request = currentRequest();
        const { session } = await requireAuthContext(auth, request);
        const org = (await auth.api.createOrganization({
          body: { name: data.name, slug: crypto.randomUUID() },
          headers: request.headers,
        })) as { id?: unknown };
        if (!org?.id || typeof org.id !== "string") {
          throw new Error("organization creation failed");
        }
        // Idempotent saga: exactly one account + one active link, no API key.
        const link = await withGateway((gateway) =>
          gateway.ensureOrganizationAccount(org.id as string, data.name),
        );
        await openForReseller(session.userId, link.accountId);
        return { ok: true, data: { organizationId: org.id, accountId: link.accountId } };
      } catch (err) {
        return { ok: false, error: createWorkspaceErrorCopy(err) };
      }
    },
  );

export const renameWorkspaceInput = z
  .object({
    organizationId: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(200),
  })
  .strict();

const RENAME_RETRY = "Could not rename the workspace right now. Please try again.";

/**
 * The gateway keeps its own copy of the name; a failure there must not undo the
 * rename the user sees. Returns the account id it renamed, null when it could not.
 */
async function syncAccountName(organizationId: string, name: string): Promise<string | null> {
  try {
    return await withGateway(async (gateway) => {
      const link = await gateway.getOrganizationAccountLink(organizationId);
      if (link?.status !== "active") throw new Error("no active account link");
      await gateway.setAccountName(link.accountId, name);
      return link.accountId;
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { area: "organizations", event: "account-rename-failed" },
      extra: { organizationId },
    });
    return null;
  }
}

/**
 * Rename the workspace the page shows. In process, because the HTTP
 * `organization/update` endpoint is blocked (`auth/blocked-endpoints.ts`); only
 * the name is written and only the name is returned, so the slug never moves or leaks.
 * A session that has since moved to another workspace (another tab) is refused.
 */
export const renameWorkspace = createServerFn({ method: "POST" })
  .validator((input: unknown) => renameWorkspaceInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; data: { name: string } } | Failure> => {
    try {
      const auth = authInstance();
      const request = currentRequest();
      const organizationId = await requireGatewayPermission(auth, request, "administer");
      if (organizationId !== data.organizationId) {
        throw new ForbiddenError("session moved to another workspace", "workspace-changed");
      }
      const { session } = await requireAuthContext(auth, request);
      await auth.api.updateOrganization({
        body: { organizationId, data: { name: data.name } },
        headers: request.headers,
      });
      const accountId = await syncAccountName(organizationId, data.name);
      // No name in the line: ids only, like every other audit record.
      auditEvent({
        action: "workspace_rename",
        actorUserId: session.userId,
        organizationId,
        accountId,
        outcome: "success",
        detail: accountId ? undefined : "gateway-name-not-synced",
      });
      return { ok: true, data: { name: data.name } };
    } catch (err) {
      const failure = await classifyFailure(err);
      // An unexpected error's message is for Sentry, which classifyFailure told; the screen gets the retry line.
      return failure.kind === "unreachable" ? { ...failure, error: RENAME_RETRY } : failure;
    }
  });

const selectOrgInput = z
  .object({ organizationId: z.string().trim().min(1).max(128) })
  .strict();

/**
 * Point this session at one of the user's organizations (eccos-k5a).
 *
 * A member of several organizations with none selected cannot resolve a tenant,
 * and `requirePermission` fails closed on that ambiguity rather than guessing —
 * so the console needs a way to answer the question. What this writes is UX
 * state only (`session.activeOrganizationId`): every authorization decision
 * still re-derives and re-validates the organization per request, and the id
 * arriving from the browser is verified against membership here before it is
 * stored, so a forged one changes nothing (contract §1).
 */
export const selectOrganization = createServerFn({ method: "POST" })
  .validator((input: unknown) => selectOrgInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const auth = authInstance();
      const request = currentRequest();
      await requireAuthContext(auth, request);
      if (!(await verifyMembership(auth, request.headers, data.organizationId))) {
        throw new ForbiddenError("not a member of the requested organization", "not-a-member");
      }
      await auth.api.setActiveOrganization({
        body: { organizationId: data.organizationId },
        headers: request.headers,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

export interface InvitationFailure {
  ok: false;
  /** `signed-out` goes to sign-in, `retry` is transient, `unavailable` will not change by asking again. */
  kind: "signed-out" | "retry" | "unavailable";
  error: string;
}

/** Classify an invitation failure and give it allowlisted copy (`lib/invitation-copy.ts`). */
export function invitationFailure(err: unknown): InvitationFailure {
  const code = authErrorCode(err);
  if (code === "UNAUTHORIZED" || err instanceof UnauthorizedError) {
    return { ok: false, kind: "signed-out", error: INVITATION_SIGNED_OUT };
  }
  const mapped = INVITATION_COPY[code];
  if (mapped) return { ok: false, kind: "unavailable", error: mapped };
  warnUnmapped("invitation-failed", code, err);
  return { ok: false, kind: "retry", error: INVITATION_RETRY };
}

export const acceptInviteInput = z
  .object({ invitationId: z.string().trim().min(1).max(256) })
  .strict();

/**
 * The workspace an ALREADY ACCEPTED invitation put the caller in, or null.
 *
 * Better Auth answers "not found" for an accepted invitation, which is what a
 * retry meets when the accept went through but the account link after it did
 * not. Only the invited identity that is now a member gets an answer here.
 */
async function joinedWorkspace(invitationId: string): Promise<Membership | null> {
  const auth = authInstance();
  const request = currentRequest();
  const { session } = await requireAuthContext(auth, request);
  const invitation = await (await auth.$context).adapter.findOne<{
    email: string;
    status: string;
    organizationId: string;
  }>({ model: "invitation", where: [{ field: "id", value: invitationId }] });
  if (invitation?.status !== "accepted") return null;
  if (invitation.email.toLowerCase() !== session.email.toLowerCase()) return null;
  const memberships = await resolveMemberships(auth, request.headers);
  return memberships.find((m) => m.id === invitation.organizationId) ?? null;
}

/** Accept an invitation as the signed-in matching identity (contract §7). */
export const acceptInvitation = createServerFn({ method: "POST" })
  .validator((input: unknown) => acceptInviteInput.parse(input))
  .handler(
    async ({ data }): Promise<{ ok: true; data: { organizationId: string } } | InvitationFailure> => {
      try {
        const auth = authInstance();
        const request = currentRequest();
        let organizationId: string;
        try {
          const accepted = (await auth.api.acceptInvitation({
            body: { invitationId: data.invitationId },
            headers: request.headers,
          })) as { invitation: { organizationId: string } };
          organizationId = accepted.invitation.organizationId;
        } catch (err) {
          const joined = await joinedWorkspace(data.invitationId).catch(() => null);
          if (!joined) throw err;
          organizationId = joined.id;
          await auth.api.setActiveOrganization({ body: { organizationId }, headers: request.headers });
        }
        // Defense in depth: make sure the joined organization is linked. A
        // failure here leaves a member whose retry takes the branch above.
        await withGateway((gateway) => gateway.ensureOrganizationAccount(organizationId));
        return { ok: true, data: { organizationId } };
      } catch (err) {
        return invitationFailure(err);
      }
    },
  );

export interface InvitationView {
  organizationName: string;
  /** Already accepted by this identity: nothing to accept, only a workspace to open. */
  joined: boolean;
}

/** The invitation behind an accept link, for the invited identity only. */
export const getInvitation = createServerFn({ method: "GET" })
  .validator((input: unknown) => acceptInviteInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; data: InvitationView } | InvitationFailure> => {
    try {
      const invitation = (await authInstance().api.getInvitation({
        query: { id: data.invitationId },
        headers: currentRequest().headers,
      })) as { organizationName: string };
      return { ok: true, data: { organizationName: invitation.organizationName, joined: false } };
    } catch (err) {
      const joined = await joinedWorkspace(data.invitationId).catch(() => null);
      if (joined) return { ok: true, data: { organizationName: joined.name, joined: true } };
      // get-invitation raises "not found" from a bare status, with no code of
      // its own; it must read like the accept's, or the pair is an id oracle.
      if (authErrorCode(err) === "BAD_REQUEST") {
        return { ok: false, kind: "unavailable", error: INVITATION_UNAVAILABLE };
      }
      return invitationFailure(err);
    }
  });

/** List the signed-in user's pending invitations (identity plane only). */
export const listMyInvitations = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ ok: true; data: PendingInvitationView[] } | { ok: false; error: string }> => {
    try {
      const auth = authInstance();
      const request = currentRequest();
      const { session } = await requireAuthContext(auth, request);
      const invitations = (await auth.api.listUserInvitations({
        headers: request.headers,
      })) as Array<{
        id?: unknown;
        status?: unknown;
        email?: unknown;
        role?: unknown;
        organizationId?: unknown;
      }>;
      const views: PendingInvitationView[] = [];
      for (const inv of invitations) {
        if (inv.status !== "pending" || typeof inv.id !== "string") continue;
        if (typeof inv.email !== "string" || inv.email.toLowerCase() !== session.email.toLowerCase()) {
          continue;
        }
        let organizationName = "";
        if (typeof inv.organizationId === "string") {
          const org = (await auth.api.getOrganization({
            query: { organizationId: inv.organizationId },
            headers: request.headers,
          }).catch(() => null)) as { name?: unknown } | null;
          organizationName = String(org?.name ?? "");
        }
        views.push({
          invitationId: inv.id,
          organizationName,
          inviterName: "",
          email: inv.email,
          role: typeof inv.role === "string" ? inv.role : null,
        });
      }
      return { ok: true, data: views };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

/** The signed-in user as the sidebar's footer renders it: identity + scope. */
export interface SessionUserView {
  name: string;
  email: string;
  twoFactorEnabled: boolean;
  /**
   * The organizations this user belongs to, for the shell's workspace control.
   * Display data: the list an operator may CHOOSE from, never proof they hold
   * anything in any of them.
   */
  workspaces: Membership[];
  /**
   * Which workspace the shell marks as active, derived exactly as
   * `requirePermission` derives the tenant (see `lib/workspaces.ts`) so the
   * console never names a scope the server would refuse. `null` means the
   * choice has not been made yet.
   */
  activeWorkspaceId: string | null;
}

/**
 * Resolve the signed-in user for the app chrome (the sidebar footer).
 *
 * Display data only: the shell shows who is signed in, which workspace they are
 * in, what else they could switch to, and offers a way out. Every authorization
 * decision stays server-side and re-derives the session from the request, so
 * this is never authorization evidence — switching is still validated by
 * `selectOrganization` and every subsequent request by `requirePermission`.
 * Anonymous or expired sessions resolve to `null` rather than throwing, because
 * the root loader also runs on public routes.
 */
export const getSessionUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionUserView | null> => {
    try {
      const auth = authInstance();
      const request = currentRequest();
      // The session read is deduped per request by the memo (request-memo.ts),
      // and carries the stored active organization, so the only cost added
      // here is the membership list the switcher renders.
      const { session } = await requireAuthContext(auth, request);
      const workspaces = await resolveMemberships(auth, request.headers);
      return {
        name: session.name,
        email: session.email,
        twoFactorEnabled: session.twoFactorEnabled,
        workspaces,
        activeWorkspaceId: activeWorkspace(workspaces, session.activeOrganizationId)?.id ?? null,
      };
    } catch {
      return null;
    }
  },
);
