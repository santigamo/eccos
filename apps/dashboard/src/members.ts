/**
 * Workspace members and invitations (contract §4/§7/§9).
 *
 * Every function requires `administer`, and the organization is the one that
 * check resolves, never an id from the browser. A member or invitation id is
 * looked up inside that organization only, so an id from another workspace
 * reads exactly like one that does not exist.
 */

import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { APIError } from "better-auth/api";
import { z } from "zod";
import type { Auth } from "./auth/auth";
import { getAuthForRequest } from "./auth/request-auth";
import { UnauthorizedError, requireAuthContext, requireGatewayPermission } from "./auth/server-auth";
import { ForbiddenError } from "./auth/tenant";
import { auditEvent, type SensitiveAction } from "./server/audit";
import {
  LAST_OWNER,
  MEMBERS_COPY,
  MEMBERS_RETRY,
  OWNER_PROTECTED,
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
  members: MemberView[];
  invitations: InvitationView[];
  /** The caller's own role: an admin may not change or remove an owner. */
  callerRole: string;
}

export type MembersFailure = { ok: false; error: string };

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
  status: string;
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

async function pendingInvitations(caller: Caller): Promise<InvitationRow[]> {
  const invitations = (await caller.auth.api.listInvitations({
    query: { organizationId: caller.organizationId },
    headers: caller.headers,
  })) as InvitationRow[];
  return invitations.filter((invitation) => invitation.status === "pending");
}

function refuse(code: string): never {
  throw new APIError("BAD_REQUEST", { code, message: code });
}

/** The machine-readable class of a failure, if it has one. */
function errorCode(err: unknown): string {
  if (err instanceof UnauthorizedError) return "UNAUTHORIZED";
  if (err instanceof ForbiddenError) return "FORBIDDEN";
  if (!err || typeof err !== "object") return "";
  const e = err as { body?: { code?: unknown }; status?: unknown };
  if (typeof e.body?.code === "string") return e.body.code;
  if (typeof e.status === "string") return e.status;
  return "";
}

/** Map a failure to allowlisted copy; the unmapped ones are logged by code and class only. */
export function membersFailure(err: unknown): MembersFailure {
  const code = errorCode(err);
  const mapped = MEMBERS_COPY[code];
  if (mapped) return { ok: false, error: mapped };
  console.warn(
    JSON.stringify({
      level: "warn",
      area: "members",
      event: "members-failed",
      code: code || null,
      error: err instanceof Error ? err.name : typeof err,
    }),
  );
  return { ok: false, error: MEMBERS_RETRY };
}

/** Run one mutation as an administrator and write its ids-only audit line. */
async function mutate(
  action: SensitiveAction,
  resource: Record<string, string>,
  fn: (caller: Caller) => Promise<Record<string, string> | void>,
): Promise<{ ok: true } | MembersFailure> {
  let caller: Caller;
  try {
    caller = await requireAdministrator();
  } catch (err) {
    return membersFailure(err);
  }
  const audit = { action, actorUserId: caller.userId, organizationId: caller.organizationId, accountId: null };
  try {
    const extra = await fn(caller);
    auditEvent({ ...audit, resource: { ...resource, ...extra }, outcome: "success" });
    return { ok: true };
  } catch (err) {
    const failure = membersFailure(err);
    auditEvent({ ...audit, resource, outcome: "failed", detail: errorCode(err) || undefined });
    return failure;
  }
}

/**
 * The target member, if it belongs to the caller's organization. An owner can
 * only be changed or removed by another owner, and never the last one: the
 * owner role is not offered, so any change to an owner is a demotion.
 */
async function manageableMember(caller: Caller, memberId: string): Promise<MemberRow> {
  const members = await listMembers(caller);
  const target = members.find((member) => member.id === memberId);
  if (!target) refuse("MEMBER_NOT_FOUND");
  if (isOwnerRole(target.role)) {
    const self = members.find((member) => member.userId === caller.userId);
    if (!self || !isOwnerRole(self.role)) refuse(OWNER_PROTECTED);
    if (members.filter((member) => isOwnerRole(member.role)).length <= 1) refuse(LAST_OWNER);
  }
  return target;
}

async function pendingInvitation(caller: Caller, invitationId: string): Promise<InvitationRow> {
  const invitation = (await pendingInvitations(caller)).find((row) => row.id === invitationId);
  if (!invitation) refuse("INVITATION_NOT_FOUND");
  return invitation;
}

async function createInvitation(caller: Caller, email: string, role: string): Promise<string> {
  // sendInvitationEmail (auth.ts) delivers it; the organization plugin's
  // beforeCreateInvitation hook holds the per-inviter rate limit.
  const invitation = (await caller.auth.api.createInvitation({
    body: { email, role: role as MemberRole, organizationId: caller.organizationId },
    headers: caller.headers,
  })) as { id: string };
  return invitation.id;
}

const toMs = (value: Date | string) => new Date(value).getTime();

/** Members and pending invitations of the caller's workspace. */
export const listWorkspaceMembers = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ ok: true; data: MembersPage } | MembersFailure> => {
    try {
      const caller = await requireAdministrator();
      const [members, invitations] = await Promise.all([listMembers(caller), pendingInvitations(caller)]);
      const nameOf = new Map(members.map((member) => [member.userId, member.user.name]));
      const now = Date.now();
      return {
        ok: true,
        data: {
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
      return membersFailure(err);
    }
  },
);

const roleSchema = z.enum(MEMBER_ROLES);
const idSchema = z.string().trim().min(1).max(256);

export const inviteMemberInput = z.object({ email: z.string().trim().email().max(320), role: roleSchema }).strict();

export const inviteMember = createServerFn({ method: "POST" })
  .validator((input: unknown) => inviteMemberInput.parse(input))
  .handler(({ data }) =>
    mutate("member_invited", { role: data.role }, async (caller) => ({
      invitationId: await createInvitation(caller, data.email, data.role),
    })),
  );

const invitationInput = z.object({ invitationId: idSchema }).strict();

/**
 * Cancel and invite again, which mints a new invitation id. Better Auth's own
 * resend keeps the id, so the mail's idempotency key repeats and the provider
 * drops the send as a duplicate (see `sendInvitationEmail` in auth.ts).
 */
export const resendInvitation = createServerFn({ method: "POST" })
  .validator((input: unknown) => invitationInput.parse(input))
  .handler(({ data }) =>
    mutate("invitation_resent", { invitationId: data.invitationId }, async (caller) => {
      const invitation = await pendingInvitation(caller, data.invitationId);
      await caller.auth.api.cancelInvitation({ body: { invitationId: invitation.id }, headers: caller.headers });
      return { newInvitationId: await createInvitation(caller, invitation.email, invitation.role) };
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
