import type { ConnectFailureCode } from "@eccos/gateway-contract";
import type { EmbeddedSignupConfig, SessionEvent } from "../embedded-signup";

/** Where the landing page lives, and the API only it calls. */
export const CONNECT_LINK_PATH = "/connect";
export const CONNECT_LINK_API = "/api/connect-link/";

export type LinkView =
  | { status: "ready"; workspace: string; inviter: string; closed: boolean; signup: EmbeddedSignupConfig | null }
  | { status: "gone"; inviter: string | null };

export type LinkStart = { ok: true; state: string } | { ok: false; code: "gone" | "subscription_required" | "failed" };

export type LinkOutcome =
  | { outcome: "connected"; phone: string | null }
  /** Registered, but the number is missing or its setup failed: the workspace admin finishes it. */
  | { outcome: "pending" }
  | { outcome: ConnectFailureCode | "gone" };

/** The answer, or why there is none. The token only ever travels in a POST body. */
async function post<T>(action: string, body: Record<string, unknown>): Promise<T | "limited" | "unreachable"> {
  try {
    const response = await fetch(`${CONNECT_LINK_API}${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 429) return "limited";
    if (!response.ok) return "unreachable";
    return (await response.json()) as T;
  } catch {
    return "unreachable";
  }
}

export const connectLinkApi = {
  view: (token: string) => post<LinkView>("view", { token }),
  start: (token: string) => post<LinkStart>("start", { token }),
  exchange: (token: string, code: string, state: string) => post<LinkOutcome>("exchange", { token, code, state }),
  event: (token: string, event: SessionEvent) => void post<unknown>("event", { token, event }),
};
