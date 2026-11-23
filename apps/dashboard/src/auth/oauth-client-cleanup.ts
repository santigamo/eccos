/**
 * Deletes the OAuth clients and consents nobody uses (contract §9, `POST /oauth2/register`
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
 * - it was created more than `UNUSED_CLIENT_TTL_MS` ago. A document client is
 *   rewritten (`updatedAt`) whenever its document is fetched again, which
 *   token and revocation calls also do, so that time is not used: it would let
 *   them keep a client alive outside the authorization endpoint's limit;
 * - nothing holds it: no consent and no live token. A consent is written
 *   before any code is issued, so a client with a grant in flight or alive is
 *   never touched.
 *
 * A consent itself goes first, once its grant has been dead (oauth-grants.ts)
 * for the same 24 hours, counted from the consent or its last token's end,
 * whichever is later. A consent alone therefore pins its client for at most a
 * day, and a live grant pins it for as long as it lives.
 *
 * A deleted document client comes back on its next authorization, which
 * fetches the document again. Each statement is idempotent and safe to run on
 * every cron tick. A client's `oauthClientResource` links and dead tokens go
 * with it (`on delete cascade`).
 */

import { GRANT_IS_LIVE, GRANT_LAST_ALIVE, TOKEN_IS_LIVE } from "./oauth-grants";

export const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

/** The hourly trigger in the console's wrangler config, so a client outlives the TTL by at most an hour. */
export const OAUTH_CLIENT_CLEANUP_CRON = "0 * * * *";

/** A consent whose grant has been dead for the TTL: `?1` now, `?2` the TTL ago. */
const DELETE_DEAD_CONSENTS = `DELETE FROM "oauthConsent" WHERE NOT ${GRANT_IS_LIVE} AND ${GRANT_LAST_ALIVE} < ?2`;

const noLiveToken = (table: string) =>
  `NOT EXISTS (SELECT 1 FROM "${table}" AS t WHERE t."clientId" = "oauthClient"."clientId" AND ${TOKEN_IS_LIVE})`;

/** A client nothing holds: `?1` now, `?2` the TTL ago. */
const DELETE_UNUSED_CLIENTS = `DELETE FROM "oauthClient"
WHERE ("clientDiscoveryId" IS NULL OR "clientDiscoveryId" = 'cimd')
  AND "userId" IS NULL
  AND "referenceId" IS NULL
  AND "createdAt" < ?2
  AND NOT EXISTS (SELECT 1 FROM "oauthConsent" WHERE "oauthConsent"."clientId" = "oauthClient"."clientId")
  AND ${noLiveToken("oauthRefreshToken")}
  AND ${noLiveToken("oauthAccessToken")}`;

export async function deleteUnusedOAuthClients(db: D1Database, now = Date.now()): Promise<void> {
  // Better Auth stores dates as ISO 8601 strings in UTC, which sort as text.
  const at = new Date(now).toISOString();
  const cutoff = new Date(now - UNUSED_CLIENT_TTL_MS).toISOString();
  await db.prepare(DELETE_DEAD_CONSENTS).bind(at, cutoff).run();
  await db.prepare(DELETE_UNUSED_CLIENTS).bind(at, cutoff).run();
}
