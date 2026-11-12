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
import { generateRandomString } from "better-auth/crypto";
import { z } from "zod";

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

const identifierOf = (userId: string) => `two-factor-enable-${userId}`;

async function digest(userId: string, code: string): Promise<string> {
  const data = new TextEncoder().encode(`${userId}:${code.trim().toUpperCase()}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
          const { internalAdapter } = ctx.context;
          const last = await internalAdapter.findVerificationValue(identifier);
          const sentAt = last ? new Date(last.createdAt).getTime() : 0;
          if (Date.now() - sentAt < ENABLE_CODE_RESEND_SECONDS * 1000) {
            throw new APIError("TOO_MANY_REQUESTS", {
              code: "ENABLE_CODE_JUST_SENT",
              message: "a code was sent less than a minute ago",
            });
          }
          const code = generateRandomString(ENABLE_CODE_LENGTH, "A-Z", "0-9");
          const value = await digest(user.id, code);
          await internalAdapter.deleteVerificationByIdentifier(identifier);
          await internalAdapter.createVerificationValue({
            identifier,
            value,
            expiresAt: new Date(Date.now() + ENABLE_CODE_TTL_SECONDS * 1000),
          });
          await mail.code(user, code, value);
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
            // Consumed before it is compared, so a code gets exactly one attempt.
            const sent =
              typeof code === "string"
                ? await ctx.context.internalAdapter.consumeVerificationValue(
                    identifierOf(session.user.id),
                  )
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
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => Object.hasOwn(CHANGES, ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const answer = ctx.context.returned as { token?: unknown } | undefined;
            if (!answer || answer instanceof Error) return;
            const minted = ctx.context.newSession;
            const change = CHANGES[ctx.path ?? ""];
            // A verified code enabled TOTP only if it replaced the caller's
            // session: a sign-in answers with the session it minted, and a
            // step-up mints none.
            if (change === "enabled" && (!minted || answer.token === minted.session.token)) return;
            const user = minted?.user ?? (await getSessionFromCtx(ctx))?.user;
            if (!change || !user) return;
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
