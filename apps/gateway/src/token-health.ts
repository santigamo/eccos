import { metaErrorCodes } from "@eccos/core/send";
import { getControlPlaneStub } from "./control-plane-stub";
import { debugToken } from "./meta/waba-diagnostics";

export const TOKEN_WARN_MS = 14 * 24 * 3600_000;

/** Unix ms; 0 means Meta says it never expires. */
export interface TokenHealth {
  valid: boolean;
  expiresAt: number;
  dataAccessExpiresAt: number;
}

type Cfg = Parameters<typeof debugToken>[0];

const ms = (seconds: unknown) => (typeof seconds === "number" && seconds > 0 ? seconds * 1000 : 0);

/** The token's health from the `data` of a debug_token answer, or null when it carries no verdict. */
export function healthFromDebugData(data: unknown): TokenHealth | null {
  const d = data as Record<string, unknown> | null | undefined;
  if (typeof d?.is_valid !== "boolean") return null;
  return { valid: d.is_valid, expiresAt: ms(d.expires_at), dataAccessExpiresAt: ms(d.data_access_expires_at) };
}

/**
 * What Meta says about a token, or null when the call itself failed. An error on the call
 * (including a top-level 190, which can mean the APP token is bad) is never a verdict on the
 * WABA's token: only `data.is_valid` is.
 */
export async function readTokenHealth(cfg: Cfg, token: string): Promise<TokenHealth | null> {
  try {
    const answer = await debugToken(cfg, token);
    return "value" in answer ? healthFromDebugData((answer.value as { data?: unknown }).data) : null;
  } catch {
    return null;
  }
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

export function tokenProblems(health: TokenHealth | null, now: number): string[] {
  if (!health) return [];
  if (!health.valid) return ["token invalid"];
  const soon = (at: number) => at > 0 && at - now < TOKEN_WARN_MS;
  return [
    ...(soon(health.expiresAt) ? [`token expires ${day(health.expiresAt)}`] : []),
    ...(soon(health.dataAccessExpiresAt) ? [`data access expires ${day(health.dataAccessExpiresAt)}`] : []),
  ];
}

type Env = Parameters<typeof getControlPlaneStub>[0];

/** Meta rejected the WABA's token: alerts once, never throws. Callers pass it to `waitUntil`. */
export async function noteTokenRejected(env: Env, wabaId: string): Promise<void> {
  try {
    await getControlPlaneStub(env).reportRejectedToken(wabaId);
  } catch {}
}

/** A failed send whose Graph error is 190. Callers pass it to `waitUntil`, never await it on the request path. */
export function noteSendFailure(env: Env, wabaId: string, error: unknown): Promise<void> {
  return metaErrorCodes(error).errorCode === 190 ? noteTokenRejected(env, wabaId) : Promise.resolve();
}
