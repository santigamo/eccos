# Data lifecycle

How Eccos creates its schema, how it prunes old rows, and how to back up / restore each
target. Covers **both** targets: the Cloudflare Workers target (`apps/gateway/` — Durable
Object SQLite, `apps/gateway/src/gateway.ts`) and the Bun self-host target (`src/` —
`bun:sqlite`, `src/db/client.ts`). Single-tenant v1: one gateway, one SQLite database, per
target.

## Schema: inline `CREATE TABLE IF NOT EXISTS`

Neither target has a separate migration runner. Schema is declared as idempotent DDL that
runs on every boot:

- **Workers target** — `EccosGateway`'s constructor (`apps/gateway/src/gateway.ts`) runs a
  block of `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements inside
  `ctx.blockConcurrencyWhile(...)` against the Durable Object's own SQLite storage
  (`ctx.storage.sql`), before the DO accepts any request.
- **Bun target** — `openDb()` (`src/db/client.ts`) does the same against a `bun:sqlite`
  file at `DATABASE_PATH`, calling `ensureSchema(db)` right after opening the connection.

This gets self-hosting down to "start the process" with no separate `migrate` step, which is
the right tradeoff for a single-tenant v1. **Limits:**

- `CREATE TABLE IF NOT EXISTS` only creates a table that doesn't exist yet — it never alters
  an existing table. Adding a column, changing a type, or adding a new index to an
  already-created table requires either a new statement guarded by its own check (e.g.
  `CREATE INDEX IF NOT EXISTS` for a net-new index) or an explicit `ALTER TABLE`, added by
  hand to the same boot-time block.
- There is no tracked "schema version" and no down-migration. Every deployment/host is
  assumed to be running against the latest boot-time DDL; there's no record of which
  historical shape a given database is in beyond "whatever `IF NOT EXISTS` has produced so
  far."
- It's correct only as long as every schema change stays additive (new tables, new nullable
  columns, new indexes). A destructive change (drop/rename a column, tighten a `NOT NULL`,
  change a primary key) is unsafe to express as boot-time DDL and needs an explicit one-off
  migration path (see below).

## Forward schema-migration policy

Until there's a real migration runner, changes to either schema follow this policy:

1. **Prefer additive changes.** New table → new `CREATE TABLE IF NOT EXISTS` block. New
   column on an existing table → guard it explicitly, e.g.:
   ```sql
   ALTER TABLE deliveries ADD COLUMN foo TEXT; -- wrap in a try/catch or a
   -- "column exists" check, since SQLite has no ADD COLUMN IF NOT EXISTS
   ```
   For the Workers target, wrap the `ALTER TABLE` so it tolerates re-running against a
   database that already has the column (SQLite raises `duplicate column name` — catch and
   ignore that specific error, or check `PRAGMA table_info` first). For the Bun target, do
   the same inside `ensureSchema()`.
2. **Never repurpose a column's meaning or type in place.** Add a new column, backfill it,
   cut reads/writes over to it, then drop the old one in a later release once nothing reads
   it — the classic expand/contract pattern, done by hand across two deploys.
3. **Breaking changes get a version bump and an explicit note in the changelog / release
   notes** (which table, what changed, whether existing data needs a one-off backfill
   script). Since this is single-tenant v1, a breaking change is something the maintainer
   applies to their own one database — there is no fleet to roll out to gradually.
4. **Workers target specifics:** `apps/gateway/wrangler.jsonc` already has a `migrations`
   block (`{ "tag": "v1", "new_sqlite_classes": ["EccosGateway"] }`) — that's Cloudflare's
   Durable Object *class* migration (SQLite-backed vs. legacy KV-backed storage), not a data
   migration. A future data migration tag would go in the same `migrations` array, but the
   DO's own SQL schema still needs the additive-DDL treatment above; Wrangler's migrations
   don't run arbitrary SQL for you.
5. **Bun target specifics:** since `ensureSchema()` runs against a plain file path, a
   destructive change can alternatively ship as a one-off script under `scripts/` that
   operators run manually before upgrading (documented in release notes), rather than
   folding risky DDL into the always-on boot path.

## Backup / restore

### Workers target (Durable Object SQLite)

The DO's SQLite storage is replicated by Cloudflare's storage layer as part of the platform's
durability guarantees — there is no self-managed disk to snapshot, and no built-in "export to
file" button in the dashboard for DO SQLite (unlike D1, which has `wrangler d1 export`).
Practical options, in order of effort:

- **Rely on Cloudflare's durability** for protection against host/disk failure — this is the
  baseline and requires no action. It does **not** protect against application-level mistakes
  (a bad delivery loop, an operator action that deletes data, a bug that corrupts rows).
- **Application-level export**: since the operator console (`apps/dashboard`) already reads
  the gateway over the `GatewayRPC` binding (`listInbound`, `listOutbound`, `listDeliveries`,
  `getConfig`, which filters private values), the same RPC surface can be scripted (e.g. a small `wrangler` /
  `fetch`-based tool, or a scheduled Worker) to page through those methods and write a JSON/
  JSONL snapshot to external storage (R2, or just downloaded locally). This repo does not
  ship that export script today — treat it as a follow-up if point-in-time backups of the
  Workers target become a requirement.
- **Restore** means redeploying the Worker (code is stateless) and, if the DO instance itself
  was lost/recreated, replaying an application-level export back through `ingest()` /
  `logOutbound()` / `saveConfig()`. There's no "restore a SQLite file" primitive for DO
  storage.

### Bun target (`bun:sqlite` file)

This target's whole database is one file at `DATABASE_PATH` (`./data/eccos.db` by default;
`/app/data/eccos.db` in the Docker image, on the `eccos-data` named volume per
`docker-compose.yml`). Back it up like any SQLite file:

```bash
# hot backup while the process is running (WAL-mode safe): SQLite's own backup API
sqlite3 /app/data/eccos.db ".backup /path/to/backup/eccos-$(date +%F).db"

