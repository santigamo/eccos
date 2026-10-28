/**
 * How long a loaded route is served as-is on revisit and preload. Past it the
 * page still paints from what it has and re-reads behind it. Refresh, Live and
 * mutations invalidate regardless; the root sets its own 30s window in
 * __root and reloads on scope change, targeted invalidation and refocus.
 */

/** Lists that move on their own: a deliberate re-read is cheap and the data is perishable. */
export const LIVE_STALE_MS = 5_000;

/** Settings that change only when the operator changes them. */
export const CONFIG_STALE_MS = 30_000;
