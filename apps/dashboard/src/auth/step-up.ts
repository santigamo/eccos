/**
 * Step-up policy for the sensitive rows of the capability matrix (contract
 * §4/§8): the acting user has TOTP enrolled and signed in inside the window.
 *
 * Freshness is the session's creation time, the same clock Better Auth's own
 * fresh-session check reads, so signing in again is what renews it.
 */

import type { Auth } from "./auth";
import { getSessionOnce } from "./request-memo";
import { UnauthorizedError } from "./session";
import { ForbiddenError } from "./tenant";

export const STEP_UP_WINDOW_SECONDS = 60 * 15;

export type StepUpReason = "totp-required" | "reauth-required";

interface StepUpSession {
  user?: Record<string, unknown>;
  session?: { createdAt?: Date | string };
}

const MESSAGES: Record<StepUpReason, string> = {
  "totp-required": "two-factor authentication is required for this action",
  "reauth-required": "this action needs a sign-in from the last 15 minutes",
};

/** Why this session may not perform a sensitive action, or null when it may. */
export function stepUpRefusal(session: StepUpSession, now = Date.now()): StepUpReason | null {
  if (!session.user?.twoFactorEnabled) return "totp-required";
  const createdAt = new Date(session.session?.createdAt ?? Number.NaN).getTime();
  return now - createdAt < STEP_UP_WINDOW_SECONDS * 1000 ? null : "reauth-required";
}

export function stepUpMessage(reason: StepUpReason): string {
  return MESSAGES[reason];
}

export async function requireStepUp(auth: Auth, headers: Headers): Promise<void> {
  const session = await getSessionOnce(auth, headers);
  if (!session?.session || !session.user) throw new UnauthorizedError();
  const refusal = stepUpRefusal(session);
  if (refusal) throw new ForbiddenError(stepUpMessage(refusal), refusal);
}
