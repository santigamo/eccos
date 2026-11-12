import { GRAPH_CODE_OAUTH, metaErrorCodes } from "@eccos/core/send";
import { getControlPlaneStub } from "./control-plane-stub";
import { inspectToken, type TokenHealth } from "./meta/connect-api";

export type { TokenHealth };

export const TOKEN_WARN_MS = 14 * 24 * 3600_000;
const REPORT_MEMO_MS = 3600_000;
const DAY_MS = 24 * 3600_000;

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
/** `sealed` is the stored token the health is about, to guard writes against a reconnect meanwhile. */
export type TokenCheck = { health: TokenHealth; sealed?: string } | { unchecked: Unchecked };

export async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

/**
 * `lastCheck` labels expiries read from storage because today's check got no answer. A token
 * expiry that passed within the last day is reported once as expired (the census runs daily);
 * older ones are the invalid-token alert's business, and past data access is ignored.
 */
export function tokenProblems(health: TokenHealth | null, now: number, lastCheck = false): string[] {
  if (!health) return [];
  if (!health.valid) return ["token invalid"];
  const soon = (at: number | null): at is number => at !== null && at > now && at - now < TOKEN_WARN_MS;
  const when = lastCheck ? "expiry from last check: " : "expires ";
  const { expiresAt } = health;
  const expired = expiresAt !== null && expiresAt > 0 && expiresAt <= now && now - expiresAt < DAY_MS;
  return [
    ...(expired ? [`token expired ${formatDay(expiresAt)}`] : []),
    ...(soon(expiresAt) ? [`token ${when}${formatDay(expiresAt)}`] : []),
    ...(soon(health.dataAccessExpiresAt) ? [`data access ${when}${formatDay(health.dataAccessExpiresAt)}`] : []),
  ];
}

const reportedAt = new Map<string, number>();

export function forgetTokenReports(): void {
  reportedAt.clear();
}

/**
 * Meta rejected `fingerprint`'s token for the WABA: alerts once, never throws. The control plane
 * ignores it if the WABA holds another token by now. The memo spares it a call per 190.
 */
export async function noteTokenRejected(env: Env, wabaId: string, fingerprint: string, now = Date.now()): Promise<void> {
  const key = `${wabaId}:${fingerprint}`;
  const last = reportedAt.get(key);
  if (last !== undefined && now - last < REPORT_MEMO_MS) return;
  reportedAt.set(key, now);
  try {
    await getControlPlaneStub(env).reportRejectedToken(wabaId, fingerprint);
  } catch {
    reportedAt.delete(key);
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
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
      if (token && metaErrorCodes(body).errorCode === GRAPH_CODE_OAUTH) {
        waitUntil(tokenFingerprint(token).then((fingerprint) => noteTokenRejected(env, wabaId, fingerprint)));
      }
    }
    return res;
  }) as typeof fetch;
}
