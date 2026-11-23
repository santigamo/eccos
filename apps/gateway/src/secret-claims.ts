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
 *
 * A subscriber claim records the WABA's secret revision when it is made, so a
 * secret written after it makes it stale. A newer subscriber claim for the
 * same WABA cancels the older one.
 */

export const SECRET_CLAIM_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_SECRET_CLAIMS = 20;
/** Rows that stopped mattering this long ago are dropped when a claim is made. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{43})$/;
const PENDING = "redeemed_at IS NULL AND cancelled_at IS NULL AND expires_at > ?";

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
  key_id          TEXT,
  secret_revision INTEGER,
  cancelled_at    INTEGER,
  failed_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_secret_claims_account ON secret_claims (account_id, created_at);`;

/** Columns added after the table first shipped, for `ALTER TABLE` on older control planes. */
export const SECRET_CLAIMS_ADDED_COLUMNS = ["secret_revision", "cancelled_at", "failed_at"] as const;

export type SecretClaimRow = Record<string, unknown>;

export interface SecretClaimIntent {
  kind: "api_key" | "subscriber_secret";
  label: string | null;
  wabaId: string | null;
  creatorUserId: string;
  clientId: string;
  /** The WABA's subscriber-secret revision when the claim was made; null for an API key. */
  secretRevision: number | null;
}

/**
 * Stores the claim's intent and returns its token, which exists only in the
 * answer. A subscriber claim cancels the WABA's pending ones first; past
 * `MAX_PENDING_SECRET_CLAIMS` nothing changes and the answer is `too_many_pending`.
 */
export async function createSecretClaim(
  sql: SqlStorage,
  accountId: string,
  intent: SecretClaimIntent,
  now = Date.now(),
): Promise<{ claimId: string; token: string; expiresAt: number } | "too_many_pending"> {
  const selector = toBase64Url(crypto.getRandomValues(new Uint8Array(8)));
  const secret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(secret);
  const expiresAt = now + SECRET_CLAIM_TTL_MS;
  const superseded = intent.kind === "subscriber_secret" ? intent.wabaId : null;
  sql.exec("DELETE FROM secret_claims WHERE account_id = ? AND expires_at < ?", accountId, now - KEEP_MS);
  const pending = sql
    .exec(
      `SELECT COUNT(*) AS n FROM secret_claims WHERE account_id = ? AND ${PENDING}
       AND NOT (kind = 'subscriber_secret' AND waba_id IS ?)`,
      accountId,
      now,
      superseded,
    )
    .one().n as number;
  if (pending >= MAX_PENDING_SECRET_CLAIMS) return "too_many_pending";
  if (superseded) cancelSubscriberSecretClaims(sql, accountId, superseded, now);
  sql.exec(
    `INSERT INTO secret_claims
       (selector, account_id, hash, kind, label, waba_id, creator_user_id, client_id, created_at, expires_at, secret_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    intent.secretRevision,
  );
  return { claimId: selector, token: `${selector}.${secret}`, expiresAt };
}

/** Cancels the WABA's pending subscriber claims. */
export function cancelSubscriberSecretClaims(sql: SqlStorage, accountId: string, wabaId: string, now = Date.now()): void {
  sql.exec(
    `UPDATE secret_claims SET cancelled_at = ?
     WHERE account_id = ? AND kind = 'subscriber_secret' AND waba_id = ? AND ${PENDING}`,
    now,
    accountId,
    wabaId,
    now,
  );
}

/** Marks a claim cancelled or its secret write failed, whatever its state. */
export function markSecretClaim(
  sql: SqlStorage,
  selector: string,
  column: "cancelled_at" | "failed_at",
  now = Date.now(),
): void {
  sql.exec(`UPDATE secret_claims SET ${column} = ? WHERE selector = ? AND ${column} IS NULL`, now, selector);
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
  return row.redeemed_at === null && row.cancelled_at === null && (row.expires_at as number) > now;
}

/** The account's unspent, uncancelled, unexpired claims, newest first. */
export function pendingSecretClaims(sql: SqlStorage, accountId: string, now = Date.now()): SecretClaimRow[] {
  return sql
    .exec(`SELECT * FROM secret_claims WHERE account_id = ? AND ${PENDING} ORDER BY created_at DESC, rowid DESC`, accountId, now)
    .toArray();
}

/** Spends a pending claim. Null when it was already spent, cancelled or has expired: only one caller ever gets the row. */
export function spendSecretClaim(
  sql: SqlStorage,
  selector: string,
  keyId: string | null,
  now = Date.now(),
): SecretClaimRow | null {
  return (
    sql
      .exec(
        `UPDATE secret_claims SET redeemed_at = ?, key_id = ? WHERE selector = ? AND ${PENDING} RETURNING *`,
        now,
        keyId,
        selector,
        now,
      )
      .toArray()[0] ?? null
  );
}
