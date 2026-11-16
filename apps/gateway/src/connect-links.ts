import type { ConnectFailureCode, ConnectLinkSummary } from "@eccos/gateway-contract";
import { sha256Hex, toBase64Url } from "./encoding";

/**
 * Per-workspace connection links: one row per account, replaced by a new link.
 * The token is `<selector>.<secret>`; only the selector and the secret's hash
 * are stored, and the secret is compared in constant time.
 */

export const CONNECT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Longer than any exchange; a claim a dead request left behind frees itself. */
const CLAIM_MS = 2 * 60 * 1000;
/** Failure mails a link may cause in its whole life, each for a different reason. */
const MAX_FAILURE_MAILS = 3;
const TOKEN_PATTERN = /^([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{43})$/;

export const CONNECT_LINKS_SCHEMA = `CREATE TABLE IF NOT EXISTS connect_links (
  account_id      TEXT PRIMARY KEY,
  selector        TEXT NOT NULL UNIQUE,
  hash            TEXT NOT NULL,
  creator_user_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  opened_at       INTEGER,
  used_at         INTEGER,
  unconfirmed     INTEGER NOT NULL DEFAULT 0,
  claimed_until   INTEGER,
  connected_phone TEXT,
  notified_failures TEXT NOT NULL DEFAULT ''
);`;

export interface ConnectLinkRow {
  accountId: string;
  creatorUserId: string;
  issuedAt: number;
  state: "active" | "expired" | "used";
}

/** How a claimed exchange ended. */
export type ConnectLinkSettlement =
  | { kind: "connected"; phone: string | null }
  | { kind: "failed"; code: ConnectFailureCode }
  /** The exchange broke off where a registration may already have run. */
  | { kind: "unknown" }
  /** Nothing was attempted. */
  | { kind: "released" };

function stateOf(row: Record<string, unknown>, now: number): ConnectLinkRow["state"] {
  if (row.used_at !== null) return "used";
  return (row.expires_at as number) <= now ? "expired" : "active";
}

/** The row a token opens, or null. Unknown, malformed and replaced tokens all look the same. */
async function find(sql: SqlStorage, token: string): Promise<Record<string, unknown> | null> {
  const match = TOKEN_PATTERN.exec(typeof token === "string" ? token : "");
  if (!match) return null;
  const [, selector, secret] = match;
  const encoder = new TextEncoder();
  const given = encoder.encode(await sha256Hex(secret as string));
  const row = sql.exec("SELECT * FROM connect_links WHERE selector = ?", selector).toArray()[0];
  if (!row) return null;
  const stored = encoder.encode(row.hash as string);
  if (stored.byteLength !== given.byteLength || !crypto.subtle.timingSafeEqual(stored, given)) return null;
  return row;
}

function grant(row: Record<string, unknown>, now: number): ConnectLinkRow {
  return {
    accountId: row.account_id as string,
    creatorUserId: row.creator_user_id as string,
    issuedAt: row.created_at as number,
    state: stateOf(row, now),
  };
}

/**
 * Makes the account's link. A live one is kept unless `replace` (`exists`),
 * and one an exchange holds is never replaced (`busy`): its settlement would
 * land on nothing and lose what it registered.
 */
export async function issueConnectLink(
  sql: SqlStorage,
  accountId: string,
  creatorUserId: string,
  replace: boolean,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number } | "exists" | "busy"> {
  const selector = toBase64Url(crypto.getRandomValues(new Uint8Array(8)));
  const secret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(secret);
  const expiresAt = now + CONNECT_LINK_TTL_MS;
  // Nothing is awaited from the check to the write, so no other call runs between them.
  const current = sql.exec("SELECT * FROM connect_links WHERE account_id = ?", accountId).toArray()[0];
  if (current && stateOf(current, now) === "active") {
    if (((current.claimed_until as number | null) ?? 0) > now) return "busy";
    if (!replace) return "exists";
  }
  sql.exec(
    `INSERT OR REPLACE INTO connect_links (account_id, selector, hash, creator_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    accountId,
    selector,
    hash,
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
    state:
      state === "expired"
        ? "expired"
        : state === "used"
          ? row.unconfirmed
            ? "unconfirmed"
            : "connected"
          : row.opened_at === null
            ? "pending"
            : "opened",
    expiresAt: row.expires_at as number,
    connectedPhone: (row.connected_phone as string | null) ?? null,
    creatorUserId: row.creator_user_id as string,
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

/** Takes the link for one exchange: `busy` while another exchange holds it, null when it is not active. */
export async function claimConnectLink(
  sql: SqlStorage,
  token: string,
  now = Date.now(),
): Promise<ConnectLinkRow | "busy" | null> {
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
  return claimed.length > 0 ? grant(row, now) : "busy";
}

/**
 * Ends a claim. A registration, or an exchange that may have registered, spends
 * the link; a failure frees it. Returns whether the creator should hear about
 * it: always when the link is spent, and for a failure once per reason and a
 * few times per link, so a bearer cannot turn the link into a mail loop.
 */
export async function settleConnectLink(
  sql: SqlStorage,
  token: string,
  outcome: ConnectLinkSettlement,
  now = Date.now(),
): Promise<boolean> {
  const row = await find(sql, token);
  if (!row) return false;
  if (outcome.kind === "connected" || outcome.kind === "unknown") {
    sql.exec(
      "UPDATE connect_links SET used_at = ?, connected_phone = ?, unconfirmed = ?, claimed_until = NULL WHERE selector = ?",
      now,
      outcome.kind === "connected" ? outcome.phone : null,
      outcome.kind === "unknown" ? 1 : 0,
      row.selector,
    );
    return true;
  }
  const notified = (row.notified_failures as string).split(",").filter(Boolean);
  // An expired state exchanged nothing: there is no attempt to report.
  const notify =
    outcome.kind === "failed" &&
    outcome.code !== "state" &&
    !notified.includes(outcome.code) &&
    notified.length < MAX_FAILURE_MAILS;
  if (notify) notified.push((outcome as { code: string }).code);
  sql.exec(
    "UPDATE connect_links SET claimed_until = NULL, notified_failures = ? WHERE selector = ?",
    notified.join(","),
    row.selector,
  );
  return notify;
}

/** Spends a link whose exchange nobody heard back from, unless it is already spent. */
export async function abandonConnectLink(sql: SqlStorage, token: string, now = Date.now()): Promise<void> {
  const row = await find(sql, token);
  if (row && row.used_at === null) {
    sql.exec(
      "UPDATE connect_links SET used_at = ?, unconfirmed = 1, claimed_until = NULL WHERE selector = ? AND used_at IS NULL",
      now,
      row.selector,
    );
  }
}
