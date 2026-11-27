/**
 * The HTTP export's per-WABA cooldown, kept in the WABA's own `ops_state` (one row). Claiming is
 * one synchronous read-modify-write inside the Durable Object, so two concurrent exports cannot
 * both pass.
 */
const KEY = "export_usage";

export const DEFAULT_EXPORT_COOLDOWN_SECONDS = 900;

export type ExportClaim = { ok: true } | { ok: false; retryAfter: number };

/** `EXPORT_COOLDOWN_SECONDS` in ms: unset or invalid is the default, `0` turns the cooldown off. */
export function exportCooldownMs(env: { EXPORT_COOLDOWN_SECONDS?: string }): number {
  const raw = env.EXPORT_COOLDOWN_SECONDS?.trim();
  const seconds = raw ? Number(raw) : Number.NaN;
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_EXPORT_COOLDOWN_SECONDS) * 1000;
}

/** Grants an export and starts the cooldown, or refuses it with the whole seconds left. */
export function claimExport(sql: SqlStorage, now: number, cooldownMs: number): ExportClaim {
  const value = sql.exec("SELECT value FROM ops_state WHERE key = ?", KEY).toArray()[0]?.value;
  const lastAt = typeof value === "string" ? (JSON.parse(value) as { lastAt: number }).lastAt : 0;
  const wait = lastAt + cooldownMs - now;
  if (cooldownMs > 0 && wait > 0) return { ok: false, retryAfter: Math.ceil(wait / 1000) };
  sql.exec(
    "INSERT INTO ops_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    KEY,
    JSON.stringify({ lastAt: now }),
  );
  return { ok: true };
}
