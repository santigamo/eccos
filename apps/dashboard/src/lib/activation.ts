import type { DashboardState } from "../server/gateway";

/**
 * The activation seam for eccos-dbb3.2: the gateway detects the first success
 * (a 2xx forward or a delivered outbound) and starts the 72h window. It reaches
 * the console as `billing.activation` on the root state. Absent means not
 * activated, or not known yet.
 */
export interface Activation {
  /** ISO time of the first success. */
  activatedAt: string;
  /** ISO time sends pause without a subscription. */
  pausesAt: string;
  reason?: "forward" | "outbound";
}

/** The activation of a workspace still without a subscription; null once it pays, or before it activates. */
export function pendingActivation(state: DashboardState): Activation | null {
  if (state.stage !== "ready" && state.stage !== "account-ready") return null;
  const resources = state.stage === "ready" ? state.scope.resources : state.resources;
  if (resources.account?.billingStatus !== "setup") return null;
  return state.billing?.activation ?? null;
}

export const WINDOW_HOURS = 72;

/** Whole hours left in the window, never below zero; the full window when it is not known. */
export function hoursLeft(activation: Activation | null, now = Date.now()): number {
  if (!activation) return WINDOW_HOURS;
  const left = Date.parse(activation.pausesAt) - now;
  return Number.isFinite(left) ? Math.max(0, Math.ceil(left / 3_600_000)) : WINDOW_HOURS;
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
