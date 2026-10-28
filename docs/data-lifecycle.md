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
- **A dangling `inbound_events.delivery_id` is expected, not corruption.** The column points at
  the forwarding batch that carried an event, and the two tables age out on *different* windows
  (content vs delivery-audit) — so a surviving event can name a batch that is already gone, and a
  surviving batch can outlive every event it carried. Every reader treats a missing join as "the
  batch is gone", which is why there is no foreign key. Rows written before the column existed are
  NULL and are never backfilled: there is no honest value to guess.
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

Both targets prune their relay buffer on an ongoing basis rather than growing the database
forever. Conversation history is the exception: it is the workspace's record, not a buffer.

**Conversation history (Workers target, `apps/gateway`)** — messages and contacts are kept
until a number is erased (`eraseByPhone`) or the workspace's own window passes. The default is
**forever**. The window is set per workspace in Settings (30 to 3650 days) and stored once, on
the account's control-plane row as `conversation_retention_days` (NULL = forever). The windows
below never touch conversation history.

**Relay buffer (Workers target, `apps/gateway`)** — retention is split in two windows, because
message content lives in *three* tables (`deliveries.payload` carries a full copy of each forwarded
event batch) while the operational audit trail (did the forward succeed, how many attempts,
what error) should outlive the content itself:

| Var (`apps/gateway/wrangler.jsonc` → `vars`) | Default | Effect when a row ages past it |
|---|---|---|
| `CONTENT_RETENTION_DAYS` | **30**, clamped to **7–90** | `inbound_events` (by `received_at`) and `outbound_messages` (by `created_at`) rows are **deleted**; terminal (`delivered`/`failed`) `deliveries` rows are **redacted in place** — `payload` is emptied, while `id`, `status`, `attempts`, `last_error`, `next_attempt_at`, `created_at`, and `finished_at` survive; **`pending` `deliveries` rows are deleted** (by `created_at`) |
| `DELIVERY_RETENTION_DAYS` | **90** | terminal `deliveries` rows are **deleted** entirely, by `created_at` |

Coexistence sync payloads (`sync_payloads` + `sync_payload_parts`: the raw `history` and
`smb_app_state_sync` webhooks, split into parts under 1 MB) are **outside both windows** and are
not expired for now — Meta sends them once per number and they cannot be fetched again. Each is
applied to the conversation store once by the alarm, a bounded batch per wake, and keeps its
progress (`cursor`, `processed_at`, `error`). A payload above 20 MB is parked unread, and one whose
wakes keep failing or aborting is parked after 5 attempts, with the reason in `error`. Reprocessing
rebuilds the history rows from these raw payloads; numbers erased with `eraseByPhone` are listed in
`erased_numbers` and never come back that way.

The conversation store (`messages` + `contacts`, written from the same events and sends) is **outside both
windows**: it is the conversation record itself, not a relay buffer. Its retention is the workspace's
own window described above, not `CONTENT_RETENTION_DAYS`. The window is applied when history is stored
too, so an older history message is never kept. A contact synced from the phone's address book
(`smb_app_state_sync`) is kept whether or not it still has a message; a history or live contact left
with no message is deleted.

So after ~30 days no relay-buffer content (bodies, phone numbers) exists outside the sync payloads
and conversation history, and the metadata-only delivery rows remain another ~60 days as
operational/audit evidence. A redacted
delivery row (`payload = ''`) can no longer be replayed — `retryDelivery` refuses it — and the
dashboard shows it with an empty payload.

**Why `pending` rows are deleted rather than redacted.** A `pending` row has not been
forwarded yet, and the drain does not consult retention: a redacted pending row would still go
out the moment a forwarding target exists, arriving at the subscriber as a batch with an empty
body it cannot tell from a real event. Deleting it is the only option that neither keeps the
content nor invents a delivery. This matters because `pending` is now a state a row can sit in
for a long time: `alarm()` **holds** the drain while no forwarding target is configured (see
[operations.md](./operations.md#incident-runbook)), so held events wait for a receiver — but
only for the content window, like everything else. There is no unbounded held archive.

The relay buffer uses only the split vars; the workspace's conversation window does not apply to
it. Both values are guarded: non-numeric or non-positive values fall back to the defaults instead of
feeding a destructive window (`resolveRetentionDays()` in
`apps/gateway/src/gateway.ts`).

**Bun target (`src/`, kept aside until post-v1)** — still uses a single retention window:
`pruneOldRows()` in `src/delivery/forward.ts` deletes rows in all three tables past
`cfg.RETENTION_DAYS` (Zod default 30, `.env` or process env). It has no redaction step yet;
split retention lands there when the target is retaken.

Pruning cadence: the Workers target sweeps from `alarm()`, throttled to **at most once an
hour** (`SWEEP_INTERVAL_MS`; the alarm itself fires once per ingest, so sweeping on every
invocation meant thousands of full scans a day deleting the same zero rows). The alarm is
re-armed by `setAlarm()` while there is delivery work, so the sweep runs at least as often as
there's pending work — and when the drain is **held** for want of a forwarding target, `alarm()`
re-arms itself on that same hourly cadence for as long as any row is held, so a target-less
WABA that stopped receiving traffic still ages its held content out on time. Nothing is
re-armed once the queue is empty. The same hourly sweep applies the workspace's conversation window
(`pruneConversations()`): it asks the control plane once per sweep, and deletes nothing when the
window is forever or the lookup fails. The Bun target prunes once per delivery-loop tick
(`processPending()`, every 5s via `startDeliveryLoop()`). Both are simple `DELETE`/`UPDATE
... WHERE <timestamp> < cutoff` statements. Workers scans stay inside one WABA's object, and
the Bun scan stays inside one self-hosted instance.

## Media objects (R2, Workers target)

The `MEDIA` R2 bucket (`eccos-media`, EU jurisdiction) holds the WhatsApp media files of the
conversations. Objects live under `waba/<wabaId>/media/<mediaId>`, and `src/media-store.ts` is the
only code that touches them.

- **Download.** The DO's alarm finds the messages that reference a media id with no stored object,
  and downloads up to five per alarm (`src/media-download.ts`). Meta's media ids expire (about 30
  days for live messages, 14 for history), so a download is attempted on the next alarm, not on a
  schedule. A transient failure retries with backoff up to five attempts. An id that Meta no longer
  has, or a file over 100 MB, is given up at once. The bytes stream from Meta into R2 with Meta's
  length and SHA-256, and R2 rejects a write whose bytes do not match.
- **State.** The `media` table in the Durable Object records each id as `failed` (retry at a
  time), `stored`, `gone` (given up), or `erased` (the object is due to be deleted). It holds no
  content, only the id and the attempt bookkeeping.
- **Follows the message.** Media is not on its own clock. When retention prunes the last message
  that references an id, or an erasure removes it, the id is marked `erased` in the same transaction,
  and the object is deleted from R2 on that alarm. An erasure deletes its objects before it returns.
  A failed R2 delete keeps the mark, so the alarm retries it.
- **Serving.** Read only through the `getMedia` RPC, scoped to the owning account, and streamed by
  the dashboard's `/media/<wabaId>/<mediaId>` route to a signed-in member of the workspace.
- **Not yet wired.** `deleteMediaForWaba` purges a whole WABA's prefix, but no WABA-deletion path
  calls it yet, because the gateway has none. A future WABA removal must call it.

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
