import type { DashboardState } from "../server/gateway";

/**
 * The gateway's first success (a 2xx forward or a delivered outbound) and the
 * end of its 72h window, from `AccountSummary.funnel` (unix ms). It reaches the
 * console as `billing.activation` on the root state; absent means not activated.
 */
export interface Activation {
  activatedAt: number;
  pausesAt: number;
}

/** The activation of a workspace still without a subscription; null once it pays, or before it activates. */
export function pendingActivation(state: DashboardState): Activation | null {
  if (state.stage !== "ready" && state.stage !== "account-ready") return null;
  const resources = state.stage === "ready" ? state.scope.resources : state.resources;
  if (resources.account?.billingStatus !== "setup") return null;
  return state.billing?.activation ?? null;
}

export const WINDOW_MS = 72 * 3_600_000;

/** Milliseconds left in the window, never below zero; the full window when it is not known yet. */
export function windowLeft(activation: Activation | null, now = Date.now()): number {
  return activation ? Math.max(0, activation.pausesAt - now) : WINDOW_MS;
}

/** Per viewer, like the setup companion's "Hide": the paywall asks once, and the 72h strip carries on. */
export const PAYWALL_SEEN_KEY = "eccos:activation-paywall-seen";

export function paywallSeen(): boolean {
  try {
    return window.localStorage.getItem(PAYWALL_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markPaywallSeen(): void {
  try {
    window.localStorage.setItem(PAYWALL_SEEN_KEY, "1");
  } catch {
    // Blocked storage: it asks again next load.
  }
}
