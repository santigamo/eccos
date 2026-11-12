/**
 * The step-up challenge: prove the second factor on the CURRENT session.
 *
 * A right code stamps `stepUpAt` on that same session row. Nothing is minted:
 * the cookie, the active organization and every other session stay as they
 * were, and a trusted-device cookie plays no part.
 *
 * Wrong codes are counted per user in the auth database's rate-limit table,
 * so the limit holds across isolates and across the caller's addresses.
 */

import type { Auth } from "./auth";
import { getSessionOnce } from "./request-memo";

export const STEP_UP_MAX_ATTEMPTS = 5;
export const STEP_UP_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export type ConfirmStepUpResult =
  | { ok: true }
  | { ok: false; code: "invalid" | "locked" | "signed-out" };

interface AttemptRow {
  id: string;
  count: number;
  lastRequest: number;
}

export async function confirmStepUp(
  auth: Auth,
  headers: Headers,
  input: { code: string; backup?: boolean },
  now = Date.now(),
): Promise<ConfirmStepUpResult> {
  const session = await getSessionOnce(auth, headers);
  const userId = session?.user?.id;
  const token = session?.session?.token;
  if (!userId || !token) return { ok: false, code: "signed-out" };

  const { adapter, internalAdapter } = await auth.$context;
  const key = `step-up|${userId}`;
  const where = [{ field: "key", value: key }];
  const row = await adapter.findOne<AttemptRow>({ model: "rateLimit", where });
  const failures = row && now - Number(row.lastRequest) < STEP_UP_ATTEMPT_WINDOW_MS ? row.count : 0;
  if (failures >= STEP_UP_MAX_ATTEMPTS) return { ok: false, code: "locked" };

  try {
    // Server-side calls: over HTTP these are refused for an enrolled session.
    if (input.backup) await auth.api.verifyBackupCode({ body: { code: input.code }, headers });
    else await auth.api.verifyTOTP({ body: { code: input.code }, headers });
  } catch {
    const update = { count: failures + 1, lastRequest: now };
    if (row) await adapter.update({ model: "rateLimit", where, update });
    else await adapter.create({ model: "rateLimit", data: { key, ...update } });
    return { ok: false, code: "invalid" };
  }

  if (row) await adapter.delete({ model: "rateLimit", where });
  await internalAdapter.updateSession(token, { stepUpAt: new Date(now) });
  return { ok: true };
}
