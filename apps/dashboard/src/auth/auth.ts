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
import {
  AUTH_LINK_EXPIRY_SECONDS,
  deriveIdempotencyKey,
  extractTokenFromUrl,
  MailUndeliverableError,
  recipientDomain,
  type MailSender,
  type MailTemplate,
  type SendOutcome,
} from "./mail";
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

/**
 * ─── Per-flow mail policy ────────────────────────────────────────────────────
 *
 * The mail adapter reports an outcome; the POLICY of what to do with it lives
 * here, at the call sites, because the three flows genuinely differ. They are
 * exported as named functions so each decision can be tested on its own — and
 * because the reasoning below is the actual deliverable, not the four lines of
 * code under it.
 *
 * A NOTE ON WHERE THESE THROWS SURFACE (better-auth 1.7.2): sign-up, forgot
 * password, and create-invitation all wrap the send in
 * `ctx.context.runInBackgroundOrAwait` (dist/context/create-context.mjs:214),
 * which awaits the promise inside a try/catch and merely LOGS a rejection. So
 * a throw from this layer does NOT currently reach the sign-up or invitation
 * response — only `POST /send-verification-email` re-throws it
 * (dist/api/routes/email-verification.mjs:117). The policy is written to the
 * contract anyway: it is correct, it is what surfaces the moment better-auth
 * propagates, and the structured log below is the durable record in the
 * meantime. See docs/auth-email-delivery.md.
 */

/** What a policy needs in order to log without ever touching a token. */
export interface MailPolicyContext {
  template: MailTemplate;
  /** Full address — only its DOMAIN is ever logged. */
  to: string;
  /** Already a SHA-256 digest, so it is safe to log verbatim. */
  idempotencyKey: string;
}

/**
 * The one structured event that records a send was ever in doubt.
 *
 * NEVER logs the URL: it carries an action-capable token, and mail.ts documents
 * that invariant. The recipient's domain, the template, and the (hashed) key
 * are what an operator needs to correlate a complaint with a send.
 */
function logMailEvent(
  event: "send-unresolved" | "send-undeliverable",
  ctx: MailPolicyContext,
  extra?: Record<string, string>,
): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      area: "auth-mail",
      event,
      template: ctx.template,
      toDomain: recipientDomain(ctx.to),
      idempotencyKey: ctx.idempotencyKey,
      ...extra,
    }),
  );
}

/**
 * `unresolved` (504) — never throws, at ANY call site.
 *
 * The status is terminal and permanently unresolvable: it cannot be retried
 * (a replay under the same key returns the stored status) and it cannot be
 * polled (delivery events correlate by a provider message id that is null
 * exactly when the outcome is unknown). Failing the user's flow over a message
 * that probably arrived would be worse than the doubt itself, and the
 * check-your-inbox screen already offers a resend. So: log, and continue.
 */
function handleUnresolved(ctx: MailPolicyContext): void {
  logMailEvent("send-unresolved", ctx);
}

/**
 * Sign-up / verification. An undeliverable address is SURFACED.
 *
 * Safe because an existing account short-circuits before any send happens, so
 * this discloses the deliverability of a freshly typed address — not
 * membership. And the dominant cause is the user's own typo, which only they
 * can fix; swallowing it would leave them staring at a "check your inbox"
 * screen for an inbox that does not exist.
 */
export function applyVerificationSendPolicy(
  outcome: SendOutcome,
  ctx: MailPolicyContext,
): void {
  if (outcome.status === "unresolved") {
    handleUnresolved(ctx);
    return;
  }
  if (outcome.status === "undeliverable") {
    logMailEvent("send-undeliverable", ctx, { reason: outcome.reason });
    throw new MailUndeliverableError(outcome.reason);
  }
}

/**
 * Password reset. An undeliverable address is NEVER surfaced.
 *
 * `sendResetPassword` only runs for accounts that EXIST — better-auth returns
 * the same generic response for an unknown address without calling this at all
 * (dist/api/routes/password.mjs: the `!user` branch simulates the work and
 * returns early). So any observable difference here is a membership oracle:
 * "undeliverable" would mean "this address has an account", and silence would
 * mean it does not. Swallow it, log it, keep the generic response.
 */
export function applyResetSendPolicy(
  outcome: SendOutcome,
  ctx: MailPolicyContext,
): void {
  if (outcome.status === "unresolved") {
    handleUnresolved(ctx);
    return;
  }
  if (outcome.status === "undeliverable") {
    logMailEvent("send-undeliverable", ctx, { reason: outcome.reason });
  }
}

