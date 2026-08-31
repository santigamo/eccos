/**
 * Organization baseline auth configuration conventions.
 *
 * Request-scoped factory, fail-closed secret handling, canonical-origin
 * allowlist, cookie posture, session freshness for step-up, and database-backed
 * (cross-isolate) rate limiting. The caller supplies the database (a dedicated
 * per-product EU-jurisdiction D1), the secret, and the mail sender.
 */

import { betterAuth, type BetterAuthOptions } from "better-auth";
import { organization, twoFactor } from "better-auth/plugins";
import { ac, owner, admin, operator, viewer } from "./permissions";

/** Minimal user shape of the verification/reset email callbacks. */
interface MailCallbackUser {
  email: string;
  name: string;
}

interface MailCallbackData {
  user: MailCallbackUser;
  url: string;
  token: string;
}

/** Mail adapter the host application owns (provider isolated per project). */
export interface MailSender {
  sendMail(message: { to: string; subject: string; text: string; html?: string }): Promise<void>;
}

export interface OrgAuthConfig {
  /** Dedicated per-product D1 binding (or bun:sqlite in tests). */
  database: unknown;
  /** Auth secret (>= 32 chars). Required; fail closed without it. */
  secret: string;
  /** Canonical origin of THIS product's dashboard. */
  baseURL: string;
  /** Extra trusted origins (defaults to the canonical origin only). */
  trustedOrigins?: string[];
  /** Application-owned mail adapter. */
  mail: MailSender;
  /** Disable organization deletion (v1 products without an offboarding saga). */
  disableOrganizationDeletion?: boolean;
}

function assertValidConfig(config: OrgAuthConfig): void {
  if (!config.secret || config.secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be set (at least 32 characters)");
  }
  if (!config.baseURL) {
    throw new Error("Auth baseURL is required");
  }
}

export function createOrgAuthConfig(config: OrgAuthConfig): BetterAuthOptions {
  assertValidConfig(config);

  const secureCookies = config.baseURL.startsWith("https://");

  return {
    // Cast: the Kysely adapter accepts every SQLite-ish driver (D1 in the
    // Worker, bun:sqlite in tests); `unknown` keeps callers driver-agnostic.
    database: config.database as never,
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: config.trustedOrigins ?? [config.baseURL],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async (data: MailCallbackData) => {
        const { user, url } = data;
        await config.mail.sendMail({
          to: user.email,
          subject: "Reset your password",
          text: `Hello ${user.name},\n\nReset your password with this link (valid for a limited time):\n${url}\n\nIf you did not request a reset, you can ignore this email.`,
        });
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 15,
    },
    // Buckets key on `${callerIP}|${path}`, never on the request body: these
    // rules cap one caller, they are not a per-recipient guarantee.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: "database",
      customRules: {
        "/sign-in/email": { window: 300, max: 10 },
        "/sign-up/email": { window: 3600, max: 20 },
        "/forgot-password": { window: 3600, max: 10 },
        // Unauthenticated, caller-supplied address, real mail on every call:
        // without its own rule this endpoint is an email-bombing primitive
        // aimed at a third party's inbox (eccos-hk5).
        "/send-verification-email": { window: 300, max: 5 },
        "/organization/invite": { window: 3600, max: 50 },
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async (data: MailCallbackData) => {
        const { user, url } = data;
        await config.mail.sendMail({
          to: user.email,
          subject: "Verify your email",
          text: `Hello ${user.name},\n\nVerify your email address with this link:\n${url}\n\nIf you did not sign up, you can ignore this email.`,
        });
      },
    },
    plugins: [
      twoFactor(),
      organization({
        ac,
        roles: { owner, admin, operator, viewer },
        disableOrganizationDeletion: config.disableOrganizationDeletion ?? true,
        requireEmailVerificationOnInvitation: true,
        sendInvitationEmail: async ({ invitation, organization, inviter }) => {
          const acceptLink = `${config.baseURL}/invitations/${invitation.id}`;
          await config.mail.sendMail({
            to: invitation.email,
            subject: `You are invited to join ${organization.name}`,
            text: `Hello,\n\n${inviter.user.name} (${inviter.user.email}) invited you to join the "${organization.name}" workspace.\n\nAccept your invitation here:\n${acceptLink}\n\nIf you were not expecting this, you can ignore the email.`,
          });
        },
      }),
    ],
    advanced: {
      disableOriginCheck: false,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax" as const,
        secure: secureCookies,
      },
    },
  };
}
