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
import { env } from "cloudflare:workers";
import type { GatewayApi } from "@eccos/gateway-contract";
import { createAuth } from "./auth/auth";
import { authConfigFromEnv } from "./auth/config";
import { requireAuthContext, requireGatewayPermission } from "./auth/server-auth";
import { ForbiddenError, verifyMembership } from "./auth/tenant";

export interface OrganizationView {
  id: string;
  name: string;
  slug: string;
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
  return createAuth(authConfigFromEnv(env));
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
        slug?: unknown;
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
          slug: String(org.slug ?? ""),
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

const createOrgInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9-]+$/),
  })
  .strict();

/**
 * Create an organization for the signed-in, verified user and provision its
 * Eccos account. Verified email is required (contract §7); provisioning is
 * idempotent and never issues an API key (contract §2).
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
        const org = (await auth.api.createOrganization({
          body: { name: data.name, slug: data.slug },
          headers: request.headers,
        })) as { id?: unknown };
        if (!org?.id || typeof org.id !== "string") {
          throw new Error("organization creation failed");
        }
        // Idempotent saga: exactly one account + one active link, no API key.
        const link = await withGateway((gateway) =>
          gateway.ensureOrganizationAccount(org.id as string, data.name),
        );
        return { ok: true, data: { organizationId: org.id, accountId: link.accountId } };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

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

const inviteInput = z
  .object({
    email: z.string().trim().email(),
    role: z.enum(["admin", "operator", "viewer"]),
    organizationId: z.string().trim().min(1).max(128),
  })
  .strict();

/**
 * Invite a verified email to the organization (owner/admin per contract §4).
 * A member invitation never provisions a new tenant: accepting joins the
 * existing organization and its already-linked account.
 */
export const inviteMember = createServerFn({ method: "POST" })
  .validator((input: unknown) => inviteInput.parse(input))
  .handler(
    async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const organizationId = await requireGatewayPermission(authInstance(), getRequest(), "administer");
        if (organizationId !== data.organizationId) {
          throw new ForbiddenError("organization mismatch");
        }
        const auth = authInstance();
        const request = currentRequest();
        await auth.api.createInvitation({
          body: {
            email: data.email,
            role: data.role,
            organizationId: data.organizationId,
          },
          headers: request.headers,
          // sendInvitationEmail (wired in auth.ts) delivers via the mail adapter.
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

const acceptInviteInput = z
  .object({ invitationId: z.string().trim().min(1).max(256) })
  .strict();

/** Accept an invitation as the signed-in matching identity (contract §7). */
export const acceptInvitation = createServerFn({ method: "POST" })
  .validator((input: unknown) => acceptInviteInput.parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: true; data: { organizationId: string | null } }
      | { ok: false; error: string }
    > => {
      try {
        const auth = authInstance();
        const request = currentRequest();
        const accepted = (await auth.api.acceptInvitation({
          body: { invitationId: data.invitationId },
          headers: request.headers,
        })) as { invitation?: { organizationId?: unknown } } | null;
        const organizationId =
          accepted?.invitation && typeof accepted.invitation.organizationId === "string"
            ? accepted.invitation.organizationId
            : null;
        if (organizationId) {
          // Defense in depth: make sure the joined organization is linked.
          await withGateway((gateway) =>
            gateway.ensureOrganizationAccount(organizationId),
          );
        }
        return { ok: true, data: { organizationId } };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

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

/** The signed-in user as the sidebar's account section renders it. */
export interface SessionUserView {
  name: string;
  email: string;
}

/**
 * Resolve the signed-in user for the app chrome (the sidebar's NavUser).
 *
 * Display data only: the shell shows who is signed in and offers a way out.
 * Every authorization decision stays server-side and re-derives the session
 * from the request, so this is never authorization evidence. Anonymous or
 * expired sessions resolve to `null` rather than throwing, because the root
 * loader also runs on public routes.
 */
export const getSessionUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionUserView | null> => {
    try {
      const { session } = await requireAuthContext(authInstance(), currentRequest());
      return { name: session.name, email: session.email };
    } catch {
      return null;
    }
  },
);
