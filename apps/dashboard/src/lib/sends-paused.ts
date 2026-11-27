import { blocksSends } from "@eccos/gateway-contract/billing-status";
import type { DashboardState, DashboardStateResult } from "../server/gateway";

/**
 * A workspace whose billing status blocks sends and holds forwarding, said above
 * every page. Null when there is nothing to say.
 */
export function sendingPaused(
  state: DashboardState,
): { billing: boolean; subscribed: boolean; canManage: boolean } | null {
  const resources =
    state.stage === "ready" ? state.scope.resources : state.stage === "account-ready" ? state.resources : null;
  if (!resources?.account || !blocksSends(resources.account.billingStatus) || resources.wabas.length === 0) return null;
  const billing = "billing" in state ? state.billing : undefined;
  return { billing: billing !== undefined, subscribed: billing?.subscribed === true, canManage: billing?.canManage === true };
}

/** The same reading from the root loader's result, for a page that only needs yes or no. */
export function rootSendsPaused(root: DashboardStateResult | undefined): boolean {
  return root?.ok === true && sendingPaused(root.data) !== null;
}
