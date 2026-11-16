import type { ConnectLinkSettlement, ConnectLinkSummary } from "@eccos/gateway-contract";
import { sha256Hex, toBase64Url } from "./encoding";

/**
 * Per-workspace connection links. The account's link is its newest row; making
 * another revokes the previous one but keeps its row, so an exchange already
 * running on it still has somewhere to record what it registered.
 *
 * The token is `<selector>.<secret>`; only the selector and the secret's hash
 * are stored, and the secret is compared in constant time.
 */

export const CONNECT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How long one exchange holds the link against a second bearer. Well past the
 * longest exchange (Meta's calls plus the provisioning wait), so a claim only
 * runs out on a request that died.
 */
const CLAIM_MS = 10 * 60 * 1000;
/** Failure mails a link may cause in its whole life, each for a different reason. */
const MAX_FAILURE_MAILS = 3;
/** Rows that stopped mattering this long ago are dropped when a link is made. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{43})$/;

export const CONNECT_LINKS_SCHEMA = `CREATE TABLE IF NOT EXISTS connect_links (
  selector        TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  hash            TEXT NOT NULL,
  creator_user_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  opened_at       INTEGER,
  used_at         INTEGER,
  unconfirmed     INTEGER NOT NULL DEFAULT 0,
  claim_nonce     TEXT,
  claimed_until   INTEGER,
  connected_phone TEXT,
  notified_failures TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_connect_links_account ON connect_links (account_id, created_at);`;

type Row = Record<string, unknown>;

export interface ConnectLinkRow {
  /** The selector: names the link to the gateway without being able to open it. */
  linkId: string;
  accountId: string;
  creatorUserId: string;
  state: "active" | "expired" | "used" | "revoked";
}

function stateOf(row: Row, now: number): ConnectLinkRow["state"] {
  if (row.used_at !== null) return "used";
  if (row.revoked_at !== null) return "revoked";
  return (row.expires_at as number) <= now ? "expired" : "active";
}

function bySelector(sql: SqlStorage, selector: string): Row | null {
  return sql.exec("SELECT * FROM connect_links WHERE selector = ?", selector).toArray()[0] ?? null;
}

/** The row a token opens, or null. Unknown and malformed tokens look the same. */
async function find(sql: SqlStorage, token: string): Promise<Row | null> {
  const match = TOKEN_PATTERN.exec(typeof token === "string" ? token : "");
  if (!match) return null;
  const [, selector, secret] = match;
  const encoder = new TextEncoder();
  const given = encoder.encode(await sha256Hex(secret as string));
  const row = bySelector(sql, selector as string);
  if (!row) return null;
  const stored = encoder.encode(row.hash as string);
  if (stored.byteLength !== given.byteLength || !crypto.subtle.timingSafeEqual(stored, given)) return null;
  return row;
}

function grant(row: Row, now: number): ConnectLinkRow {
  return {
    linkId: row.selector as string,
    accountId: row.account_id as string,
    creatorUserId: row.creator_user_id as string,
    state: stateOf(row, now),
  };
}

function newest(sql: SqlStorage, accountId: string): Row | null {
  return (
    sql
      .exec("SELECT * FROM connect_links WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", accountId)
      .toArray()[0] ?? null
  );
}

