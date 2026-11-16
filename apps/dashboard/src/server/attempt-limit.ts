/**
 * Counts failed attempts per caller in Better Auth's `rateLimit` table, so the
 * count is shared across isolates without a table or a binding of its own.
 * `lastRequest` holds the start of the caller's current window.
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 10;

export interface AttemptLimiter {
  blocked(caller: string): Promise<boolean>;
  strike(caller: string): Promise<void>;
}

type Row = { id: string; count: number; lastRequest: number };

export function attemptLimiter(db: D1Database, scope: string, now: () => number = Date.now): AttemptLimiter {
  const read = (caller: string) =>
    db
      .prepare('SELECT "id", "count", "lastRequest" FROM "rateLimit" WHERE "key" = ?')
      .bind(`${scope}|${caller}`)
      .first<Row>();
  const live = (row: Row) => now() - row.lastRequest < WINDOW_MS;
  return {
    async blocked(caller) {
      const row = await read(caller);
      return row !== null && live(row) && row.count >= MAX_FAILURES;
    },
    async strike(caller) {
      const row = await read(caller);
      if (row && live(row)) {
        await db.prepare('UPDATE "rateLimit" SET "count" = "count" + 1 WHERE "id" = ?').bind(row.id).run();
      } else if (row) {
        await db.prepare('UPDATE "rateLimit" SET "count" = 1, "lastRequest" = ? WHERE "id" = ?').bind(now(), row.id).run();
      } else {
        await db
          .prepare('INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest") VALUES (?, ?, 1, ?)')
          .bind(crypto.randomUUID(), `${scope}|${caller}`, now())
          .run();
      }
    },
  };
}
