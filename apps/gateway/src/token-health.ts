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

/** What Meta says about a token, or null when it did not give an answer (never read as invalid). */
export async function readTokenHealth(cfg: Cfg, token: string): Promise<TokenHealth | null> {
  try {
    const answer = await debugToken(cfg, token);
    if (!("value" in answer)) return answer.code === 190 ? { valid: false, expiresAt: 0, dataAccessExpiresAt: 0 } : null;
    const data = (answer.value as { data?: Record<string, unknown> }).data;
    if (typeof data?.is_valid !== "boolean") return null;
    return {
      valid: data.is_valid,
      expiresAt: ms(data.expires_at),
      dataAccessExpiresAt: ms(data.data_access_expires_at),
    };
  } catch {
    return null;
  }
}

export function tokenProblems(health: TokenHealth | null, now: number): string[] {
  if (!health) return [];
  if (!health.valid) return ["token invalid"];
  const soon = (at: number) => at > 0 && at - now < TOKEN_WARN_MS;
  return [
    ...(soon(health.expiresAt) ? [`token expires ${new Date(health.expiresAt).toISOString().slice(0, 10)}`] : []),
    ...(soon(health.dataAccessExpiresAt)
      ? [`data access expires ${new Date(health.dataAccessExpiresAt).toISOString().slice(0, 10)}`]
      : []),
  ];
}

/** On a failed send: Graph error 190 means Meta rejected the WABA's token. Alerts once per WABA, never throws. */
export async function noteSendFailure(env: Parameters<typeof getControlPlaneStub>[0], wabaId: string, error: unknown): Promise<void> {
  if (metaErrorCodes(error).errorCode !== 190) return;
  try {
    await getControlPlaneStub(env).reportRejectedToken(wabaId);
  } catch {}
}
