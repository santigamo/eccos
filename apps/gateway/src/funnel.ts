import type { AccountFunnel, PauseReason } from "@eccos/gateway-contract";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long an activated `setup` account sends before it pays. */
export const ACTIVATION_WINDOW_MS = 72 * HOUR_MS;
/** A never-activated account gets its warning here and pauses at the next mark. */
export const WARNING_AFTER_MS = 12 * DAY_MS;
export const UNACTIVATED_PAUSE_MS = 14 * DAY_MS;

export type ActivationTrigger = "webhook_2xx" | "outbound_delivered";

/** The stored funnel columns of one account. `connected_at = 0` marks one that connected before the funnel. */
export interface FunnelRow {
  connected_at: number | null;
  activated_at: number | null;
  paused_reason: string | null;
  warning_due_at: number | null;
}

/** The pause a `setup` account is heading for, or null when it has no clock. */
export function pendingPause(row: FunnelRow): { at: number; reason: PauseReason } | null {
  if (!row.connected_at) return null;
  if (row.activated_at) return { at: row.activated_at + ACTIVATION_WINDOW_MS, reason: "window_ended" };
  return { at: row.connected_at + UNACTIVATED_PAUSE_MS, reason: "never_activated" };
}

/** `timed`: billing is on and the account is in `setup`, so its clock runs. */
export function funnelOf(row: FunnelRow, timed: boolean, paused: boolean): AccountFunnel {
  const pause = timed ? pendingPause(row) : null;
  return {
    connectedAt: row.connected_at || null,
    activatedAt: row.activated_at ?? null,
    pausesAt: pause?.at ?? null,
    pauseReason: pause?.reason ?? (paused ? ((row.paused_reason as PauseReason | null) ?? null) : null),
    warningDueAt: row.warning_due_at ?? null,
  };
}

export type FunnelAction = "activated" | "paid" | "paused" | "warning_due";

/** One funnel step, in the dashboard's audit-line shape (`area: "audit"`) so one query reads both. */
export function funnelEvent(
  action: FunnelAction,
  accountId: string,
  organizationId: string | null,
  resource: Record<string, string | number | null> = {},
): void {
  console.info(
    JSON.stringify({
      level: "info",
      area: "audit",
      action: `funnel_${action}`,
      actorUserId: "system",
      organizationId,
      accountId,
      resource,
      outcome: "success",
      detail: null,
    }),
  );
}
