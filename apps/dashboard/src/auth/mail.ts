/**
 * Application-owned email delivery interface for the identity plane.
 *
 * Better Auth needs to send verification, password-reset, and invitation
 * emails. Per the tenancy contract (docs/auth-tenancy-contract.md §8), the
 * provider lives behind this small server-side adapter: provider credentials
 * are Worker secrets and never reach the client or logs, and message URLs
 * (which carry action-capable tokens) are NEVER logged.
 *
 * The provider is reccado (eccos-3ne); the adapter is `ReccadoMailSender`
 * (./mail-reccado.ts), selected in ./config.ts when an API key is configured.
 * Operational detail lives in docs/auth-email-delivery.md.
 *
 * WHY THE INTERFACE RETURNS AN OUTCOME INSTEAD OF `void`: the three call sites
 * apply *different* policy to the *same* provider status. An undeliverable
 * address is a message the user can act on at sign-up and at invitation, but a
 * membership oracle at password reset (that flow only runs for accounts that
 * exist). Policy therefore belongs at the call sites in ./auth.ts, and the
 * adapter's job is to report the outcome faithfully — not to decide.
 */

/** The three transactional templates registered with the provider. */
export type MailTemplate = "verify-email" | "reset-password" | "invite-member";

/**
 * Declared variable sets, ONE CONSTANT PER TEMPLATE.
 *
 * These MUST match the provider's declared placeholder set EXACTLY IN BOTH
 * DIRECTIONS: reccado hard-rejects a send that omits a declared placeholder
 * *or* supplies an undeclared variable. There is no partial interpolation and
 * no tolerated extra. When a template is re-registered provider-side with a
 * renamed or added variable, change the constant here in the same deploy —
 * that is the one-line change these constants exist to make possible.
 *
 * Escaping is the provider's, not ours: a variable declared `html` is
 * HTML-escaped on interpolation, a `text` one is not. We always send plain
 * strings and never pre-escape — pre-escaping an `html` variable would
 * double-escape it.
 */
export const VERIFY_EMAIL_VARIABLES = ["name", "url"] as const;
export const RESET_PASSWORD_VARIABLES = ["name", "url"] as const;
export const INVITE_MEMBER_VARIABLES = [
  "organizationName",
  "inviterName",
  "inviterEmail",
  "url",
] as const;

/** The declared set for a template, by name. */
export const TEMPLATE_VARIABLES: Record<MailTemplate, readonly string[]> = {
  "verify-email": VERIFY_EMAIL_VARIABLES,
  "reset-password": RESET_PASSWORD_VARIABLES,
  "invite-member": INVITE_MEMBER_VARIABLES,
};

/** Why a message definitively will not arrive. */
export type UndeliverableReason = "permanent_failure" | "recipient_suppressed";

/**
 * What became of a send.
 *
 * - `sent` — the provider owns the message (200 `sent`/`duplicate`, 202
 *   `accepted`). `deduplicated` marks a replay of an already-stored key.
 * - `unresolved` — the provider answered 504 `unknown`. TERMINAL AND
 *   PERMANENTLY UNRESOLVABLE: a replay under the same key returns the stored
 *   status without re-asking, and delivery events correlate by a provider
 *   message id that is null precisely when the outcome is unknown. There is
 *   nothing to retry and nothing to poll — the structured log emitted at send
 *   time is the ENTIRE record that the message was ever in doubt. Do not add a
 *   retry or replay loop here or at a call site.
 * - `undeliverable` — the message definitively did not arrive (502
 *   `permanent_failure`, or 403 `recipient_suppressed`).
 */
export type SendOutcome =
  | { status: "sent"; deduplicated?: boolean }
  | { status: "unresolved" }
  | { status: "undeliverable"; reason: UndeliverableReason };

/** One transactional send. */
export interface MailTemplateMessage {
  template: MailTemplate;
  to: string;
  variables: Record<string, string>;
  /**
   * Caller-chosen, MANDATORY (the provider answers 400 without it). Always the
   * SHA-256 of the template, recipient, and the payload's unique element —
   * never a raw token. See `deriveIdempotencyKey`.
   */
  idempotencyKey: string;
}

