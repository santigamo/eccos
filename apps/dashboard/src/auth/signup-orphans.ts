/**
 * Keeps an email+password sign-up from leaving an orphan user (eccos-nlzu).
 *
 * Better Auth inserts the `user` row, then the `credential` `account` row, as
 * two statements — D1 has no interactive transactions. If the second insert
 * fails, the user stays without a password: sign-in can never succeed, and a
 * retry hits the existing-email path and answers a generic 200.
 */

import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

export function signupOrphanGuard() {
  return {
    id: "signup-orphan-guard",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/sign-up/email",
          handler: createAuthMiddleware(async (ctx) => {
            const adapter = ctx.context.internalAdapter;

            // Self-heal an orphan left by an earlier attempt. Unverified and
            // account-less: only a half-finished sign-up produces that.
            const email: unknown = ctx.body?.email;
            if (typeof email === "string") {
              const found = await adapter.findUserByEmail(email, { includeAccounts: true });
              if (found && !found.user.emailVerified && found.accounts.length === 0) {
                await adapter.deleteUser(found.user.id);
              }
            }

            // `ctx.context` is this request's copy, so the override stays
            // scoped to this sign-up: the only user linked here is the one it
            // just created, and a failed link removes it.
            ctx.context.internalAdapter = {
              ...adapter,
              linkAccount: async (account) => {
                try {
                  return await adapter.linkAccount(account);
                } catch (error) {
                  await adapter.deleteUser(account.userId).catch((cleanupError: unknown) => {
                    ctx.context.logger.error("Failed to delete orphan user after sign-up", cleanupError);
                  });
                  throw error;
                }
              },
            };
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
