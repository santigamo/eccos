-- Funnel emails (eccos-dbb3.4): one row per account and email, so each is sent
-- once. The recovery row is written at the first connect try and sent from the
-- cron once "dueAt" passes; "cause" is the Meta error code the try reported.
-- Apply BEFORE deploying the code that reads and writes it.

create table "funnelMail" (
  "accountId" text not null,
  "kind" text not null,
  "organizationId" text not null,
  "dueAt" integer not null,
  "cause" text,
  "settledAt" integer,
  primary key ("accountId", "kind")
);
