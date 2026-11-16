import type { ConnectFailureCode, ConnectLinkSummary } from "@eccos/gateway-contract";

/**
 * Per-workspace connection links: one row per account, replaced by a new link.
 * The token is `<selector>.<secret>`; only the selector and the secret's hash
 * are stored, and the secret is compared in constant time.
 */

export const CONNECT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Longer than any exchange; a claim a dead request left behind frees itself. */
const CLAIM_MS = 2 * 60 * 1000;
const TOKEN_PATTERN = /^([a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/;

export const CONNECT_LINKS_SCHEMA = `CREATE TABLE IF NOT EXISTS connect_links (
  account_id      TEXT PRIMARY KEY,
  selector        TEXT NOT NULL UNIQUE,
  hash            TEXT NOT NULL,
  creator_user_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  opened_at       INTEGER,
  used_at         INTEGER,
  claimed_until   INTEGER,
  connected_phone TEXT,
  notified_failure TEXT
);`;

export interface ConnectLinkRow {
  accountId: string;
  creatorUserId: string;
  state: "active" | "expired" | "used";
}

function randomBase64Url(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function stateOf(row: Record<string, unknown>, now: number): ConnectLinkRow["state"] {
  if (row.used_at !== null) return "used";
  return (row.expires_at as number) <= now ? "expired" : "active";
}

/** The row a token opens, or null. Unknown, malformed and replaced tokens all look the same. */
async function find(sql: SqlStorage, token: string): Promise<Record<string, unknown> | null> {
  const match = TOKEN_PATTERN.exec(typeof token === "string" ? token : "");
  if (!match) return null;
  const [, selector, secret] = match;
  const given = await sha256(secret as string);
  const row = sql.exec("SELECT * FROM connect_links WHERE selector = ?", selector).toArray()[0];
  if (!row) return null;
  const stored = new TextEncoder().encode(row.hash as string);
  const candidate = new TextEncoder().encode(hex(given));
  if (stored.byteLength !== candidate.byteLength || !crypto.subtle.timingSafeEqual(stored, candidate)) return null;
  return row;
}

function grant(row: Record<string, unknown>, now: number): ConnectLinkRow {
  return {
    accountId: row.account_id as string,
    creatorUserId: row.creator_user_id as string,
    state: stateOf(row, now),
  };
}

export async function issueConnectLink(
  sql: SqlStorage,
  accountId: string,
  creatorUserId: string,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const selector = hex(crypto.getRandomValues(new Uint8Array(8)));
  const secret = randomBase64Url(32);
  const expiresAt = now + CONNECT_LINK_TTL_MS;
  sql.exec(
    `INSERT OR REPLACE INTO connect_links (account_id, selector, hash, creator_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    accountId,
    selector,
    hex(await sha256(secret)),
    creatorUserId,
    now,
    expiresAt,
  );
  return { token: `${selector}.${secret}`, expiresAt };
}

export function summarizeConnectLink(sql: SqlStorage, accountId: string, now = Date.now()): ConnectLinkSummary | null {
  const row = sql.exec("SELECT * FROM connect_links WHERE account_id = ?", accountId).toArray()[0];
  if (!row) return null;
  const state = stateOf(row, now);
  return {
    state: state === "used" ? "connected" : state === "expired" ? "expired" : row.opened_at === null ? "pending" : "opened",
    expiresAt: row.expires_at as number,
    connectedPhone: (row.connected_phone as string | null) ?? null,
  };
}

export async function resolveConnectLink(
  sql: SqlStorage,
  token: string,
  markOpened: boolean,
  now = Date.now(),
): Promise<ConnectLinkRow | null> {
  const row = await find(sql, token);
  if (!row) return null;
  const found = grant(row, now);
  if (markOpened && found.state === "active" && row.opened_at === null) {
    sql.exec("UPDATE connect_links SET opened_at = ? WHERE selector = ? AND opened_at IS NULL", now, row.selector);
  }
  return found;
}

/** Takes the link for one exchange. Null when it is not active or another exchange holds it. */
export async function claimConnectLink(sql: SqlStorage, token: string, now = Date.now()): Promise<ConnectLinkRow | null> {
  const row = await find(sql, token);
  if (!row || stateOf(row, now) !== "active") return null;
  const claimed = sql
    .exec(
      `UPDATE connect_links SET claimed_until = ?
       WHERE selector = ? AND used_at IS NULL AND (claimed_until IS NULL OR claimed_until <= ?) RETURNING account_id`,
      now + CLAIM_MS,
      row.selector,
      now,
    )
    .toArray();
  return claimed.length > 0 ? grant(row, now) : null;
}

/**
 * Ends a claim. A registration spends the link; anything else frees it.
 * Returns whether the creator should hear about it: every registration, and
 * each failure reason once, so a bearer cannot turn the link into a mail loop.
 */
export async function settleConnectLink(
  sql: SqlStorage,
  token: string,
  outcome: { connected: true; phone: string | null } | { connected: false; code: ConnectFailureCode },
  now = Date.now(),
): Promise<boolean> {
  const row = await find(sql, token);
  if (!row) return false;
  if (outcome.connected) {
    sql.exec(
      "UPDATE connect_links SET used_at = ?, connected_phone = ?, claimed_until = NULL WHERE selector = ?",
      now,
      outcome.phone,
      row.selector,
    );
    return true;
  }
  // An expired state exchanged nothing: there is no attempt to report.
  const notify = outcome.code !== "state" && row.notified_failure !== outcome.code;
  sql.exec(
    "UPDATE connect_links SET claimed_until = NULL, notified_failure = ? WHERE selector = ?",
    notify ? outcome.code : row.notified_failure,
    row.selector,
  );
  return notify;
}
