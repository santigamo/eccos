/**
 * Step-up for the Better Auth organization endpoints the capability matrix
 * marks sensitive (contract §4/§9): invitations and member role changes.
 *
 * A `before` hook, so it covers a direct HTTP call and a server-side
 * `auth.api.*` call alike. The Eccos server functions enforce the same policy
 * through `requireStepUp`.
 */

import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { stepUpMessage, stepUpRefusal } from "./step-up";

export const STEP_UP_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/organization/invite-member",
  "/organization/cancel-invitation",
  "/organization/update-member-role",
  "/organization/remove-member",
]);

export function stepUpGuard() {
  return {
    id: "step-up-guard",
    hooks: {
      before: [
        {
          matcher: (ctx) => STEP_UP_AUTH_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            // No session: the endpoint's own middleware answers 401.
            if (!session) return;
            const refusal = stepUpRefusal(session);
            if (refusal) {
              throw new APIError("FORBIDDEN", {
                code: refusal === "totp-required" ? "TOTP_REQUIRED" : "SESSION_NOT_FRESH",
                message: stepUpMessage(refusal),
              });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
