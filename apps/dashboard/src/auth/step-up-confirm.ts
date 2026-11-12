/**
 * The step-up challenge: prove the second factor on the CURRENT session.
 *
 * A right code stamps `stepUpAt` on that same session row. Nothing is minted:
 * the cookie, the active organization and every other session stay as they
 * were, and a trusted-device cookie plays no part.
 *
 * Attempts spend Better Auth's own account lockout on the `twoFactor` row
 * (`failedVerificationCount` / `lockedUntil`), so sign-in and step-up share
 * one budget. Each attempt is RESERVED before its code is checked, with one
 * conditional atomic increment: a parallel burst cannot verify more codes
 * than the budget has left. A right code clears the count. The limit applies
 * whether or not the plugin's lockout is switched on.
 */

import type { Auth } from "./auth";
import { getSessionOnce } from "./request-memo";

export type ConfirmStepUpResult =
  | { ok: true }
  | { ok: false; code: "invalid" | "not-enrolled" | "signed-out" }
  /** `minutes`: how long until the budget is back, for the operator's message. */
  | { ok: false; code: "locked"; minutes: number };

/** Better Auth's own defaults (`resolveAccountLockoutConfig`), for options left unset. */
const DEFAULT_MAX_FAILED_ATTEMPTS = 10;
const DEFAULT_LOCK_SECONDS = 900;

interface TwoFactorRow {
  id: string;
  verified?: boolean | null;
  lockedUntil?: Date | string | null;
}

/** The codes Better Auth answers a wrong guess with. Nothing else is a guess. */
const WRONG_CODE = new Set(["INVALID_CODE", "INVALID_BACKUP_CODE"]);

/**
 * Throws on anything that is not a verdict on the code (a database or crypto
 * failure): the caller reports it and asks the operator to retry, and no
 * attempt is spent.
 */
export async function confirmStepUp(
  auth: Auth,
  headers: Headers,
  input: { code: string; backup?: boolean },
): Promise<ConfirmStepUpResult> {
  const session = await getSessionOnce(auth, headers);
  const user = session?.user;
  const token = session?.session?.token;
  if (!user?.id || !token) return { ok: false, code: "signed-out" };

  const { adapter, internalAdapter, getPlugin } = await auth.$context;
  const byUser = [{ field: "userId", value: user.id }];
  const factor = await adapter.findOne<TwoFactorRow>({ model: "twoFactor", where: byUser });
  // A pending enrollment is not a factor, and verifying a code against one
  // would run Better Auth's enrollment branch, which replaces the session.
  if (!user.twoFactorEnabled || !factor || factor.verified === false) {
    return { ok: false, code: "not-enrolled" };
  }
  const byId = [{ field: "id", value: factor.id }];
  // The limits are the two-factor plugin's own, so sign-in and step-up agree.
  // Its `enabled` switch is NOT honoured here: with the lockout off, sign-in
  // still has its per-challenge cap, but an existing session would have no
  // limit at all, so step-up always counts.
  const lockout = (getPlugin("two-factor")?.options as
    | { accountLockout?: { maxFailedAttempts?: number; durationSeconds?: number } }
    | undefined)?.accountLockout;
  const maxFailedAttempts = lockout?.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS;
  const lockMs = (lockout?.durationSeconds ?? DEFAULT_LOCK_SECONDS) * 1000;
  const locked = (until: number): ConfirmStepUpResult => ({
    ok: false,
    code: "locked",
    minutes: Math.max(1, Math.ceil((until - Date.now()) / 60_000)),
  });
  const lock = () =>
    adapter.incrementOne({
      model: "twoFactor",
      where: [...byId, { field: "failedVerificationCount", operator: "gte", value: maxFailedAttempts }],
      increment: {},
      set: { lockedUntil: new Date(Date.now() + lockMs) },
    });

  if (factor.lockedUntil) {
    const until = new Date(factor.lockedUntil).getTime();
    if (until > Date.now()) return locked(until);
    // An expired lock is cleared before the next attempt is reserved.
    await adapter.incrementOne({
      model: "twoFactor",
      where: [...byId, { field: "lockedUntil", operator: "lte", value: new Date() }],
      increment: {},
      set: { failedVerificationCount: 0, lockedUntil: null },
    });
  }
  // The reservation: it only lands while budget is left, and a row with no
  // counter at all fails closed rather than verifying unlimited codes.
  const slot = await adapter.incrementOne<{ failedVerificationCount?: number }>({
    model: "twoFactor",
    where: [...byId, { field: "failedVerificationCount", operator: "lt", value: maxFailedAttempts }],
    increment: { failedVerificationCount: 1 },
  });
  if (!slot) {
    // Spent. Make sure the lock stands, so the budget comes back on its own.
    await lock();
    return locked(Date.now() + lockMs);
  }

  try {
    // Server-side calls: over HTTP these are refused for an enrolled session.
    if (input.backup) await auth.api.verifyBackupCode({ body: { code: input.code }, headers });
    else await auth.api.verifyTOTP({ body: { code: input.code }, headers });
  } catch (error) {
    const code = (error as { body?: { code?: unknown } } | null)?.body?.code;
    if (typeof code !== "string" || !WRONG_CODE.has(code)) {
      // Not a verdict on the code: hand the reservation back. Never below
      // zero, which is also what makes this a no-op after a concurrent right
      // code has already reset the count.
      await adapter.incrementOne({
        model: "twoFactor",
        where: [...byId, { field: "failedVerificationCount", operator: "gt", value: 0 }],
        increment: { failedVerificationCount: -1 },
      });
      throw error;
    }
    if ((slot.failedVerificationCount ?? maxFailedAttempts) >= maxFailedAttempts) await lock();
    return { ok: false, code: "invalid" };
  }

  await adapter.update({
    model: "twoFactor",
    where: byId,
    update: { failedVerificationCount: 0, lockedUntil: null },
  });
  await internalAdapter.updateSession(token, { stepUpAt: new Date() });
  return { ok: true };
}
