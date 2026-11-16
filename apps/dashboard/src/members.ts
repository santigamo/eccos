/**
 * Workspace members and invitations (contract §4/§7/§9).
 *
 * Every function requires `administer`, and the organization is the one that
 * check resolves. A member or invitation id is looked up inside that
 * organization only, so an id from another workspace reads exactly like one
 * that does not exist. Better Auth's HTTP routes for these writes are blocked
 * (`auth/blocked-endpoints.ts`), so these functions are the only way in.
 */

import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { APIError } from "better-auth/api";
import { z } from "zod";
import type { Auth } from "./auth/auth";
import { invitationLimiter } from "./auth/config";
import { getAuthForRequest } from "./auth/request-auth";
import { UnauthorizedError, requireAuthContext, requireGatewayPermission } from "./auth/server-auth";
import { ForbiddenError } from "./auth/tenant";
import { auditEvent, type SensitiveAction } from "./server/audit";
import { classifyFailure, type Result } from "./server/gateway";
import { authErrorCode, warnUnmapped } from "./organizations";
import { failureCopy } from "./lib/failure";
import {
  ASK_TO_MANAGE_MEMBERS,
  INVITATION_RATE_LIMITED,
  LAST_OWNER,
  MEMBERS_COPY,
  MEMBERS_RETRY,
  MEMBERS_SIGNED_OUT,
  OWNER_PROTECTED,
  ROLE_NOT_OFFERED,
  WORKSPACE_CHANGED,
} from "./lib/members-copy";
import { isOwnerRole } from "./lib/member-roles";

