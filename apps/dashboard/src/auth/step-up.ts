/**
 * Step-up policy for the sensitive rows of the capability matrix (contract
 * §4/§8): the acting user has TOTP enrolled and proved the second factor
 * inside the window.
 *
 * Freshness is `session.stepUpAt`, stamped only when a session is minted by a
 * second-factor verification (`step-up-guard.ts`). It is never the session's
 * age: Better Auth mints sessions on password-only endpoints too.
 */

import type { Auth } from "./auth";
import type { GatewayAction } from "./permissions";
import { getSessionOnce } from "./request-memo";
import { UnauthorizedError } from "./session";
import { ForbiddenError } from "./tenant";

export const STEP_UP_WINDOW_SECONDS = 60 * 15;

/**
 * The step-up rows of the capability matrix, each with the role action it
 * also needs. A server function names its row; nothing else decides step-up.
 */
export const STEP_UP_ROWS = {
  connect: "administer",
  "api-keys": "administer",
  "conversation-retention": "administer",
  members: "administer",
  "subscriber-config": "configure",
  resubscribe: "configure",
} as const satisfies Record<string, GatewayAction>;

export type StepUpRow = keyof typeof STEP_UP_ROWS;

/** What a server function asks for: a plain role action, or a step-up row. */
export type Grant = GatewayAction | StepUpRow;

export function isStepUpRow(grant: Grant): grant is StepUpRow {
  return Object.hasOwn(STEP_UP_ROWS, grant);
}

export type StepUpReason = "totp-required" | "reauth-required";

interface StepUpSession {
  user?: Record<string, unknown>;
  session?: Record<string, unknown>;
}

const MESSAGES: Record<StepUpReason, string> = {
  "totp-required": "two-factor authentication is required for this action",
  "reauth-required": "this action needs your two-factor code from the last 15 minutes",
};

/** Why this session may not perform a sensitive action, or null when it may. */
export function stepUpRefusal(session: StepUpSession, now = Date.now()): StepUpReason | null {
  if (!session.user?.twoFactorEnabled) return "totp-required";
  const stamp = session.session?.stepUpAt;
  const verifiedAt =
    stamp instanceof Date || typeof stamp === "string" || typeof stamp === "number"
      ? new Date(stamp).getTime()
      : Number.NaN;
  return now - verifiedAt < STEP_UP_WINDOW_SECONDS * 1000 ? null : "reauth-required";
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
