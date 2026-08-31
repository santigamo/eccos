/**
 * Better Auth instance factory for the customer dashboard.
 *
 * The identity plane (users, sessions, organizations) lives in the dedicated
 * auth D1 database — see docs/auth-tenancy-contract.md §2/§3. This factory is
 * request-scoped: the Worker calls it inside the fetch handler with the
 * request's bindings; there is NO module-global auth state (contract §5).
 *
 * Database: the built-in Kysely adapter accepts a Cloudflare D1 database
 * binding in the Worker and a bun:sqlite Database in local tests — both are
 * supported SQLite drivers, so the same configuration serves both targets.
 */

import { betterAuth } from "better-auth";
import { organization, twoFactor } from "better-auth/plugins";
import type { MailSender } from "./mail";
import { ac, owner, admin, operator, viewer } from "./permissions";

/**
 * Build the accept-invitation link for the dashboard UI.
 *
 * The invitations route is `createFileRoute("/invitations")` and reads the
 * invitation id from the `?id=` query param (src/routes/invitations.tsx) —
 * there is no `/invitations/:id` route. A path-segment link would dead-end:
 * anonymous invitees bounce to /signin?redirect=/invitations/<id> and after
 * sign-in the redirect targets a non-existent route (eccos-omv).
 *
 * The link is a pointer, not a capability: acceptance still requires the
 * signed-in matching verified identity (contract §7), enforced by the auth
 * API and re-checked by the route.
 */
export function buildInvitationAcceptLink(baseURL: string, invitationId: string): string {
  return `${baseURL.replace(/\/$/, "")}/invitations?id=${encodeURIComponent(invitationId)}`;
}

/** Minimal user shape of Better Auth's verification/reset email callbacks. */
interface MailCallbackUser {
  email: string;
  name: string;
}

interface MailCallbackData {
  user: MailCallbackUser;
  url: string;
  token: string;
}

/** Request-scoped inputs for building the auth instance. */
export interface AuthConfig {
  /** D1 binding in the Worker; bun:sqlite in tests. */
  database: unknown;
  /** Auth secret (>= 32 chars). Required; fail closed without it. */
  secret: string;
  /** Canonical origin, e.g. https://app.eccos.chat (or http://localhost:3000). */
  baseURL: string;
  /** Origin allowlist for cross-origin auth requests (contract §6). */
  trustedOrigins: string[];
  /** Application-owned email adapter (contract §8). */
  mail: MailSender;
}

function assertValidConfig(config: AuthConfig): void {
  if (!config.secret || config.secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be set (at least 32 characters)");
  }
  if (!config.baseURL) {
    throw new Error("Auth baseURL is required");
  }
}