/** Makes the account's link. A live one is kept unless `replace`: the answer is then `exists`. */
export async function issueConnectLink(
  sql: SqlStorage,
  accountId: string,
  creatorUserId: string,
  replace: boolean,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number } | "exists"> {
  const selector = toBase64Url(crypto.getRandomValues(new Uint8Array(8)));
  const secret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(secret);
  const expiresAt = now + CONNECT_LINK_TTL_MS;
  // Nothing is awaited from the check to the write, so no other call runs between them.
  const current = newest(sql, accountId);
  if (!replace && current && stateOf(current, now) === "active") return "exists";
  sql.exec("UPDATE connect_links SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL", now, accountId);
  sql.exec("DELETE FROM connect_links WHERE account_id = ? AND MAX(expires_at, COALESCE(claimed_until, 0)) < ?", accountId, now - KEEP_MS);
  sql.exec(
    `INSERT INTO connect_links (selector, account_id, hash, creator_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    selector,
    accountId,
    hash,
    creatorUserId,
    now,
    expiresAt,
  );
  return { token: `${selector}.${secret}`, expiresAt };
}

export function summarizeConnectLink(sql: SqlStorage, accountId: string, now = Date.now()): ConnectLinkSummary | null {
  const row = newest(sql, accountId);
  if (!row) return null;
  const state = stateOf(row, now);
  return {
    state:
      state === "used"
        ? row.unconfirmed
          ? "unconfirmed"
          : "connected"
        : state !== "active"
          ? "expired"
          : row.opened_at === null
            ? "pending"
            : "opened",
    expiresAt: row.expires_at as number,
    connectedPhone: (row.connected_phone as string | null) ?? null,
    creatorUserId: row.creator_user_id as string,
  };
}

export async function resolveConnectLink(sql: SqlStorage, token: string, now = Date.now()): Promise<ConnectLinkRow | null> {
  const row = await find(sql, token);
  return row && grant(row, now);
}

/** For a link already resolved in full: its reader's page is open. */
export function markConnectLinkOpened(sql: SqlStorage, linkId: string, now = Date.now()): void {
  sql.exec(
    "UPDATE connect_links SET opened_at = ? WHERE selector = ? AND opened_at IS NULL AND used_at IS NULL AND revoked_at IS NULL",
    now,
    linkId,
  );
}

/**
 * Takes the link for one exchange. `busy` while another exchange holds it;
 * a row that is not active comes back as it is, unclaimed.
 */
export async function claimConnectLink(
  sql: SqlStorage,
  token: string,
  now = Date.now(),
): Promise<{ row: ConnectLinkRow; claimId: string | null } | "busy" | null> {
  const found = await find(sql, token);
  if (!found) return null;
  const row = grant(found, now);
  if (row.state !== "active") return { row, claimId: null };
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(12)));
  const claimed = sql
    .exec(
      `UPDATE connect_links SET claim_nonce = ?, claimed_until = ?
       WHERE selector = ? AND used_at IS NULL AND revoked_at IS NULL
         AND (claimed_until IS NULL OR claimed_until <= ?) RETURNING selector`,
      nonce,
      now + CLAIM_MS,
      row.linkId,
      now,
    )
    .toArray();
  return claimed.length > 0 ? { row, claimId: `${row.linkId}.${nonce}` } : "busy";
}

/**
 * Records how a claimed exchange ended, on the claim's own row: it is found by
 * the claim id even after the link was revoked or the claim ran out, so a
 * registration is never lost. A registration, or an exchange that may have
 * registered, spends the link; a failure frees it.
 *
 * Returns whether the creator should hear about it: when the link is spent,
 * and for a failure once per reason and a few times per link, so a bearer
 * cannot turn the link into a mail loop.
 */
export function settleConnectLink(
  sql: SqlStorage,
  claimId: string,
  outcome: ConnectLinkSettlement,
  now = Date.now(),
): { notify: boolean; state: ConnectLinkSummary["state"] | "revoked" } | null {
  const [selector = "", nonce = ""] = claimId.split(".");
  const row = bySelector(sql, selector);
  if (!row) return null;
  const mine = row.claim_nonce === nonce;
  const release = mine ? ", claim_nonce = NULL, claimed_until = NULL" : "";
  let notify = false;
  if (outcome.kind === "connected") {
    // Wins over an earlier "unconfirmed": this is the confirmation.
    sql.exec(
      `UPDATE connect_links SET used_at = COALESCE(used_at, ?), connected_phone = ?, unconfirmed = 0${release} WHERE selector = ?`,
      now,
      outcome.phone,
      selector,
    );
    notify = true;
  } else if (outcome.kind === "unknown") {
    // Only the exchange that holds the link may spend it on a guess.
    notify = mine && row.used_at === null;
    if (notify) {
      sql.exec(`UPDATE connect_links SET used_at = ?, unconfirmed = 1${release} WHERE selector = ?`, now, selector);
    }
  } else {
    const notified = (row.notified_failures as string).split(",").filter(Boolean);
    // An expired state exchanged nothing: there is no attempt to report.
    if (
      outcome.kind === "failed" &&
      outcome.code !== "state" &&
      !notified.includes(outcome.code) &&
      notified.length < MAX_FAILURE_MAILS
    ) {
      notified.push(outcome.code);
      notify = true;
    }
    sql.exec(
      `UPDATE connect_links SET notified_failures = ?${release} WHERE selector = ?`,
      notified.join(","),
      selector,
    );
  }
  const after = bySelector(sql, selector) as Row;
  const state = stateOf(after, now);
  return {
    notify,
    state: state === "used" ? (after.unconfirmed ? "unconfirmed" : "connected") : state === "active" ? "pending" : state,
  };
}
