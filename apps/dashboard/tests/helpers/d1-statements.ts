import type { Database } from "bun:sqlite";

/**
 * Gives a bun:sqlite database the one D1 statement shape `attemptLimiter` uses
 * (`prepare(sql).bind(...).first()`), so an auth instance built through
 * `authConfigFromEnv` can create invitations in tests. Kysely keeps using the
 * bun statement underneath.
 */
export function withD1Statements(db: Database): Database {
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    return Object.assign(statement, {
      bind: (...params: Array<string | number>) => ({ first: async () => statement.get(...params) ?? null }),
    });
  }) as typeof db.prepare;
  return db;
}
