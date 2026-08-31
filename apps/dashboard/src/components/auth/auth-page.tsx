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