export function createAuth(config: AuthConfig) {
  assertValidConfig(config);

  const secureCookies = config.baseURL.startsWith("https://");

  // NOTE: no explicit `BetterAuthOptions` annotation — the return-type
  // inference of `betterAuth` (and the plugin endpoints exposed on `auth.api`,
  // e.g. the organization plugin's listOrganizations/hasPermission) depends on
  // the literal options shape.
  const options = {
    // Cast: the Kysely adapter accepts every SQLite-ish driver (D1 in the
    // Worker, bun:sqlite in tests); `unknown` in AuthConfig keeps this factory
    // decoupled from the caller's driver type.
    database: config.database as never,
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      // Server-side password policy (eccos-ya5): previously only the client
      // enforced minLength={8}. better-auth 1.7.2 exposes the policy as
      // `emailAndPassword.minPasswordLength` (no top-level `password` key, no
      // `requireStrongPassword` in this version) — default 8, max 128.
      // The D1 adapter rejects shorter passwords at sign-up with
      // PASSWORD_TOO_SHORT, so the rule holds server-side regardless of UI.
      minPasswordLength: 10,
      // Reset links point at the canonical origin; delivery goes through the
      // application-owned mail adapter.
      sendResetPassword: async (data: MailCallbackData) => {
            const { user, url } = data;
        await config.mail.sendMail({
          to: user.email,
          subject: "Reset your Eccos password",
          text: `Hello ${user.name},\n\nReset your password with this link (valid for a limited time):\n${url}\n\nIf you did not request a reset, you can ignore this email.`,
        });
      },
    },
    // Session rules (contract §5/§8): 7-day expiry matches the previous
    // behavior; freshness window = 15 minutes for the step-up policy.
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 15,
    },
    // Distributed rate limiting (contract §8): counters live in the auth D1
    // (storage: "database"), shared across all isolates — never per-isolate
    // memory. Tighter windows for auth-critical paths.
    //
    // WHAT THE COUNTER KEYS ON: Better Auth builds the bucket key as
    // `${ip}|${path}` (createRateLimitKey in @better-auth/core/utils/ip) — the
    // CALLER's address and the route, never the request body. There is no way
    // to key a rule on the target email, so none of these rules is a
    // per-recipient guarantee: they cap what one caller can do, and a caller
    // with many addresses is still only bounded per address. Recipient-side
    // protection (per-address send budgets) belongs to the mail layer.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: "database" as const,
      customRules: {
        "/sign-in/email": { window: 300, max: 10 },
        "/sign-up/email": { window: 3600, max: 20 },
        "/forgot-password": { window: 3600, max: 10 },
        // The "Resend" button on the check-your-inbox screen (eccos-hk5). The
        // address is caller-supplied and unauthenticated, so every call sends
        // real mail to a third party's inbox off our sending domain — the cost
        // of a loose limit lands on them and on our domain reputation, not on
        // us. 5 per 300 s: the 300 s window is the one already used by
        // /sign-in/email rather than a third arbitrary duration, and 5 leaves a
        // person who genuinely did not receive the mail room to double-click,
        // check spam, and ask twice more before waiting. It caps one caller at
        // 60 mails/hour against a chosen address, against the ~180/hour the
        // framework's own default for this path allows (60 s / 3) and the
        // 6000/hour the global 60 s / 100 rule would.
        "/send-verification-email": { window: 300, max: 5 },
        "/organization/invite": { window: 3600, max: 50 },
      },
    },
    emailVerification: {
      // A verified email is required before any organization or membership use
      // (contract §7).
      sendOnSignUp: true,
      sendVerificationEmail: async (data: MailCallbackData) => {
            const { user, url } = data;
        await config.mail.sendMail({
          to: user.email,
          subject: "Verify your Eccos email",
          text: `Hello ${user.name},\n\nVerify your email address with this link:\n${url}\n\nIf you did not sign up, you can ignore this email.`,
        });
      },
    },
    plugins: [
      // TOTP for owner/admin step-up before sensitive actions (contract §8);
      // enrollment UI ships with the eccos-0x0.7 dashboard pass.
      twoFactor(),
      organization({
        ac,
        roles: { owner, admin, operator, viewer },
        // Organization deletion is disabled in v1 (contract §4/§9): no
        // offboarding saga exists yet, so /organization/delete is rejected.
        disableOrganizationDeletion: true,
        // Invitations only go to verified identities (contract §7).
        requireEmailVerificationOnInvitation: true,
        // Invitation delivery through the application-owned mail adapter; the
        // link carries the invitation id (accepted by signed-in matching
        // identity via /api/auth/organization/accept-invitation).
        sendInvitationEmail: async ({ invitation, organization, inviter }) => {
          const acceptLink = buildInvitationAcceptLink(config.baseURL, invitation.id);
          await config.mail.sendMail({
            to: invitation.email,
            subject: `You are invited to join ${organization.name} on Eccos`,
            text: `Hello,\n\n${inviter.user.name} (${inviter.user.email}) invited you to join the "${organization.name}" workspace on Eccos.\n\nAccept your invitation here:\n${acceptLink}\n\nIf you were not expecting this, you can ignore the email.`,
          });
        },
      }),
    ],
    advanced: {
      // Explicit production posture: origin validation MUST run regardless of
      // NODE_ENV (Better Auth otherwise skips it in test environments).
      disableOriginCheck: false,
      // HttpOnly is Better Auth's default; SameSite=Lax is the CSRF-safe default
      // for a single-origin app. Explicit here per contract §5.
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax" as const,
        secure: secureCookies,
      },
    },
  };

  return betterAuth(options);
}

export type Auth = ReturnType<typeof createAuth>;
