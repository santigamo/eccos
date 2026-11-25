import type { AccountFunnel, PauseReason } from "@eccos/gateway-contract";
import type { FunnelMailApi, FunnelMailKind } from "@eccos/gateway-contract/funnel-mail";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long an activated `setup` account sends before it pays. */
export const ACTIVATION_WINDOW_MS = 72 * HOUR_MS;
/** A never-activated account gets its warning here and pauses at the next mark. */
export const WARNING_AFTER_MS = 12 * DAY_MS;
export const UNACTIVATED_PAUSE_MS = 14 * DAY_MS;
/** The "24h left" email goes out this long after activation. */
export const WINDOW_ENDING_AFTER_MS = 48 * HOUR_MS;

export type ActivationTrigger = "webhook_2xx" | "outbound_delivered";

/**
 * The stored funnel columns of one account. `connected_at = 0` marks one that connected before the funnel.
 * `early_access_ends_at`: an operator-scheduled pause for such an account (`setEarlyAccessEnd`).
 */
export interface FunnelRow {
  connected_at: number | null;
  activated_at: number | null;
  paused_reason: string | null;
  warning_due_at: number | null;
  early_access_ends_at: number | null;
}

export const FUNNEL_COLUMNS = "connected_at, activated_at, paused_reason, warning_due_at, early_access_ends_at";

type TimerReason = Exclude<PauseReason, "early_access_ended">;

/** The pause a `setup` account is heading for, or null when it has no clock. */
export function pendingPause(row: FunnelRow): { at: number; reason: TimerReason } | null {
  if (!row.connected_at) return null;
  if (row.activated_at) return { at: row.activated_at + ACTIVATION_WINDOW_MS, reason: "window_ended" };
  return { at: row.connected_at + UNACTIVATED_PAUSE_MS, reason: "never_activated" };
}

/**
 * `timed`: billing is on and the account is in `setup`, so its clock runs.
 * `endsEarlyAccess`: billing is on and the account has neither paid nor been paused, so a scheduled end applies.
 */
export function funnelOf(row: FunnelRow, timed: boolean, paused: boolean, endsEarlyAccess: boolean): AccountFunnel {
  const early = endsEarlyAccess && row.early_access_ends_at
    ? { at: Number(row.early_access_ends_at), reason: "early_access_ended" as const }
    : null;
  const pause = (timed ? pendingPause(row) : null) ?? early;
  return {
    connectedAt: row.connected_at || null,
    activatedAt: row.activated_at ?? null,
    pausesAt: pause?.at ?? null,
    pauseReason: pause?.reason ?? (paused ? ((row.paused_reason as PauseReason | null) ?? null) : null),
    warningDueAt: row.warning_due_at ?? null,
  };
}

export type FunnelAction = "activated" | "paid" | "paused" | "warning_due" | "early_access_scheduled";

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

/**
 * The funnel-email outbox: one row per account and kind, queued with the state change it
 * announces and marked sent once the console acknowledges it. An unsent row is retried by
 * every cron tick; a sent one never again. `sent_at = 0`: dropped unsent, too old to be true.
 */
export const FUNNEL_MAIL_SCHEMA = `CREATE TABLE IF NOT EXISTS funnel_mail (
  account_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  input      TEXT NOT NULL,
  queued_at  INTEGER NOT NULL,
  sent_at    INTEGER,
  PRIMARY KEY (account_id, kind)
);`;

/**
 * How long a queued email stays worth sending. `activated` and `window_ending` name an hour
 * that is a day away at most; the warning is moot once the day-14 pause comes, two days on.
 */
export const FUNNEL_MAIL_MAX_AGE_MS: Record<FunnelMailKind, number> = {
  activated: DAY_MS,
  window_ending: DAY_MS,
  never_activated_warning: 2 * DAY_MS,
  paused: 3 * DAY_MS,
};

/** The console's `FUNNEL_MAIL` binding (Eccos Cloud only); absent on self-host and in tests, so no email. */
export function funnelMailer(env: Env): FunnelMailApi | null {
  return (env as unknown as { FUNNEL_MAIL?: FunnelMailApi }).FUNNEL_MAIL ?? null;
}