export const MEMBER_ROLES = ["admin", "operator", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export interface MemberView {
  memberId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: number;
  isSelf: boolean;
}

export interface InvitationView {
  id: string;
  email: string;
  role: string;
  inviterName: string;
  expiresAt: number;
  expired: boolean;
}

export interface MembersPage {
  /** The workspace this page shows; an invitation is refused if the session has moved on. */
  organizationId: string;
  members: MemberView[];
  invitations: InvitationView[];
  /** The caller's own role: an admin may not change or remove an owner. */
  callerRole: string;
}

export interface MembersFailure {
  ok: false;
  error: string;
  /** The member or invitation no longer exists here: re-read the page. */
  gone?: boolean;
}

export type MembersMutation = { ok: true } | MembersFailure;

interface MemberRow {
  id: string;
  userId: string;
  role: string;
  createdAt: Date | string;
  user: { name: string; email: string };
}

interface InvitationRow {
  id: string;
  email: string;
  role: string;
  inviterId: string;
  expiresAt: Date | string;
}

interface Caller {
  auth: Auth;
  headers: Headers;
  organizationId: string;
  userId: string;
}

async function requireAdministrator(): Promise<Caller> {
  const request = getRequest();
  const auth = getAuthForRequest(request, env);
  const organizationId = await requireGatewayPermission(auth, request, "administer");
  const { session } = await requireAuthContext(auth, request);
  return { auth, headers: request.headers, organizationId, userId: session.userId };
}

async function listMembers(caller: Caller): Promise<MemberRow[]> {
  const { members } = (await caller.auth.api.listMembers({
    query: { organizationId: caller.organizationId },
    headers: caller.headers,
  })) as { members: MemberRow[] };
  return members;
}

const pendingWhere = (caller: Caller) => [
  { field: "organizationId", value: caller.organizationId },
  { field: "status", value: "pending" },
];

/** Straight from the adapter: the plugin's list returns every status, capped at 100 rows. */
async function pendingInvitations(caller: Caller): Promise<InvitationRow[]> {
  const { adapter } = await caller.auth.$context;
  // Better Auth refuses a new invitation past `invitationLimit` (100) pending.
  return adapter.findMany<InvitationRow>({
    model: "invitation",
    where: pendingWhere(caller),
    limit: 100,
    sortBy: { field: "expiresAt", direction: "asc" },
  });
}

async function pendingInvitation(caller: Caller, invitationId: string): Promise<InvitationRow> {
  const { adapter } = await caller.auth.$context;
  const invitation = await adapter.findOne<InvitationRow>({
    model: "invitation",
    where: [...pendingWhere(caller), { field: "id", value: invitationId }],
  });
  return invitation ?? refuse("INVITATION_NOT_FOUND");
}

function refuse(code: string): never {
  throw new APIError("BAD_REQUEST", { code, message: code });
}

const GONE = new Set(["MEMBER_NOT_FOUND", "INVITATION_NOT_FOUND"]);

/** Map a write's failure to allowlisted copy; the unmapped ones are logged by code and class only. */
export function membersFailure(err: unknown): MembersFailure {
  if (err instanceof UnauthorizedError) return { ok: false, error: MEMBERS_SIGNED_OUT };
  if (err instanceof ForbiddenError) {
    return {
      ok: false,
      error:
        err.reason === "missing-permission"
          ? ASK_TO_MANAGE_MEMBERS
          : failureCopy({ ok: false, kind: "forbidden", reason: err.reason, error: err.message }).detail,
    };
  }
  const code = authErrorCode(err);
  const mapped = MEMBERS_COPY[code];
  if (mapped) return GONE.has(code) ? { ok: false, error: mapped, gone: true } : { ok: false, error: mapped };
  warnUnmapped("members-failed", code, err);
  return { ok: false, error: MEMBERS_RETRY };
}

/**
 * Run one write as an administrator and audit it, ids only. `facts` collects
 * what actually happened (a new invitation id, a restore), on success or not.
 */
async function mutate(
  action: SensitiveAction,
  resource: Record<string, string>,
  fn: (caller: Caller, facts: Record<string, string>) => Promise<void>,
): Promise<MembersMutation> {
  let caller: Caller;
  try {
    caller = await requireAdministrator();
  } catch (err) {
    return membersFailure(err);
  }
  const facts: Record<string, string> = {};
  const audit = { action, actorUserId: caller.userId, organizationId: caller.organizationId, accountId: null };
  try {
    await fn(caller, facts);
    auditEvent({ ...audit, resource: { ...resource, ...facts }, outcome: "success" });
    return { ok: true };
  } catch (err) {
    auditEvent({ ...audit, resource: { ...resource, ...facts }, outcome: "failed", detail: authErrorCode(err) || undefined });
    return membersFailure(err);
  }
}

/**
 * The target member, if it belongs to the caller's organization. An owner can
 * only be changed or removed by another owner, and never the last one: the
 * owner role is not offered, so any change to an owner is a demotion.
 */
async function manageableMember(caller: Caller, memberId: string): Promise<MemberRow> {
  const members = await listMembers(caller);
  const target = members.find((member) => member.id === memberId) ?? refuse("MEMBER_NOT_FOUND");
  if (isOwnerRole(target.role)) {
    const self = members.find((member) => member.userId === caller.userId);
    if (!self || !isOwnerRole(self.role)) refuse(OWNER_PROTECTED);
    // No path grants owner (never offered here, HTTP routes blocked), so two owners cannot race past this.
    if (members.filter((member) => isOwnerRole(member.role)).length <= 1) refuse(LAST_OWNER);
  }
  return target;
}

async function createInvitation(caller: Caller, email: string, role: MemberRole): Promise<string> {
  // sendInvitationEmail (auth.ts) delivers it; the plugin's beforeCreateInvitation
  // hook holds the per-inviter rate limit.
  const invitation = (await caller.auth.api.createInvitation({
    body: { email, role, organizationId: caller.organizationId },
    headers: caller.headers,
  })) as { id: string };
  return invitation.id;
}

const isMemberRole = (role: string): role is MemberRole => (MEMBER_ROLES as readonly string[]).includes(role);

const toMs = (value: Date | string) => new Date(value).getTime();

/** Members and pending invitations of the caller's workspace. */
export const listWorkspaceMembers = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<MembersPage>> => {
    try {
      const caller = await requireAdministrator();
      const [members, invitations] = await Promise.all([listMembers(caller), pendingInvitations(caller)]);
      const nameOf = new Map(members.map((member) => [member.userId, member.user.name]));
      const now = Date.now();
      return {
        ok: true,
        data: {
          organizationId: caller.organizationId,
          members: members.map((member) => ({
            memberId: member.id,
            name: member.user.name,
            email: member.user.email,
            role: member.role,
            joinedAt: toMs(member.createdAt),
            isSelf: member.userId === caller.userId,
          })),
          invitations: invitations.map((invitation) => ({
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            inviterName: nameOf.get(invitation.inviterId) ?? "",
            expiresAt: toMs(invitation.expiresAt),
            expired: toMs(invitation.expiresAt) <= now,
          })),
          callerRole: members.find((member) => member.userId === caller.userId)?.role ?? "",
        },
      };
    } catch (err) {
      return classifyFailure(err);
    }
  },
);

