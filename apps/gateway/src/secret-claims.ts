import { sha256Hex, toBase64Url } from "./encoding";

/**
 * One-time claims on a secret that does not exist yet: an API key, or a WABA's
 * subscriber signing secret. A claim stores only what to mint and for whom;
 * the secret is made in the call that spends it, so an unclaimed claim leaves
 * nothing live.
 *
 * The token is `<selector>.<secret>`, as for connection links; only the
 * selector and the secret's hash are stored, and the secret is compared in
 * constant time.
 */

export const SECRET_CLAIM_TTL_MS = 10 * 60 * 1000;
/** Rows that stopped mattering this long ago are dropped when a claim is made. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{43})$/;

export const SECRET_CLAIMS_SCHEMA = `CREATE TABLE IF NOT EXISTS secret_claims (
  selector        TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  hash            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  label           TEXT,
  waba_id         TEXT,
  creator_user_id TEXT NOT NULL,
  client_id       TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  redeemed_at     INTEGER,
  key_id          TEXT
);
CREATE INDEX IF NOT EXISTS idx_secret_claims_account ON secret_claims (account_id, created_at);`;

export type SecretClaimRow = Record<string, unknown>;

export interface SecretClaimIntent {
  kind: "api_key" | "subscriber_secret";
  label: string | null;
  wabaId: string | null;
  creatorUserId: string;
  clientId: string;
}

/** Stores the claim's intent and returns its token, which exists only in the answer. */
export async function createSecretClaim(
  sql: SqlStorage,
  accountId: string,
  intent: SecretClaimIntent,
  now = Date.now(),
): Promise<{ claimId: string; token: string; expiresAt: number }> {
  const selector = toBase64Url(crypto.getRandomValues(new Uint8Array(8)));
  const secret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(secret);
  const expiresAt = now + SECRET_CLAIM_TTL_MS;
  sql.exec("DELETE FROM secret_claims WHERE account_id = ? AND expires_at < ?", accountId, now - KEEP_MS);
  sql.exec(
    `INSERT INTO secret_claims
       (selector, account_id, hash, kind, label, waba_id, creator_user_id, client_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    selector,
    accountId,
    hash,
    intent.kind,
    intent.label,
    intent.wabaId,
    intent.creatorUserId,
    intent.clientId,
    now,
    expiresAt,
  );
  return { claimId: selector, token: `${selector}.${secret}`, expiresAt };
}

/** The row a token opens, whatever its state, or null. Unknown and malformed tokens look the same. */
export async function findSecretClaim(sql: SqlStorage, token: string): Promise<SecretClaimRow | null> {
  const match = TOKEN_PATTERN.exec(typeof token === "string" ? token : "");
  if (!match) return null;
  const [, selector, secret] = match;
  const encoder = new TextEncoder();
  const given = encoder.encode(await sha256Hex(secret as string));
  const row = sql.exec("SELECT * FROM secret_claims WHERE selector = ?", selector).toArray()[0];
  if (!row) return null;
  const stored = encoder.encode(row.hash as string);
  if (stored.byteLength !== given.byteLength || !crypto.subtle.timingSafeEqual(stored, given)) return null;
  return row;
}

export function isPendingSecretClaim(row: SecretClaimRow, now = Date.now()): boolean {
  return row.redeemed_at === null && (row.expires_at as number) > now;
}

/** The account's unspent, unexpired claims, newest first. */
export function pendingSecretClaims(sql: SqlStorage, accountId: string, now = Date.now()): SecretClaimRow[] {
  return sql
    .exec(
      `SELECT * FROM secret_claims WHERE account_id = ? AND redeemed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC, rowid DESC`,
      accountId,
      now,
    )
    .toArray();
}

/** Spends a pending claim. Null when it was already spent or has expired: only one caller ever gets the row. */
export function spendSecretClaim(
  sql: SqlStorage,
  selector: string,
  keyId: string | null,
  now = Date.now(),
): SecretClaimRow | null {
  return (
    sql
      .exec(
        `UPDATE secret_claims SET redeemed_at = ?, key_id = ?
         WHERE selector = ? AND redeemed_at IS NULL AND expires_at > ? RETURNING *`,
        now,
        keyId,
        selector,
        now,
      )
      .toArray()[0] ?? null
  );
}
