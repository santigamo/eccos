import { metaErrorCodes, sendMessage, type SendResult } from "@eccos/core/send";
import { getControlPlaneStub } from "./control-plane-stub";
import { inspectToken, type TokenHealth } from "./meta/connect-api";

export type { TokenHealth };

export const TOKEN_WARN_MS = 14 * 24 * 3600_000;
const REPORT_MEMO_MS = 3600_000;

type Cfg = Parameters<typeof inspectToken>[0];
type Env = Parameters<typeof getControlPlaneStub>[0];

/** Why a token could not be checked; `meta_no_answer` is the only one that blames Meta. */
export type Unchecked = "no_app_id" | "no_token" | "token_unreadable" | "meta_no_answer";
export type TokenCheck = { health: TokenHealth } | { unchecked: Unchecked };

export const formatDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * What Meta says about a token, or null when the call itself failed. A call-level error
 * (including a top-level 190, which can mean the APP token is bad) is never a verdict on the
 * WABA's token: only `data.is_valid` is.
 */
export async function readTokenHealth(cfg: Cfg, token: string): Promise<TokenHealth | null> {
  try {
    const inspection = await inspectToken(cfg, token);
    if (inspection.kind === "ok") return inspection.health;
    return inspection.kind === "invalid_token" && inspection.error === null
      ? { valid: false, expiresAt: 0, dataAccessExpiresAt: 0 }
      : null;
  } catch {
    return null;
  }
}

export function tokenProblems(health: TokenHealth | null, now: number): string[] {
  if (!health) return [];
  if (!health.valid) return ["token invalid"];
  const soon = (at: number) => at > 0 && at - now < TOKEN_WARN_MS;
  return [
    ...(soon(health.expiresAt) ? [`token expires ${formatDay(health.expiresAt)}`] : []),
    ...(soon(health.dataAccessExpiresAt) ? [`data access expires ${formatDay(health.dataAccessExpiresAt)}`] : []),
  ];
}

const reportedAt = new Map<string, number>();

export function forgetTokenReports(): void {
  reportedAt.clear();
}

/** Meta rejected the WABA's token: alerts once, never throws. The memo spares the control plane a call per 190. */
export async function noteTokenRejected(env: Env, wabaId: string, now = Date.now()): Promise<void> {
  const last = reportedAt.get(wabaId);
  if (last !== undefined && now - last < REPORT_MEMO_MS) return;
  reportedAt.set(wabaId, now);
  try {
    await getControlPlaneStub(env).reportRejectedToken(wabaId);
  } catch {
    reportedAt.delete(wabaId);
  }
}

/** `sendMessage` that also reports a Graph 190 off the request path, so every send path watches the token. */
export async function sendWatched(
  env: Env,
  waitUntil: (work: Promise<unknown>) => void,
  wabaId: string,
  cfg: Parameters<typeof sendMessage>[0],
  body: Parameters<typeof sendMessage>[1],
): Promise<SendResult> {
  const result = await sendMessage(cfg, body);
  if (!result.ok && metaErrorCodes(result.error).errorCode === 190) waitUntil(noteTokenRejected(env, wabaId));
  return result;
}
