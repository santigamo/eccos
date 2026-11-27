/**
 * The HTTP export's per-WABA cooldown and its UTC-day counters, kept in the WABA's own `ops_state`
 * (one row). Claiming is one synchronous read-modify-write inside the Durable Object, so two
 * concurrent exports cannot both pass.
 */
const KEY = "export_usage";
const DAY_MS = 24 * 3600_000;

export const DEFAULT_EXPORT_COOLDOWN_SECONDS = 900;

export interface ExportDay {
  exports: number;
  blocked: number;
}
export type ExportClaim = { ok: true } | { ok: false; retryAfter: number };

interface Usage {
  lastAt: number;
  days: Record<string, ExportDay>;
}

/** `EXPORT_COOLDOWN_SECONDS` in ms: unset or invalid is the default, `0` turns the cooldown off. */
export function exportCooldownMs(env: { EXPORT_COOLDOWN_SECONDS?: string }): number {
  const raw = env.EXPORT_COOLDOWN_SECONDS?.trim();
  const seconds = raw ? Number(raw) : Number.NaN;
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_EXPORT_COOLDOWN_SECONDS) * 1000;
}

/** Grants an export and starts the cooldown, or refuses it with the whole seconds left. Counts either outcome. */
export function claimExport(sql: SqlStorage, now: number, cooldownMs: number): ExportClaim {
  const usage = readUsage(sql);
  const day = utcDay(now);
  const counts = usage.days[day] ?? { exports: 0, blocked: 0 };
  const wait = usage.lastAt + cooldownMs - now;
  const granted = cooldownMs <= 0 || wait <= 0;
  if (granted) {
    counts.exports += 1;
    usage.lastAt = now;
  } else counts.blocked += 1;
  const yesterday = utcDay(now - DAY_MS);
  const days: Record<string, ExportDay> = { [day]: counts };
  if (usage.days[yesterday]) days[yesterday] = usage.days[yesterday];
  sql.exec(
    "INSERT INTO ops_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    KEY,
    JSON.stringify({ lastAt: usage.lastAt, days }),
  );
  return granted ? { ok: true } : { ok: false, retryAfter: Math.ceil(wait / 1000) };
}

/** The counters of one UTC day (`YYYY-MM-DD`); kept for that day and the one before. */
export function exportDay(sql: SqlStorage, day: string): ExportDay {
  return readUsage(sql).days[day] ?? { exports: 0, blocked: 0 };
}

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

function readUsage(sql: SqlStorage): Usage {
  const value = sql.exec("SELECT value FROM ops_state WHERE key = ?", KEY).toArray()[0]?.value;
  return typeof value === "string" ? (JSON.parse(value) as Usage) : { lastAt: 0, days: {} };
}