export interface MailSender {
  sendTemplate(msg: MailTemplateMessage): Promise<SendOutcome>;
}

/**
 * Provider failures that are NOT a delivery outcome: they mean a bug in this
 * code or an operational emergency, so `sendTemplate` throws them rather than
 * folding them into `SendOutcome`.
 */
export type MailFailureKind =
  /** 400 — the Idempotency-Key header was missing. A bug here, never a user's. */
  | "idempotency_key_required"
  /** 401 — no/blank bearer token reached the provider. Misconfiguration. */
  | "missing_authorization"
  /**
   * 403 for anything other than `recipient_suppressed`: invalid_api_key,
   * insufficient_scope, key_expired, key_revoked, template_not_allowed,
   * template_not_found, denied_by_policy, test_key_not_allowed_in_production_send.
   * Every one is a deployment that is wrong, not a message that failed.
   */
  | "misconfiguration"
  /**
   * 409 — the same key arrived with a different payload. IMPOSSIBLE BY
   * CONSTRUCTION under `deriveIdempotencyKey` (the key derives from the
   * payload's unique element, so key and payload move together), so seeing one
   * means the derivation broke.
   */
  | "idempotency_conflict"
  /** 415 — we sent something other than application/json. A bug here. */
  | "unsupported_media_type"
  /** 429 (and 403 `quota_exceeded`) — the sending budget is gone. Should alarm. */
  | "quota_exceeded"
  /** The variable set did not match the template's declared set, or the body was too large. */
  | "contract_violation"
  /** A status the frozen contract does not define. */
  | "unexpected_status";

/** A provider failure that indicates a bug or an operational emergency. */
export class MailProviderError extends Error {
  readonly kind: MailFailureKind;
  readonly httpStatus?: number;
  readonly providerStatus?: string;

  constructor(
    kind: MailFailureKind,
    message: string,
    detail?: { httpStatus?: number; providerStatus?: string },
  ) {
    super(message);
    this.name = "MailProviderError";
    this.kind = kind;
    this.httpStatus = detail?.httpStatus;
    this.providerStatus = detail?.providerStatus;
  }
}

/**
 * Stable codes for the two undeliverable messages the console is allowed to
 * show. They travel with the thrown error so the UI maps on a code, never on
 * error text.
 */
export const MAIL_UNDELIVERABLE_CODE = "MAIL_UNDELIVERABLE" as const;
export const MAIL_SUPPRESSED_CODE = "MAIL_RECIPIENT_SUPPRESSED" as const;

export type MailUndeliverableCode =
  | typeof MAIL_UNDELIVERABLE_CODE
  | typeof MAIL_SUPPRESSED_CODE;

/**
 * Thrown by a call site whose policy is to surface an undeliverable address.
 *
 * The message is bounded and MEMBERSHIP-NEUTRAL: it says the address cannot
 * receive mail, never whether an account exists. That is only safe where an
 * existing account short-circuits before any send happens (sign-up) or where
 * the reader is authenticated and typed the address themselves (invitation).
 */
export class MailUndeliverableError extends Error {
  readonly code: MailUndeliverableCode;
  readonly reason: UndeliverableReason;

  constructor(reason: UndeliverableReason) {
    super(undeliverableMessage(reason));
    this.name = "MailUndeliverableError";
    this.reason = reason;
    this.code =
      reason === "recipient_suppressed"
        ? MAIL_SUPPRESSED_CODE
        : MAIL_UNDELIVERABLE_CODE;
  }
}

/**
 * The user-facing wording for each undeliverable reason.
 *
 * `recipient_suppressed` gets its OWN message and never the typo one: the
 * address is blocked at the provider, so retyping it cannot fix anything and
 * telling someone to check for typos would send them in a circle.
 */
