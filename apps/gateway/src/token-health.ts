import { metaErrorCodes } from "@eccos/core/send";
import { getControlPlaneStub } from "./control-plane-stub";
import { inspectToken, type TokenHealth } from "./meta/connect-api";

export type { TokenHealth };

export const TOKEN_WARN_MS = 14 * 24 * 3600_000;
const REPORT_MEMO_MS = 3600_000;

type Cfg = Parameters<typeof inspectToken>[0];
type Env = Parameters<typeof getControlPlaneStub>[0];

/** Why a token could not be checked. */
export type Unchecked =
  | "no_app_id"
  | "no_token"
  | "token_unreadable"
  | "foreign_app"
  | "no_verdict"
  | "meta_no_answer";
export type TokenCheck = { health: TokenHealth } | { unchecked: Unchecked };

export const formatDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * What Meta says about a token. A call-level error (including a top-level 190, which can mean the
 * APP token is bad) is never a verdict on the WABA's token: only `data.is_valid` is.
 */
export async function readTokenHealth(cfg: Cfg, token: string): Promise<TokenCheck> {
  try {
    const inspection = await inspectToken(cfg, token);
    if (inspection.kind === "ok") return inspection.health ? { health: inspection.health } : { unchecked: "no_verdict" };
    if (inspection.kind === "foreign_app") return { unchecked: "foreign_app" };
    return inspection.error === null
      ? { health: { valid: false, expiresAt: null, dataAccessExpiresAt: null } }
      : { unchecked: "meta_no_answer" };
  } catch {
    return { unchecked: "meta_no_answer" };
  }
}

export function tokenProblems(health: TokenHealth | null, now: number): string[] {
  if (!health) return [];
  if (!health.valid) return ["token invalid"];
  const soon = (at: number | null): at is number => at !== null && at > 0 && at - now < TOKEN_WARN_MS;
  return [
    ...(soon(health.expiresAt) ? [`token expires ${formatDay(health.expiresAt)}`] : []),
    ...(soon(health.dataAccessExpiresAt) ? [`data access expires ${formatDay(health.dataAccessExpiresAt)}`] : []),
  ];
}

const reportedAt = new Map<string, number>();

export function forgetTokenReports(): void {
  reportedAt.clear();
}

/**
 * Meta rejected the WABA's token: alerts once, never throws. The memo spares the control plane a
 * call per 190 and is dropped unless the control plane has the rejection on record.
 */
export async function noteTokenRejected(env: Env, wabaId: string, now = Date.now()): Promise<void> {
  const last = reportedAt.get(wabaId);
  if (last !== undefined && now - last < REPORT_MEMO_MS) return;
  reportedAt.set(wabaId, now);
  try {
    const outcome = await getControlPlaneStub(env).reportRejectedToken(wabaId);
    if (outcome === "disabled" || outcome === "failed") reportedAt.delete(wabaId);
  } catch {
    reportedAt.delete(wabaId);
  }
}

/**
 * `fetch` for a WABA's Graph calls: a Graph 190 answer is reported off the request path, so every
 * call made with a config carrying it (sends, templates) watches the token without call-site code.
 */
export function watchGraph(
  env: Env,
  waitUntil: (work: Promise<unknown>) => void,
  wabaId: string,
): typeof fetch {
  return (async (input, init) => {
    const res = await fetch(input, init);
    if (res.status >= 400 && res.status < 500) {
      const body = await Promise.resolve()
        .then(() => res.clone().json())
        .catch(() => null);
      if (metaErrorCodes(body).errorCode === 190) waitUntil(noteTokenRejected(env, wabaId));
    }
    return res;
  }) as typeof fetch;
}
