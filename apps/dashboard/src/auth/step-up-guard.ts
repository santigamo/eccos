/**
 * Step-up inside Better Auth (contract §4/§8/§9).
 *
 * Stamps `session.stepUpAt` when a session is minted by a second-factor
 * verification, and refuses the endpoints that would otherwise let a password
 * alone change a factor or act on members. Hooks, so a direct HTTP call and a
 * server-side `auth.api.*` call are covered alike.
 */

import type { StepUpReason } from "@eccos/auth-baseline/step-up";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { roles } from "./permissions";
import { stepUpMessage, stepUpRefusal } from "./step-up";

type Permission = Record<string, string[]>;

/**
 * Member management, with the permission Better Auth itself goes on to check.
 * Three of the four name their organization in the body, falling back to the
 * session's active one; a cancellation is authorized on the invitation's own.
 */
export const STEP_UP_ORGANIZATION_PATHS: Record<string, Permission> = {
  "/organization/invite-member": { invitation: ["create"] },
  "/organization/cancel-invitation": { invitation: ["cancel"] },
  "/organization/update-member-role": { member: ["update"] },
  "/organization/remove-member": { member: ["delete"] },
};

/** Endpoints that change or reveal a factor and otherwise ask only for the password. */
export const STEP_UP_ACCOUNT_PATHS: ReadonlySet<string> = new Set([
  "/change-password",
  "/change-email",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/two-factor/get-totp-uri",
]);

/** Open to an account with no second factor yet; step-up once it has one. */
const ENROLL_PATH = "/two-factor/enable";

const VERIFY_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

function refuse(reason: StepUpReason): never {
  throw new APIError("FORBIDDEN", {
    code: reason === "totp-required" ? "TOTP_REQUIRED" : "SESSION_NOT_FRESH",
    message: stepUpMessage(reason),
  });
}

function roleHolds(role: unknown, permission: Permission): boolean {
  return String(role ?? "")
    .split(",")
    .some(
      (name) =>
        Object.hasOwn(roles, name) &&
        roles[name as keyof typeof roles].authorize(permission as never).success === true,
    );
}

interface Finder {
  findOne<T>(query: {
    model: string;
    where: { field: string; value: string }[];
  }): Promise<T | null>;
}

/**
 * Whether the caller's role is KNOWN to lack the permission in the
 * organization Better Auth will authorize against, resolved exactly as it
 * resolves it (`||`, so an empty id falls through to the active one). Only
 * that positive knowledge skips step-up: an organization, invitation or
 * membership that cannot be resolved does not.
 */
async function roleLacks(
  adapter: Finder,
  path: string,
  body: Record<string, unknown> | undefined,
  session: { user: { id: string }; session: Record<string, unknown> },
): Promise<boolean> {
  let organizationId: unknown;
  if (path === "/organization/cancel-invitation") {
    const invitationId = body?.invitationId;
    const invitation =
      typeof invitationId === "string" && invitationId
        ? await adapter.findOne<{ organizationId?: unknown }>({
            model: "invitation",
            where: [{ field: "id", value: invitationId }],
          })
        : null;
    organizationId = invitation?.organizationId;
  } else {
    organizationId = body?.organizationId || session.session.activeOrganizationId;
  }
  if (typeof organizationId !== "string" || !organizationId) return false;
  const member = await adapter.findOne<{ role?: unknown }>({
    model: "member",
    where: [
      { field: "userId", value: session.user.id },
      { field: "organizationId", value: organizationId },
    ],
  });
  return member !== null && !roleHolds(member.role, STEP_UP_ORGANIZATION_PATHS[path] ?? {});
}

export function stepUpGuard() {
  return {
    id: "step-up-guard",
    schema: {
      session: {
        fields: { stepUpAt: { type: "date", required: false, input: false } },
      },
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => Object.hasOwn(STEP_UP_ORGANIZATION_PATHS, ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            // No session: the endpoint's own middleware answers 401.
            if (!session) return;
            // The role first: one that lacks the action gets Better Auth's own
            // permission error, not an invitation to enroll.
            if (await roleLacks(ctx.context.adapter, ctx.path, ctx.body, session)) return;
            const refusal = stepUpRefusal(session);
            if (refusal) refuse(refusal);
          }),
        },
        {
          matcher: (ctx) =>
            STEP_UP_ACCOUNT_PATHS.has(ctx.path ?? "") || ctx.path === ENROLL_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            if (ctx.path === ENROLL_PATH && !session.user.twoFactorEnabled) return;
            const refusal = stepUpRefusal(session);
            if (refusal) refuse(refusal);
          }),
        },
        {
          // An enrolled, signed-in caller has no business here over HTTP: on an
          // existing session these endpoints count no wrong codes, so they
          // would be a free oracle for the limited step-up check
          // (`step-up-confirm.ts`, which calls them server-side).
          matcher: (ctx) => VERIFY_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.request) return;
            const session = await getSessionFromCtx(ctx);
            if (!session?.user.twoFactorEnabled) return;
            throw new APIError("FORBIDDEN", {
              code: "USE_STEP_UP",
              message: "verify a code for this session through the step-up prompt",
            });
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => VERIFY_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            // Set only when this verification minted the session: a sign-in's
            // second step, or the first code of an enrollment.
            const minted = ctx.context.newSession;
            if (!minted) return;
            await ctx.context.internalAdapter.updateSession(minted.session.token, {
              stepUpAt: new Date(),
            });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
