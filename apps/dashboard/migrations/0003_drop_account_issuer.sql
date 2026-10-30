-- better-auth 1.7.14 dropped `account.issuer` (eccos-nlzu). 0001 declared it
-- NOT NULL, so every credential insert since the upgrade failed with
-- D1 SERVER_ERROR and left the new user without a password.
drop index if exists "account_issuer_accountId_uidx";
alter table "account" drop column "issuer";
