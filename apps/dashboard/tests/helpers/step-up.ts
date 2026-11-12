import type { Database } from "bun:sqlite";

/**
 * Marks a signed-in user as TOTP-enrolled, so their fresh session passes the
 * step-up policy. Call it AFTER sign-in: an enrolled user's password sign-in
 * stops at the code challenge and sets no session cookie.
 */
export function enrollTotp(db: Database, email: string): void {
  db.query('UPDATE user SET "twoFactorEnabled" = 1 WHERE email = ?').run(email);
}
