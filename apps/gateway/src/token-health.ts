import { GRAPH_CODE_OAUTH, metaErrorCodes } from "@eccos/core/send";
import { getControlPlaneStub } from "./control-plane-stub";
import type { TokenHealth } from "./meta/connect-api";

export type { TokenHealth };

const REPORT_MEMO_MS = 3600_000;

type Env = Parameters<typeof getControlPlaneStub>[0];

export async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
