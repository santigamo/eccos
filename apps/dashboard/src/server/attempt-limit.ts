/**
 * Counts attempts per caller in Better Auth's `rateLimit` table, so the count
 * is shared across isolates without a table or a binding of its own. The row's
 * id is the key itself, which makes each count one atomic upsert.
 * `lastRequest` holds the start of the caller's current window.
 */
export interface AttemptLimiter {
  /** Counts one attempt. True once the caller is over the limit for this window. */
  strike(caller: string): Promise<boolean>;
}

export function attemptLimiter(
  db: D1Database,
  scope: string,
  max: number,
  windowMs: number,
  now: () => number = Date.now,
): AttemptLimiter {
  return {
    async strike(caller) {
      const key = `${scope}|${caller}`;
      const at = now();
      const row = await db
        .prepare(
          `INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest") VALUES (?1, ?1, 1, ?2)
           ON CONFLICT("id") DO UPDATE SET
             "count" = CASE WHEN "lastRequest" <= ?3 THEN 1 ELSE "count" + 1 END,
             "lastRequest" = CASE WHEN "lastRequest" <= ?3 THEN ?2 ELSE "lastRequest" END
           RETURNING "count"`,
        )
        .bind(key, at, at - windowMs)
        .first<{ count: number }>();
      return (row?.count ?? 0) > max;
    },
  };
}
