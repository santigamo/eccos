/**
 * Deletes the OAuth clients nobody uses (contract §9, `POST /oauth2/register`
 * and Client ID Metadata Documents). Anyone can add one, by registering or by
 * naming a document URL at the authorization endpoint, so without this every
 * such call would keep its row forever.
 *
 * A row is deleted only when all of these hold:
 * - it came from dynamic registration (no `clientDiscoveryId`) or from a
 *   metadata document (`clientDiscoveryId` is `cimd`), and has no owner
 *   (`userId`, `referenceId`). This console's registrations never have one,
 *   because the request reaches Better Auth without its cookie
 *   (server/oauth-cross-origin.ts), and documents never do;
 * - it was last written more than `UNUSED_CLIENT_TTL_MS` ago. A registration
 *   is written once; a document client is rewritten (`updatedAt`) every time
 *   its document is fetched again, so one in use keeps its row;
 * - nothing refers to it: no consent, no refresh token, no access token.
 *   A consent is written before any code is issued, so a client with a grant
 *   in flight or alive is never touched.
 *
 * A deleted document client comes back on its next authorization, which
 * fetches the document again. One statement, so it is idempotent and safe to
 * run on every cron tick. Its `oauthClientResource` links go with it
 * (`on delete cascade`).
 */

export const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

/** The hourly trigger in the console's wrangler config, so a client outlives the TTL by at most an hour. */
export const OAUTH_CLIENT_CLEANUP_CRON = "0 * * * *";

const DELETE_UNUSED_CLIENTS = `DELETE FROM "oauthClient"
WHERE ("clientDiscoveryId" IS NULL OR "clientDiscoveryId" = 'cimd')
  AND "userId" IS NULL
  AND "referenceId" IS NULL
  AND COALESCE("updatedAt", "createdAt") < ?1
  AND NOT EXISTS (SELECT 1 FROM "oauthConsent" WHERE "oauthConsent"."clientId" = "oauthClient"."clientId")
  AND NOT EXISTS (SELECT 1 FROM "oauthRefreshToken" WHERE "oauthRefreshToken"."clientId" = "oauthClient"."clientId")
  AND NOT EXISTS (SELECT 1 FROM "oauthAccessToken" WHERE "oauthAccessToken"."clientId" = "oauthClient"."clientId")`;

export async function deleteUnusedOAuthClients(db: D1Database, now = Date.now()): Promise<void> {
  // Better Auth stores dates as ISO 8601 strings in UTC, which sort as text.
  await db.prepare(DELETE_UNUSED_CLIENTS).bind(new Date(now - UNUSED_CLIENT_TTL_MS).toISOString()).run();
}
