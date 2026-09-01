/**
 * Shared public auth-page primitives (eccos-b5j, eccos-4gh).
 *
 * The four public auth routes (signin, signup, forgot-password, reset-password)
 * plus the invitation screen render the same card skeleton and the same error
 * banner; this module owns both so the pages cannot drift. It also hosts the
 * pure helpers shared by route tests: redirect-target validation and the
 * auth-error -> user-facing-message mapping.
 */

import type { ReactNode } from "react";
import {
  MAIL_SUPPRESSED_CODE,
  MAIL_UNDELIVERABLE_CODE,
  undeliverableMessage,
} from "@/auth/mail";
import {
  Frame,
  FramePanel,
} from "../reui/frame";
import { Page } from "../../ui";

/**
 * Validate a post-signin redirect target coming from the ?redirect= search
 * param. Accepts only same-origin absolute paths; rejects protocol-relative
 * URLs ("//host"), backslash variants ("\\host" and "/\\host"), and control
 * characters — all open-redirect vectors. Returns undefined for anything that
 * is not a safe path, so callers fall back to "/".
 */
export function safeRedirectTarget(value: string | undefined): string | undefined {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return undefined;
  if (value.includes("\\")) return undefined;
  // Same set the old character class matched (the C0 controls U+0000-U+001F
  // plus DEL U+007F), scanned by code unit instead of by regex: a pattern
  // whose whole purpose is to *match* control characters is exactly what
  // Biome's noControlCharactersInRegex forbids, and the scan states the intent
  // without fighting the rule. Surrogates (U+D800-U+DFFF) fall outside the
  // range, so comparing UTF-16 code units cannot produce a false reject.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return value;
}

/** Error codes Better Auth surfaces for account-existence-sensitive flows. */
export type AuthErrorCode =
  | "EMAIL_NOT_VERIFIED"
  | "USER_ALREADY_EXISTS"
  | "INVALID_EMAIL_OR_PASSWORD"
  | (string & {});

/**
 * Map a Better Auth client error to the user-facing message. Anti-enumeration
 * rules (contract §7/§8):
 * - `USER_ALREADY_EXISTS` must NOT confirm existence: callers route it to the
 *   generic "check your inbox" success state instead of rendering this message.
 * - `EMAIL_NOT_VERIFIED` is the user's own sign-in attempt; the verification
 *   notice is allowed because the address was typed into a session attempt.
 * - Anything unknown falls back to the caller-supplied default, never the raw
 *   server text.
 */
export function authErrorMessage(
  error: { status?: number; code?: string; message?: string } | null | undefined,
  fallback: string,
): string {
  if (!error) return fallback;
  switch (error.code) {
    case "EMAIL_NOT_VERIFIED":
      return "Verify your email address first, then sign in again.";
    default:
      return error.message && error.message.length < 200
        ? error.message
        : fallback;
  }
}

/**
 * Map a mail-undeliverable failure to its user-facing message, or null when the
 * error is something else (eccos-3ne).
 *
 * Keyed on the STABLE CODE the adapter attaches, never on error text, and the
 * wording comes from `undeliverableMessage` so the console and the server agree
 * on one sentence. Suppression gets its own message: retyping a blocked address
 * cannot fix it, so the typo advice would send the reader in a circle.
 *
 * Only sign-up and invitation are allowed to render this. The password-reset
 * flow must NOT: it only runs for accounts that exist, so any difference there
 * is a membership oracle (see applyResetSendPolicy in src/auth/auth.ts).
 */
export function mailUndeliverableMessage(
  error: { code?: string; message?: string } | null | undefined,
): string | null {
  if (!error) return null;
  if (error.code === MAIL_SUPPRESSED_CODE) {
    return undeliverableMessage("recipient_suppressed");
  }
  if (error.code === MAIL_UNDELIVERABLE_CODE) {
    return undeliverableMessage("permanent_failure");
  }
  return null;
}

/** True when the error means the signup address is already registered. */
export function isDuplicateEmailError(
  error: { status?: number; code?: string } | null | undefined,
): boolean {
  return error?.code === "USER_ALREADY_EXISTS" || error?.status === 422;
}

/**
 * ?error= carries only a bounded generic message, never raw server text that
 * could confirm whether an address exists.
 */
export function redactError(value: string): string | undefined {
  return value && value.length < 200 ? value : undefined;
}

/** Classes of the shared auth error banner (red = meaningful failure only). */
export const AUTH_ERROR_BANNER_CLASS =
  "border-l-2 border-[#e03131] bg-[rgba(224,49,49,.12)] px-3 py-2 text-sm text-[#ff7777]";

/**
 * What the check-your-inbox screen says after a "Resend" attempt (eccos-hk5).
 *
 * - `sent` — the endpoint answered; assume it did its job.
 * - `limited` — the resend rate limit tripped. A person who did not get the
 *   mail will hit this legitimately, so it is a wait, not a failure.
 * - `unreachable` — the request never got an answer at all.
 */
export type ResendOutcomeKind = "sent" | "limited" | "unreachable";

export interface ResendOutcome {
  kind: ResendOutcomeKind;
  message: string;
}

