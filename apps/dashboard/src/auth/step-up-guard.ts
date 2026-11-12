/**
 * Step-up inside Better Auth (contract §4/§8/§9).
 *
 * Stamps `session.stepUpAt` when a session is minted by a second-factor
 * verification, and refuses the endpoints that would otherwise let a password
 * alone change a factor or act on members. Hooks, so a direct HTTP call and a
 * server-side `auth.api.*` call are covered alike.
 */

import type { StepUpReason } from "@eccos/auth-baseline/step-up";
import { getCurrentAuthContext } from "@better-auth/core/context";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { roles } from "./permissions";
import { stepUpMessage, stepUpRefusal } from "./step-up";

/**
 * Endpoints that change or reveal a factor and otherwise ask only for the
 * password. Gated once the account HAS a second factor: before that there is
 * nothing for a password to bypass, and a user without TOTP must still be able
 * to change their password or enroll (`enrollment-proof.ts` asks for a mailed
 * code there). The one exception is `get-totp-uri`, gated always.
 */
export const STEP_UP_ACCOUNT_PATHS: ReadonlySet<string> = new Set([
  "/change-password",
  "/change-email",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/two-factor/get-totp-uri",
]);

const VERIFY_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

const ERROR_CODES: Record<StepUpReason, string> = {
  "totp-required": "TOTP_REQUIRED",
  "reauth-required": "SESSION_NOT_FRESH",
};

function refuse(reason: StepUpReason): never {
  throw new APIError("FORBIDDEN", { code: ERROR_CODES[reason], message: stepUpMessage(reason) });
}

/**
 * Member management (invitations, role changes, removal). These run as
 * Better Auth's `organizationHooks`, AFTER it has resolved the organization
 * and checked the caller's role there, so a role that lacks the action gets
 * its permission error and nothing here re-derives either. The hooks are
 * handed no session, so it is read from the request's own context.
 */
async function requireMemberStepUp(): Promise<void> {
  const ctx = (await getCurrentAuthContext()) as Parameters<typeof getSessionFromCtx>[0];
  const session = await getSessionFromCtx(ctx);
  refuseUnlessSteppedUp(session);
}

function refuseUnlessSteppedUp(session: Parameters<typeof stepUpRefusal>[0] | null): void {
  // No session here would be a Better Auth bug: fail closed.
  const refusal = session ? stepUpRefusal(session) : "reauth-required";
  if (refusal) refuse(refusal);
}

/**
 * Whether a member's role string is KNOWN not to grant invitations. Split as
 * Better Auth's permission check splits it (on commas, nothing trimmed), and
 * closed on doubt: one role this module does not know, an empty string, or a
 * padded name, and the answer is no, so step-up still applies.
 */
function knownNotToInvite(role: unknown): boolean {
  if (typeof role !== "string" || role === "") return false;
  return role
    .split(",")
    .every(
      (name) =>
        Object.hasOwn(roles, name) &&
        roles[name as keyof typeof roles].authorize({ invitation: ["create"] }).success !== true,
    );
}

export const stepUpOrganizationHooks = {
  beforeCreateInvitation: requireMemberStepUp,
  beforeCancelInvitation: requireMemberStepUp,
  beforeUpdateMemberRole: requireMemberStepUp,
  beforeRemoveMember: requireMemberStepUp,
};

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
          // A RESEND returns from Better Auth before `beforeCreateInvitation`
          // is ever called, so that one branch is gated here instead. The
          // organization is resolved as Better Auth resolves it, and step-up
          // is skipped only for a member KNOWN to lack the permission, who
          // then gets Better Auth's own error. Anything unresolved does not skip.
          matcher: (ctx) => ctx.path === "/organization/invite-member",
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.body?.resend) return;
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            const organizationId =
              ctx.body.organizationId || session.session.activeOrganizationId;
            const member = organizationId
              ? await ctx.context.adapter.findOne<{ role?: unknown }>({
                  model: "member",
                  where: [
                    { field: "userId", value: session.user.id },
                    { field: "organizationId", value: organizationId },
                  ],
                })
              : null;
            if (member && knownNotToInvite(member.role)) return;
            refuseUnlessSteppedUp(session);
          }),
        },
        {
          matcher: (ctx) => STEP_UP_ACCOUNT_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            // No session: the endpoint's own middleware answers 401.
            if (!session) return;
            // A pending enrollment's secret is not handed out for the password
            // alone: whoever reads it can finish the enrollment.
            if (!session.user.twoFactorEnabled && ctx.path !== "/two-factor/get-totp-uri") return;
            refuseUnlessSteppedUp(session);
          }),
        },
        {
          // An enrolled, signed-in caller has no business here over HTTP: the
          // step-up check (`step-up-confirm.ts`) calls these server-side and
          // owns the lockout around them, so a direct call would be a free
          // oracle for codes.
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
            // Set only when this verification SUCCEEDED and minted a session
            // for the user it verified: a sign-in's second step, or the first
            // code of an enrollment. A session left on the context by a call
            // that then failed, or one for anybody else, is not stamped.
            const minted = ctx.context.newSession;
            const answer = ctx.context.returned as { user?: { id?: unknown } } | undefined;
            if (!minted || !answer || answer instanceof Error) return;
            if (answer.user?.id !== minted.session.userId) return;
            await ctx.context.internalAdapter.updateSession(minted.session.token, {
              stepUpAt: new Date(),
            });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