/**
 * Invitation. An undeliverable address is SURFACED to the inviter.
 *
 * No enumeration concern: the inviter is authenticated, typed the address
 * themselves, and is the only person who can correct it. A silently dropped
 * invitation is the worst outcome here — the inviter believes it went out and
 * waits for an acceptance that can never come.
 */
export function applyInvitationSendPolicy(
  outcome: SendOutcome,
  ctx: MailPolicyContext,
): void {
  if (outcome.status === "unresolved") {
    handleUnresolved(ctx);
    return;
  }
  if (outcome.status === "undeliverable") {
    logMailEvent("send-undeliverable", ctx, { reason: outcome.reason });
    throw new MailUndeliverableError(outcome.reason);
  }
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
      // Explicit, not inherited: the reset screen tells the reader how long the
      // link lasts, so the lifetime is a shared constant rather than whatever
      // better-auth defaults to this release (see AUTH_LINK_EXPIRY_SECONDS).
      resetPasswordTokenExpiresIn: AUTH_LINK_EXPIRY_SECONDS,
      // Reset links point at the canonical origin; delivery goes through the
      // application-owned mail adapter.
      sendResetPassword: async (data: MailCallbackData) => {
        const { user, url, token } = data;
        // Key off the token that is actually IN the message, taken from the
        // URL better-auth built. `data.token` is the identical value (the URL
        // is built from it) and stands in only if the URL shape ever changes —
        // never the URL itself, which contains the token.
        const resetToken = extractTokenFromUrl(url, "reset-password") ?? token;
        const idempotencyKey = await deriveIdempotencyKey(
          "reset-password",
          user.email,
          resetToken,
        );
        const outcome = await config.mail.sendTemplate({
          template: "reset-password",
          to: user.email,
          variables: { name: user.name, url },
          idempotencyKey,
        });
        applyResetSendPolicy(outcome, {
          template: "reset-password",
          to: user.email,
          idempotencyKey,
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
      // Same reason as resetPasswordTokenExpiresIn above: the check-your-inbox
      // screen quotes this duration, so it cannot be an implicit default.
      expiresIn: AUTH_LINK_EXPIRY_SECONDS,
      sendVerificationEmail: async (data: MailCallbackData) => {
        const { user, url, token } = data;
        // Same rule as the reset flow: the key derives from the real token in
        // the message, so a framework retry replays and dedupes, while a
        // user-initiated resend mints a fresh token and genuinely sends.
        const verificationToken = extractTokenFromUrl(url, "verify-email") ?? token;
        const idempotencyKey = await deriveIdempotencyKey(
          "verify-email",
          user.email,
          verificationToken,
        );
        const outcome = await config.mail.sendTemplate({
          template: "verify-email",
          to: user.email,
          variables: { name: user.name, url },
          idempotencyKey,
        });
        applyVerificationSendPolicy(outcome, {
          template: "verify-email",
          to: user.email,
          idempotencyKey,
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
        //
        // WHEN A "RESEND INVITATION" BUTTON IS BUILT, IT MUST BE
        // CANCEL-PLUS-RECREATE — never Better Auth's reuse-the-same-invitation
        // resend.
        //
        // The idempotency key is sha256("invite-member:" + email +
        // ":" + invitation.id). Better Auth's re-invite path keeps the SAME
        // invitation id and only extends `expiresAt`
        // (dist/plugins/organization/routes/crud-invites.mjs:150), so the
        // payload is byte-identical under an identical key and the provider
        // dedupes it into `duplicate`: the mail SILENTLY NEVER SENDS, and the
        // console would report success. Cancelling and creating a new
        // invitation mints a new id, hence a new key, hence a real send.
        sendInvitationEmail: async ({ invitation, organization, inviter }) => {
          const acceptLink = buildInvitationAcceptLink(config.baseURL, invitation.id);
          // The invitation id IS the unique element of this payload (there is
          // no token: the link is a pointer, and acceptance re-checks the
          // signed-in identity), so it plays the role the token plays above.
          const idempotencyKey = await deriveIdempotencyKey(
            "invite-member",
            invitation.email,
            invitation.id,
          );
          const outcome = await config.mail.sendTemplate({
            template: "invite-member",
            to: invitation.email,
            variables: {
              accept_url: acceptLink,
              inviter_email: inviter.user.email,
              inviter_name: inviter.user.name,
              workspace: organization.name,
            },
            idempotencyKey,
          });
          applyInvitationSendPolicy(outcome, {
            template: "invite-member",
            to: invitation.email,
            idempotencyKey,
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