const roleSchema = z.enum(MEMBER_ROLES);
const idSchema = z.string().trim().min(1).max(256);

export const inviteMemberInput = z
  .object({ email: z.string().trim().email().max(320), role: roleSchema, organizationId: idSchema })
  .strict();

/** `organizationId` is the page's workspace: a check against the session, never the tenant's source. */
export const inviteMember = createServerFn({ method: "POST" })
  .validator((input: unknown) => inviteMemberInput.parse(input))
  .handler(({ data }) =>
    mutate("member_invited", { role: data.role }, async (caller, facts) => {
      if (caller.organizationId !== data.organizationId) refuse(WORKSPACE_CHANGED);
      facts.invitationId = await createInvitation(caller, data.email, data.role);
    }),
  );

const invitationInput = z.object({ invitationId: idSchema }).strict();

/**
 * Cancel and invite again, which mints a new invitation id. Better Auth's own
 * resend keeps the id, so the mail's idempotency key repeats and the provider
 * drops the send as a duplicate (see `sendInvitationEmail` in auth.ts).
 *
 * The invitee is never left without a live invitation: what can refuse the new
 * one is checked before the old one is cancelled, and a create that still
 * fails puts the old one back.
 */
export const resendInvitation = createServerFn({ method: "POST" })
  .validator((input: unknown) => invitationInput.parse(input))
  .handler(({ data }) =>
    mutate("invitation_resent", { invitationId: data.invitationId }, async (caller, facts) => {
      const invitation = await pendingInvitation(caller, data.invitationId);
      if (!isMemberRole(invitation.role)) refuse(ROLE_NOT_OFFERED);
      if (await invitationLimiter(env.DB).spent(caller.userId)) refuse(INVITATION_RATE_LIMITED);
      await caller.auth.api.cancelInvitation({ body: { invitationId: invitation.id }, headers: caller.headers });
      try {
        facts.newInvitationId = await createInvitation(caller, invitation.email, invitation.role);
      } catch (err) {
        const { adapter } = await caller.auth.$context;
        await adapter.update({
          model: "invitation",
          where: [{ field: "id", value: invitation.id }],
          update: { status: "pending" },
        });
        facts.restored = "true";
        throw err;
      }
    }),
  );

export const cancelInvitation = createServerFn({ method: "POST" })
  .validator((input: unknown) => invitationInput.parse(input))
  .handler(({ data }) =>
    mutate("invitation_canceled", { invitationId: data.invitationId }, async (caller) => {
      const invitation = await pendingInvitation(caller, data.invitationId);
      await caller.auth.api.cancelInvitation({ body: { invitationId: invitation.id }, headers: caller.headers });
    }),
  );

const updateRoleInput = z.object({ memberId: idSchema, role: roleSchema }).strict();

export const updateMemberRole = createServerFn({ method: "POST" })
  .validator((input: unknown) => updateRoleInput.parse(input))
  .handler(({ data }) =>
    mutate("member_role_changed", { memberId: data.memberId, role: data.role }, async (caller) => {
      const target = await manageableMember(caller, data.memberId);
      await caller.auth.api.updateMemberRole({
        body: { memberId: target.id, role: data.role, organizationId: caller.organizationId },
        headers: caller.headers,
      });
    }),
  );

const memberInput = z.object({ memberId: idSchema }).strict();

export const removeMember = createServerFn({ method: "POST" })
  .validator((input: unknown) => memberInput.parse(input))
  .handler(({ data }) =>
    mutate("member_removed", { memberId: data.memberId }, async (caller) => {
      const target = await manageableMember(caller, data.memberId);
      await caller.auth.api.removeMember({
        body: { memberIdOrEmail: target.id, organizationId: caller.organizationId },
        headers: caller.headers,
      });
    }),
  );
