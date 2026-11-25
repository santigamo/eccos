/**
 * When an OAuth grant is alive (contract `9). A grant is one `oauthConsent`
 * row: a person's consent for one client in one workspace (`referenceId`).
 * It is live only while a token issued under it can still be used: an
 * unrevoked refresh token that has not expired, or a stored access token that
 * has not (MCP access tokens are JWTs and never stored, and last 10 minutes),
 * or an authorization code not yet exchanged that has not expired. Better Auth
 * keeps the code in `verification` until the exchange consumes it, expiring at
 * its configured `codeExpiresIn`. A rotated refresh token is revoked by the
 * rotation, so only the newest counts.
 *
 * This is the one definition. The cleanup (oauth-client-cleanup.ts) deletes a
 * consent dead for 24 hours, the consent step caps live grants per person and
 * workspace, and revoking a grant (deleting the consent and revoking its
 * refresh tokens) makes it dead by the same rule.
 */

/** Live grants one person may hold in one workspace; one more consent is refused. */
export const MAX_LIVE_GRANTS = 50;

/** A select over the tokens issued under the `oauthConsent` row in scope. */
const tokensOfConsent = (table: string, select: string) =>
  `SELECT ${select} FROM "${table}" AS t
    WHERE t."clientId" = "oauthConsent"."clientId"
      AND t."userId" = "oauthConsent"."userId"
      AND t."referenceId" IS "oauthConsent"."referenceId"`;

/**
 * A select over the authorization codes issued to a client for a person and
 * workspace. Other verification values (email links and the like) need not be
 * JSON, so the fields are read only from a code's value.
 */
const codeField = (field: string) =>
  `CASE WHEN v."value" LIKE '{"type":"authorization_code"%' AND json_valid(v."value") THEN json_extract(v."value", '${field}') END`;
const codesOf = (clientId: string, userId: string, referenceId: string) =>
  `SELECT 1 FROM "verification" AS v
    WHERE ${codeField("$.query.client_id")} = ${clientId}
      AND ${codeField("$.userId")} = ${userId}
      AND ${codeField("$.referenceId")} IS ${referenceId}`;

/** SQL condition over a token row `t`: it can still be used at `?1`. */
export const TOKEN_IS_LIVE = `t."revoked" IS NULL AND t."expiresAt" > ?1`;

/**
 * SQL condition over an `oauthConsent` row: true while its grant is live at
 * `?1`, the current time as an ISO 8601 string (Better Auth stores dates that
 * way, so they compare as text).
 */
export const GRANT_IS_LIVE = `(EXISTS (${tokensOfConsent("oauthRefreshToken", "1")} AND ${TOKEN_IS_LIVE})
  OR EXISTS (${tokensOfConsent("oauthAccessToken", "1")} AND ${TOKEN_IS_LIVE})
  OR EXISTS (${codesOf('"oauthConsent"."clientId"', '"oauthConsent"."userId"', '"oauthConsent"."referenceId"')} AND v."expiresAt" > ?1))`;

/**
 * SQL expression over an `oauthConsent` row: when its grant was last alive,
 * the latest of the consent's own write and each token's revocation, or expiry
 * when it was never revoked. A consent whose code was never exchanged dates
 * from the consent.
 */
const lastTokenEnd = (table: string) =>
  `COALESCE((${tokensOfConsent(table, 'MAX(COALESCE(t."revoked", t."expiresAt"))')}), '')`;
export const GRANT_LAST_ALIVE = `MAX(COALESCE("oauthConsent"."updatedAt", "oauthConsent"."createdAt"), ${lastTokenEnd("oauthRefreshToken")}, ${lastTokenEnd("oauthAccessToken")})`;

const COUNT_OTHER_LIVE_GRANTS = `SELECT count(*) AS n FROM "oauthConsent"
  WHERE "oauthConsent"."userId" = ?2 AND "oauthConsent"."referenceId" = ?3 AND "oauthConsent"."clientId" != ?4
    AND ${GRANT_IS_LIVE}`;

const DELETE_CODES = `DELETE FROM "verification" WHERE "id" IN (
  SELECT v."id" FROM "verification" AS v WHERE ${codeField("$.query.client_id")} = ?3
    AND ${codeField("$.userId")} = ?1 AND ${codeField("$.referenceId")} IS ?2)`;

/** The auth database as Better Auth was given it: the D1 binding, or bun:sqlite in tests. */
type AuthDatabase =
  | D1Database
  | { query(sql: string): { get(...params: string[]): unknown; run(...params: string[]): unknown } };

type Grant = { userId: string; workspace: string; clientId: string };

/** Live grants the person holds in the workspace for clients other than this one. */
export async function otherLiveGrants(database: AuthDatabase, grant: Grant): Promise<number> {
  const params = [new Date().toISOString(), grant.userId, grant.workspace, grant.clientId];
  const row = (
    "batch" in database
      ? await database.prepare(COUNT_OTHER_LIVE_GRANTS).bind(...params).first()
      : database.query(COUNT_OTHER_LIVE_GRANTS).get(...params)
  ) as { n: number } | null;
  return row?.n ?? 0;
}

/** Deletes the client's unexchanged codes for the person and workspace, so a refused consent leaves no live grant. */
export async function withdrawCodes(database: AuthDatabase, grant: Grant): Promise<void> {
  const params = [grant.userId, grant.workspace, grant.clientId];
  if ("batch" in database) await database.prepare(DELETE_CODES).bind(...params).run();
  else database.query(DELETE_CODES).run(...params);
}
