import { blocksSends } from "@eccos/gateway-contract/billing-status";
import type { DashboardStateResult } from "../server/gateway";

/** The workspace's billing refuses sends: the reading behind the root's SendingNotice. */
export function sendsPaused(root: DashboardStateResult | undefined): boolean {
  if (!root?.ok || root.data.stage !== "ready") return false;
  const account = root.data.scope.resources.account;
  return account ? blocksSends(account.billingStatus) : false;
}
