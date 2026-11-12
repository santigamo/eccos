-- TOTP replay (eccos-eyel): the newest time-step this account has had a code
-- accepted for. A code for that step or an older one is refused for step-up.
-- Apply BEFORE deploying the code that reads and writes it.

alter table "twoFactor" add column "lastTotpStep" integer not null default 0;