/**
 * Map a POST /send-verification-email attempt to what the screen says. Takes
 * the HTTP status the endpoint answered with, or `null` when the request never
 * reached a verdict (transport failure — no response to read).
 *
 * Anti-enumeration (contract §7/§8): every answered status other than 429
 * takes the SAME "sent" path. Better Auth already returns 200 for an unknown
 * or already-verified address behind a constant-time floor, so the only way
 * this endpoint can answer with a 4xx/5xx is a delivery error for an address
 * that really exists and really is unverified — surfacing that would turn the
 * screen into an existence oracle. A 429 leaks nothing: the bucket keys on the
 * caller's IP and the path, so it says something about the caller's own
 * clicking, never about the address they typed.
 */
export function resendVerificationOutcome(status: number | null): ResendOutcome {
  if (status === null) {
    return {
      kind: "unreachable",
      message: "Could not reach Eccos. Check your connection and try again.",
    };
  }
  if (status === 429) {
    return {
      kind: "limited",
      message:
        "You have asked for this a few times. Wait a few minutes, then try again — the earlier links still work.",
    };
  }
  return {
    kind: "sent",
    message: "Verification email sent again. It can take a minute to arrive.",
  };
}

/**
 * The resend note, rendered as a live region that stays mounted while empty:
 * an element that appears is not reliably announced, an empty one that fills up
 * is (same construction as the console's ConnectOutcome).
 *
 * Only `unreachable` earns a red rail. `limited` is the console's degraded ink
 * — the action did not happen and the screen has to say so, but a limit an
 * ordinary person trips is not an error state dressed in red
 * (docs/DASHBOARD-DESIGN.md, data rule 1). `sent` stays quiet and muted: a
 * confirmation is not state.
 *
 * Each tone carries its own top margin rather than leaning on a parent `gap`,
 * so the empty live region takes no vertical space at all: staying mounted must
 * not cost a stray gap on the screen's resting state.
 */
export function ResendNote({ outcome }: { outcome: ResendOutcome | null }) {
  const tone =
    outcome === null
      ? undefined
      : outcome.kind === "sent"
        ? "text-muted-foreground mt-4 block text-xs"
        : outcome.kind === "limited"
          ? "mt-4 block border-l-2 border-l-[#f0a020] px-3 py-2 text-sm text-foreground"
          : "mt-4 block border-l-2 border-l-[#e03131] px-3 py-2 text-sm text-foreground";
  return (
    <output className={tone} aria-live="polite" aria-atomic="true">
      {outcome?.message}
    </output>
  );
}

/**
 * The address a link was just sent to (or that the reader just typed), lifted
 * out of the sentence and rendered as a datum.
 *
 * WHY IT LEAVES THE PROSE: this is the one string on a check-your-inbox screen
 * that has to be read character by character. A typo in it is the single most
 * common reason the mail never arrives and the only failure the reader can fix
 * themselves — and buried mid-paragraph in the body face it reads as prose and
 * gets skimmed. Under a functional label it reads as a value to be checked.
 *
 * WHY THE PIXEL FACE: docs/DASHBOARD-DESIGN.md reserves Geist Pixel for brand
 * accents — "low frequency, high meaning" — and the facts-strip stat numbers
 * are the standing precedent for a *datum* in it. This is that category: one
 * value, seen once, that must be read exactly, on a screen the operator sees
 * at most twice in their life. The face's fixed grid is also what separates
 * `rn` from `m` and `l` from `1`. `text-sm` (14px) clears the 12px pixel floor.
 * The label stays in the console's functional register (Inter uppercase 11px),
 * so the accent is spent on the value alone.
 *
 * The label is a prop because the two callers make different claims: sign-up
 * knows the message went to that address, while the password-reset screen must
 * not say so — its whole posture is that it will not confirm the address
 * exists (contract §8). It reads back what was typed, and says only that.
 */
export function AddressReadback({
  label,
  email,
}: {
  label: string;
  email: string;
}) {
  return (
    <div className="border-t border-(--line) pt-3">
      <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </p>
      {/* An address is one long token with no spaces to break on;
          `wrap-anywhere` keeps a long one inside the column instead of
          widening the card past its max-width. */}
      <p className="font-pixel mt-1.5 text-sm text-foreground wrap-anywhere">
        {email}
      </p>
    </div>
  );
}

export interface AuthCardProps {
  /** Page title (h1) rendered by the shared Page header. */
  title: string;
  /** Kicker line above the title; "Eccos" for auth, custom for invitations. */
  kicker?: string;
  children: ReactNode;
}

/**
 * Shared shell for every unauthenticated page: main#main-content landmark,
 * Page header, and the centered max-w-md frame panel the forms render into.
 */
export function AuthCard({ title, kicker = "Eccos", children }: AuthCardProps) {
  return (
    <main id="main-content" className="min-h-svh px-4 py-6 md:px-8 md:py-8">
      <Page title={title} kicker={kicker}>
        <div className="mx-auto flex max-w-md flex-col gap-4">
          <Frame variant="default" spacing="lg">
            <FramePanel fit>{children}</FramePanel>
          </Frame>
        </div>
      </Page>
    </main>
  );
}
