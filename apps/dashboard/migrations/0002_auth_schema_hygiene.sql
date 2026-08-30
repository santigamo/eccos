-- Auth D1 schema hygiene (eccos-ya5).
--
-- 1. Index session expiry so expired-session sweeps and lookups by expiresAt
--    (Better Auth session refresh/expiry checks, ops cleanup) do not scan the
--    whole table.
--
-- 2. Case-insensitive uniqueness on user.email. 0001 declared
--    `email text not null unique` (BINARY collation), so 'Alice@example.com'
--    and 'alice@example.com' are currently DISTINCT rows. Better Auth itself
--    normalizes emails to lower-case on sign-up, so a fresh install cannot
--    contain such duplicates; a database that predates the normalization
--    (or that received rows through a path that skipped it) could. The unique
--    index below FAILS on any existing case-duplicate rows — resolve or merge
--    them BEFORE applying this migration in each environment.
--
-- 3. rateLimit cleanup: Better Auth's database rate limiter prunes expired rows
--    lazily (deleteExpiredRows on each consume) using
--    `WHERE lastRequest < cutoff`; with no index that delete scans the whole
--    table on every rate-limited path. The index makes the prune cheap and is
--    also the natural handle for a scheduled cleanup
--    (`DELETE FROM rateLimit WHERE lastRequest < <now - maxWindow>`), which is
--    left to operations — no cron wiring ships with this migration.

create index "session_expiresAt_idx" on "session" ("expiresAt");

create unique index "user_email_nocase_uidx" on "user" ("email" collate nocase);

create index "rateLimit_lastRequest_idx" on "rateLimit" ("lastRequest");