# or, for the Docker Compose deployment, back up the named volume directly
docker run --rm -v eccos-data:/app/data -v "$PWD":/backup alpine \
  tar czf /backup/eccos-data-$(date +%F).tar.gz -C /app/data .
```

Do this on a schedule (cron / systemd timer next to the container host) and keep at least one
copy off the host. **Restore** is the reverse: stop the container, replace the file (or
extract the tarball back into the volume), start the container again — `openDb()` will find
the existing file and skip table creation for anything that already exists.

## Retention (split content / delivery windows)

Both targets prune old rows on an ongoing basis rather than growing the database forever.

**Workers target (`apps/gateway`)** — retention is split in two windows, because message
content lives in *three* tables (`deliveries.payload` carries a full copy of each forwarded
event batch) while the operational audit trail (did the forward succeed, how many attempts,
what error) should outlive the content itself:

| Var (`apps/gateway/wrangler.jsonc` → `vars`) | Default | Effect when a row ages past it |
|---|---|---|
| `CONTENT_RETENTION_DAYS` | **30**, clamped to **7–90** | `inbound_events` (by `received_at`) and `outbound_messages` (by `created_at`) rows are **deleted**; terminal (`delivered`/`failed`) `deliveries` rows are **redacted in place** — `payload` is emptied, while `id`, `status`, `attempts`, `last_error`, `next_attempt_at`, and `created_at` survive |
| `DELIVERY_RETENTION_DAYS` | **90** | terminal `deliveries` rows are **deleted** entirely, by `created_at` |

So after ~30 days no message content (bodies, phone numbers) exists anywhere, but the
metadata-only delivery rows remain another ~60 days as operational/audit evidence. A redacted
delivery row (`payload = ''`) can no longer be replayed — `retryDelivery` refuses it — and the
dashboard shows it with an empty payload. Rows still `pending` are never touched by age.

The Workers target uses only the split vars; there is no tenant-wide retention setting. Both
values are guarded: non-numeric or non-positive values fall back to the defaults instead of
feeding a destructive window (`resolveRetentionDays()` in
`apps/gateway/src/gateway.ts`).

**Bun target (`src/`, kept aside until post-v1)** — still uses a single retention window:
`pruneOldRows()` in `src/delivery/forward.ts` deletes rows in all three tables past
`cfg.RETENTION_DAYS` (Zod default 30, `.env` or process env). It has no redaction step yet;
split retention lands there when the target is retaken.

Pruning cadence: the Workers target prunes as part of every `alarm()` invocation (which also
drives delivery retries, so it runs at least as often as there's pending work, and is
re-armed by `setAlarm()`); the Bun target prunes once per delivery-loop tick
(`processPending()`, every 5s via `startDeliveryLoop()`). Both are simple `DELETE`/`UPDATE
... WHERE <timestamp> < cutoff` statements. Workers scans stay inside one WABA's object, and
the Bun scan stays inside one self-hosted instance.

## Right to erasure (`eraseByPhone`)

Independent of retention, the Workers target can erase every stored trace of a single phone
number on demand (GDPR Art. 17): `EccosGateway.eraseByPhone(phone)`, exposed to operators as
`GatewayRPC.eraseByPhone()` (service binding) and as `POST /v1/wabas/<WABA_ID>/privacy/erasure`
(`{"phone": "+34..."}`, Bearer account key). It deletes matching `inbound_events` and
`outbound_messages` rows, rewrites `deliveries` batches to drop the number's events (redacting
or deleting batches left empty), and returns per-table counts as erasure evidence. Details and
limitations in [docs/privacy.md](./privacy.md#erasure).

Retention only controls **application data pruning**. It does not shrink the file
automatically (`bun:sqlite`) or reclaim space in DO SQLite storage; expect the on-disk size to
plateau rather than shrink after a burst of deletes (SQLite generally needs a `VACUUM` to
reclaim pages, which is not run automatically here to avoid locking the database on a live
single-tenant host).

## RPO / RTO expectations (single-tenant self-host)

These are the realistic numbers for a v1, single-tenant deployment — not multi-tenant SLAs.

| | Workers target | Bun target |
|---|---|---|
| **RPO** (data loss window) | ~0 in the common case (Cloudflare's DO SQLite durability); up to "since your last application-level export" if you rely on a scripted export and the DO itself is lost | Since your last file/volume backup — minutes to a day, depending on how often you schedule the `.backup` / volume snapshot above |
| **RTO** (time to restore service) | Minutes: redeploy the Worker (`bun run deploy`), no data to restore in the common case; longer if replaying an application-level export | Minutes: restore the volume/file and restart the container (`docker compose up -d`) |
| Assumptions | One versioned DO per WABA, with no cross-region replica to fail over to | Single host, single named volume; no HA/replica — losing the host means restoring from your last backup |

There is no automatic failover, no multi-region replication, and no continuous backup job
shipped in this repo for either target — both are appropriate for a single operator running
one WhatsApp number, not for a workload with a contractual RPO/RTO. If those numbers need to
tighten, the two concrete levers are (a) scripting the application-level export for the
Workers target and running it on a schedule, and (b) increasing the backup frequency for the
Bun target's SQLite file/volume.
