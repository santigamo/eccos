/**
 * Proof of inbox control before TOTP can be set up, and a mail whenever a
 * second factor changes (contract §8).
 *
 * Without the proof, a stolen cookie plus the password could enroll the
 * thief's own authenticator on an account that has none, and that enrollment
 * counts as a step-up (`step-up-guard.ts`).
 */

import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sessionMiddleware,
} from "better-auth/api";
import { defineRequestState } from "@better-auth/core/context";
import { generateRandomString } from "better-auth/crypto";
import { z } from "zod";
import { sha256Hex } from "../lib/sha256";

export const ENABLE_CODE_TTL_SECONDS = 10 * 60;
export const ENABLE_CODE_RESEND_SECONDS = 60;
/** Long enough that guessing is hopeless: every attempt spends the code. */
const ENABLE_CODE_LENGTH = 8;

export type TwoFactorChange = "enabled" | "disabled" | "backup-codes";

interface Recipient {
  id: string;
  email: string;
  name: string;
}

/** The two mails this plugin sends, composed by the caller that owns the mail adapter. */
export interface TwoFactorMail {
  /** `unique` identifies this send without being the code. Throws when it cannot be sent. */
  code(user: Recipient, code: string, unique: string): Promise<void>;
  /** A throw here is a provider fault, never an undeliverable address. */
  changed(user: Recipient, change: TwoFactorChange): Promise<void>;
}

const CHANGES: Record<string, TwoFactorChange> = {
  "/two-factor/verify-totp": "enabled",
  "/two-factor/disable": "disabled",
  "/two-factor/generate-backup-codes": "backup-codes",
};

/** The mailed code an `enable` request presented, once it proved right. */
const rightCode = defineRequestState<{ identifier: string; value: string; expiresAt: Date } | null>(
  () => null,
);

/** The signed-in caller as a request to one of `CHANGES` found them, or null. */
const callerBefore = defineRequestState<(Recipient & { twoFactorEnabled?: boolean | null }) | null>(
  () => null,
);

const identifierOf = (userId: string) => `two-factor-enable-${userId}`;

const digest = (userId: string, code: string) =>
  sha256Hex(`${userId}:${code.trim().toUpperCase()}`);

export function enrollmentProof(mail: TwoFactorMail) {
  return {
    id: "enrollment-proof",
    endpoints: {
      sendTwoFactorEnableCode: createAuthEndpoint(
        "/two-factor/send-enable-code",
        { method: "POST", body: z.object({ password: z.string() }), use: [sessionMiddleware] },
        async (ctx) => {
          const { user } = ctx.context.session;
          await ctx.context.password.checkPassword(user.id, ctx);
          const identifier = identifierOf(user.id);
          const { adapter, internalAdapter } = ctx.context;
          // One send a minute per account, decided by a single insert: the
          // marker's key is its identifier, so of any number of sends at once
          // exactly one lands. A marker past its minute is cleared first.
          const marker = `${identifier}-sent`;
          await adapter.deleteMany({
            model: "verification",
            where: [
              { field: "identifier", value: marker },
              { field: "expiresAt", operator: "lt", value: new Date() },
            ],
          });
          const mine = await internalAdapter.reserveVerificationValue({
            identifier: marker,
            value: "sent",
            expiresAt: new Date(Date.now() + ENABLE_CODE_RESEND_SECONDS * 1000),
          });
          if (!mine) {
            throw new APIError("TOO_MANY_REQUESTS", {
              code: "ENABLE_CODE_JUST_SENT",
              message: "a code was sent less than a minute ago",
            });
          }
          const code = generateRandomString(ENABLE_CODE_LENGTH, "A-Z", "0-9");
          const value = await digest(user.id, code);
          await internalAdapter.deleteVerificationByIdentifier(identifier);
          try {
            await mail.code(user, code, value);
          } catch (error) {
            // A send that failed starts no wait.
            await internalAdapter.deleteVerificationByIdentifier(marker);
            throw error;
          }
          await internalAdapter.createVerificationValue({
            identifier,
            value,
            expiresAt: new Date(Date.now() + ENABLE_CODE_TTL_SECONDS * 1000),
          });
          return ctx.json({ status: true });
        },
      ),
    },
    rateLimit: [
      {
        pathMatcher: (path) => path === "/two-factor/send-enable-code",
        window: 3600,
        max: 10,
      },
    ],
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/two-factor/enable",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            // No session: the endpoint's own middleware answers 401.
            if (!session) return;
            const code: unknown = ctx.body?.emailCode;
            const identifier = identifierOf(session.user.id);
            // Taken before it is compared, so a code gets exactly one guess
            // however many arrive at once.
            const sent =
              typeof code === "string"
                ? await ctx.context.internalAdapter.consumeVerificationValue(identifier)
                : null;
            if (
              typeof code !== "string" ||
              !sent ||
              new Date(sent.expiresAt).getTime() <= Date.now() ||
              sent.value !== (await digest(session.user.id, code))
            ) {
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_CODE_REQUIRED",
                message: "setting up two-factor authentication needs the code sent to your email",
              });
            }
            await rightCode.set({ identifier, value: sent.value, expiresAt: sent.expiresAt });
          }),
        },
        {
          matcher: (ctx) => Object.hasOwn(CHANGES, ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            await callerBefore.set((await getSessionFromCtx(ctx))?.user ?? null);
          }),
        },
      ],
      after: [
        {
          // The right code is spent by a setup that started. If Better Auth
          // then refused the request for a reason of its own, it is put back.
          matcher: (ctx) => ctx.path === "/two-factor/enable",
          handler: createAuthMiddleware(async (ctx) => {
            const taken = await rightCode.get();
            if (taken && ctx.context.returned instanceof Error) {
              await ctx.context.internalAdapter.createVerificationValue(taken);
            }
          }),
        },
        {
          matcher: (ctx) => Object.hasOwn(CHANGES, ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const answer = ctx.context.returned;
            const user = await callerBefore.get();
            const change = CHANGES[ctx.path ?? ""];
            if (!answer || answer instanceof Error || !user || !change) return;
            // A verified code turned TOTP on only if the account's flag went
            // from off to on across this request: not a sign-in's code (no
            // caller), not a step-up (already on).
            if (change === "enabled") {
              const now = await ctx.context.internalAdapter.findUserById(user.id);
              if (user.twoFactorEnabled || !(now && "twoFactorEnabled" in now && now.twoFactorEnabled)) {
                return;
              }
            }
            // The change already happened: a mail that fails must not undo or hide it.
            await mail.changed(user, change).catch((error: unknown) => {
              ctx.context.logger.error("two-factor change notification failed", error);
            });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
