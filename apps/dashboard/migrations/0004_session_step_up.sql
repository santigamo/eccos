-- Step-up freshness (eccos-eyel): when this session last proved a second
-- factor. Null for a session that never did, which never passes step-up.
-- Apply BEFORE deploying the code that reads and writes it.

alter table "session" add column "stepUpAt" date;
