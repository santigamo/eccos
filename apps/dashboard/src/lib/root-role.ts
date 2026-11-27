import type { DashboardStateResult, RoleFlag } from "../server/gateway";

/** The role half of the root state, or null before an account exists or when the read failed. */
export function rootRole(root: DashboardStateResult | undefined): (RoleFlag & { billing: boolean }) | null {
  if (!root?.ok || !("canAdminister" in root.data)) return null;
  const { canAdminister, canOperate, role, billing } = root.data;
  return { canAdminister, canOperate, role, billing: billing !== undefined };
}
