import type { Database } from "bun:sqlite";

/**
 * Makes a signed-in user pass the step-up policy: TOTP-enrolled, with their
 * sessions stamped as having just proved the second factor. Call it AFTER
 * sign-in: an enrolled user's password sign-in stops at the code challenge and
 * sets no session cookie.
 */
export function enrollTotp(db: Database, email: string): void {
  db.query('UPDATE user SET "twoFactorEnabled" = 1 WHERE email = ?').run(email);
  db.query(
    'UPDATE session SET "stepUpAt" = ? WHERE "userId" = (SELECT id FROM user WHERE email = ?)',
  ).run(new Date().toISOString(), email);
}