export function undeliverableMessage(reason: UndeliverableReason): string {
  return reason === "recipient_suppressed"
    ? "Email to this address is currently blocked. Use a different address."
    : "That email address cannot receive mail. Check it for typos and try again.";
}

/**
 * Derive the Idempotency-Key: SHA-256 hex of
 * `<template>:<recipient>:<unique>`, where `unique` is the verification token,
 * the reset token, or the invitation id.
 *
 * WHY THIS IS THE RIGHT KEY: it derives FROM the unique element of the
 * payload, so key and payload move together. A framework retry replays the
 * same token and therefore dedupes into `duplicate` (no second mail); a
 * user-initiated resend mints a FRESH token and therefore genuinely sends; and
 * `409 idempotency_conflict` — same key, different payload — cannot happen.
 *
 * WHY IT IS HASHED: the provider stores `client_idempotency_key` deliberately
 * and never purges it. A raw verification or reset token in that header would
 * leave a live, action-capable credential sitting in a third party's storage
 * forever. Never put the raw token in the header, and never fall back to
 * hashing the whole URL (the URL contains the token).
 */
export async function deriveIdempotencyKey(
  template: MailTemplate,
  to: string,
  unique: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${template}:${to}:${unique}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Pull the action token out of the URL Better Auth hands the callback, so the
 * key derives from the token that is actually in the message.
 *
 * The two shapes better-auth 1.7.2 builds:
 * - verify-email:   `<baseURL>/verify-email?token=<token>&callbackURL=…`
 * - reset-password: `<baseURL>/reset-password/<token>?callbackURL=…`
 *
 * Returns null when the URL does not match — callers fall back to the `token`
 * field of the same callback payload (the identical value; better-auth builds
 * the URL from it) and NEVER to hashing the URL itself.
 */
export function extractTokenFromUrl(
  url: string,
  template: "verify-email" | "reset-password",
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (template === "verify-email") {
    return parsed.searchParams.get("token") || null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last && last !== "reset-password" ? decodeURIComponent(last) : null;
}

/** The recipient's domain — the only part of an address safe to log. */
export function recipientDomain(to: string): string {
  return to.split("@")[1] ?? "unknown";
}

/**
 * Development sender. Records nothing sensitive: the recipient's DOMAIN and
 * the template only. `variables` is never logged — it carries the `url`, and
 * that URL carries an action-capable token.
 */
export class ConsoleMailSender implements MailSender {
  async sendTemplate(msg: MailTemplateMessage): Promise<SendOutcome> {
    console.info(
      JSON.stringify({
        level: "info",
        area: "auth-mail",
        event: "email-dev-send",
        template: msg.template,
        toDomain: recipientDomain(msg.to),
        idempotencyKey: msg.idempotencyKey,
      }),
    );
    return { status: "sent" };
  }
}

/**
 * Test helper: captures every send so tests can assert on the messages Better
 * Auth produces, and can force an outcome to exercise per-flow policy.
 */
export class CaptureMailSender implements MailSender {
  readonly sent: MailTemplateMessage[] = [];
  outcome: SendOutcome = { status: "sent" };

  constructor(outcome?: SendOutcome) {
    if (outcome) this.outcome = outcome;
  }

  async sendTemplate(msg: MailTemplateMessage): Promise<SendOutcome> {
    this.sent.push(msg);
    return this.outcome;
  }
}

/** Env shape the mail adapter reads (all optional in development). */
export interface MailEnv {
  /** Worker SECRET. Absent = development console sender. */
  RECCADO_API_KEY?: string;
  /**
   * Worker SECRET: the full message endpoint,
   * `https://<host>/v1/mailboxes/<mailboxId>/transactional/messages`.
   *
   * One value rather than a host plus a mailbox id, because the key already
   * determines the mailbox — see `validateEndpoint` in `mail-reccado.ts` for
   * why splitting it apart can only introduce a misreported failure. It is a
   * secret rather than a var because it carries the provider host and
   * `apps/dashboard/wrangler.jsonc` is in a public repo.
   */
  RECCADO_ENDPOINT?: string;
}
