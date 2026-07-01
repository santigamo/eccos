# Privacy & data handling

Eccos is **self-hosted, single-tenant** software: the operator who deploys it *is* the data
controller for whatever data it stores. This document describes, based on the actual code, what
personal data Eccos stores, where, for how long, who can see it, and how an operator can inspect,
export, or delete it. It complements `docs/threat-model.md` (attack surfaces / mitigations) and
`SECURITY.md` (vulnerability reporting).

## 1. What data Eccos stores

Eccos is a message *gateway*, not a CRM — it stores just enough to normalize, forward, and retry
delivery of WhatsApp events, plus a short operator-visible history.

| Data | Contains | Table / store | Where |
|---|---|---|---|
| Inbound events | WhatsApp phone number (`from`), Meta message id (`messageId`), **message text** (for `reply` events), timestamps | `inbound_events` | DO SQLite (Workers) / `bun:sqlite` (Bun target) |
| Outbound (sent) messages | Recipient phone number (`to`), the full outbound request JSON (which includes message content you asked Eccos to send), Meta transport message id, send status/error | `outbound_messages` | DO SQLite / `bun:sqlite` |
| Delivery/status/echo events | Meta transport message id, delivery/read/failed status, error codes, or (for `echo`) staff-sent reply text from WhatsApp coexistence | `inbound_events` (statuses share the same table as replies) | DO SQLite / `bun:sqlite` |
| Forwarding queue (`deliveries`) | A JSON copy of the batch of normalized events (`{ events: [...] }`) queued to POST to your subscriber, plus attempt count / last error | `deliveries` | DO SQLite / `bun:sqlite` |
| Onboarding/config metadata | `META_WABA_ID`, `META_PHONE_NUMBER_ID`, `DISPLAY_PHONE_NUMBER`, `CONNECTED_AT`, and (Workers target) an operator-rotatable `SUBSCRIBER_WEBHOOK_URL` / `SUBSCRIBER_SECRET` override | `config` table | DO SQLite only (`apps/gateway/src/gateway.ts`) |

Source of truth for the exact columns: `apps/gateway/src/gateway.ts` (`CREATE TABLE` statements)
for the Workers target, `src/db/client.ts` for the Bun target — the two schemas are effectively
the same content, minus the Workers target's extra `config` table and message-id dedupe indexes.

**No media/attachment bytes are stored.** The normalized event contract
(`packages/core/src/types.ts`, `WhatsAppCallbackEvent`) only carries `text` for `reply`/`echo`
events plus ids/timestamps/error codes — there is no code path that downloads or persists WhatsApp
media (images/audio/documents) today.

**No analytics/telemetry data is collected or sent to any third party by this codebase.** The only
network calls Eccos itself makes are to `graph.facebook.com` (Meta Cloud API) and to the operator's
own `SUBSCRIBER_WEBHOOK_URL`.

## 2. Retention

Both targets now prune `inbound_events`, `outbound_messages`, and terminal (`delivered`/`failed`)
`deliveries` rows older than a configurable retention window — **30 days by default**, adjustable
per target:

- **Workers target (`apps/gateway/`, the active v1 target):** `EccosGateway.alarm()`
  (`apps/gateway/src/gateway.ts`) prunes on every alarm tick:
  ```
  const retentionDays = Number(this.env.RETENTION_DAYS) || DEFAULT_RETENTION_DAYS; // 30
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  DELETE FROM deliveries        WHERE status IN ('delivered','failed') AND created_at  < now - retentionMs
  DELETE FROM inbound_events     WHERE received_at < now - retentionMs
  DELETE FROM outbound_messages  WHERE created_at  < now - retentionMs
  ```
  `RETENTION_DAYS` is set as a plain (non-secret) `vars` entry in `apps/gateway/wrangler.jsonc`
  (default `"30"`); an operator can change it there (or unset it, which falls back to the
  in-code `DEFAULT_RETENTION_DAYS = 30`) and redeploy — no code edit required. Pruning runs as a
  side effect of the alarm that also drains the delivery queue, so if there is no inbound traffic
  (no alarm fires), stale rows can persist slightly past the configured window until the next
  alarm.
- **Bun target (`src/`):** `pruneOldRows()` (`src/delivery/forward.ts`) runs the equivalent three
  `DELETE`s using `cfg.RETENTION_DAYS` (validated by the Zod config schema in `src/config.ts`,
  `z.coerce.number().int().positive().default(30)` — set via the `RETENTION_DAYS` env var / `.env`
  entry). It's invoked at the end of every `processPending()` call, which itself runs both
  immediately after each inbound webhook and on a 5-second interval (`startDeliveryLoop`) — so
  pruning here is more frequent than the Workers target's alarm-driven cadence.

For schema/pruning mechanics and backup/restore guidance in more detail, see
[`docs/data-lifecycle.md`](data-lifecycle.md).

## 3. Data flow / third parties

```
WhatsApp user ──▶ Meta Cloud API ──▶ Eccos (webhook, HMAC-verified) ──▶ your SUBSCRIBER_WEBHOOK_URL
                                            │                                (HMAC-signed, your infra)
                                            ▼
                                     DO SQLite / bun:sqlite
                                     (inbound/outbound/delivery rows, 30-day default on Workers)
                                            │
                                            ▼  (read-only + a few operator actions, via private RPC)
                                   Dashboard Worker ──▶ operator's browser (behind Cloudflare Access)
```

Third parties that see this data, and why:

- **Meta / WhatsApp Cloud API** — the platform Eccos is built on; it necessarily sees every
  message, since it *is* WhatsApp's delivery infrastructure. Governed by Meta's own privacy terms,
  outside this repo's control.
- **Your subscriber webhook** (`SUBSCRIBER_WEBHOOK_URL`) — an operator-configured destination,
  typically the operator's own backend. Eccos forwards normalized events there; what that service
  does with the data is entirely the operator's/integrator's responsibility, not Eccos's.
- **Cloudflare** (Workers target only) — as the hosting platform, Cloudflare's infrastructure
  necessarily processes requests to/from the Worker and Durable Object storage, and (if
  `observability.enabled` in `wrangler.jsonc`) retains Workers Logs of whatever the app
  `console.log`s (see §5 and `SECURITY.md`). No data is deliberately sent to Cloudflare beyond
  what's needed to run the Worker/DO.
- **No other third party is contacted by this codebase** — no analytics SDKs, no error-reporting
  services, no mailing list, no license-check phone-home.

## 4. Operator access to stored data

The only way to *see* stored data (outside direct database access) is the operator console
(`apps/dashboard/`):

- It is reachable only after passing **Cloudflare Access** at the edge, re-verified in-Worker
  (`apps/dashboard/src/access.ts`) — see `docs/threat-model.md` §3.4. Until Access is configured,
  a deployed dashboard has **no** application-level login of its own.
- It renders inbound message text directly: `apps/dashboard/src/routes/inbound.tsx`
  (`inboundSummary()`) reads `ev.text` off the stored payload and displays it in a table row. So
  once someone passes the Access policy, they can read message content for as long as it's
  retained — the Access policy *is* the access-control boundary, there is no additional per-field
  redaction.
- The console **never** displays `SUBSCRIBER_SECRET` or `ECCOS_API_KEY` — `getSubscriberConfig()`
  returns `{ url, hasSecret: boolean }` only (`apps/gateway/src/gateway.ts`), never the secret
  value itself, and no RPC method returns `ECCOS_API_KEY`, `META_ACCESS_TOKEN`, or
  `META_APP_SECRET` at all (confirmed by reading every method on `GatewayApi` in
  `apps/gateway/src/rpc.ts`).
- If you don't configure Cloudflare Access, do not expose the dashboard's `*.workers.dev` URL —
  this is called out explicitly in `apps/dashboard/README.md`.

## 5. Data handling in logs

See also the "Data handling & logging" note in `SECURITY.md`. Concretely:

- **Workers target:** `apps/gateway/src/worker.ts` emits one structured JSON log line per notable
  route outcome via `logEvent()` — `{ time, level, event, correlationId, status, ...meta }`,
  where `correlationId` comes from Cloudflare's own `cf-ray` header (falling back to a random id
  locally). The `meta` field is typed as `LogMeta = Record<string, string | number | boolean |
  null | undefined>` — no nested objects, so a whole request/response body can't be logged by
  accident — and every call site in the file only ever passes ids, byte counts, booleans, or
  enum-like strings (`mode`, `path`, `bodyBytes`, `eventCount`, `messageType`, Meta's own
  `messageId`, `limit`/`count`, or the *names* of missing config keys). None of these calls log a
  phone number, message text, or secret value. This is backed by an explicit in-code comment:
  "Never pass message bodies, full phone numbers, tokens, API keys, or signatures."
- **Bun target:** unchanged from earlier — the entire non-test codebase under `src/` contains
  exactly two `console.*` calls: a boot message in `src/index.ts`
  (`"[eccos] listening on :${cfg.PORT}"`) and a delivery-loop error in `src/delivery/forward.ts`
  (`"[eccos] delivery loop error:", error`) — neither logs message bodies, tokens, or secrets.
- No webhook body, outbound request body, or secret config value is ever passed to `console.*`
  anywhere in `apps/gateway/`, `packages/core/`, or `src/`. The Workers target now enforces this
  with a type-level allowlist (`LogMeta`) at every call site; the Bun target relies on there simply
  being no logging of request/response bodies today. Neither is checked by an automated lint rule
  or test — keep this in mind when adding new logging to either target.

## 6. Delete / export for a single-tenant self-host

Since you (the operator) run the only instance and hold the only credentials, "export" and
"delete" are things *you* do directly against your own infrastructure — there is no multi-tenant
API to build for this.

**Export (Workers target):**
- The operator RPC surface already exposes paginated reads — `listInbound`, `listOutbound`,
  `listDeliveries` (`apps/gateway/src/rpc.ts`, backed by `apps/gateway/src/gateway.ts`), each
  capped at `OPERATOR_MAX_PAGE = 200` rows per call via the `before` cursor (`id <`). Paging
  through these via the dashboard's server functions (`apps/dashboard/src/server/gateway.ts`) or a
  small script bound to `GatewayRPC` is today's mechanism to dump all stored data to JSON.
- There is **no built-in "export all" button or bulk-download endpoint** — this is a gap; if you
  need a full export, page through the above or attach `wrangler dev`/a Worker script directly to
  the `EccosGateway` Durable Object's SQL storage.

**Delete (Workers target):**
- Normal operation already deletes rows automatically after ~30 days (§2).
- There is **no operator-facing "purge now" action** in the current `GatewayApi` — `retryDelivery`
  re-enqueues a delivery, it does not delete anything. To wipe data immediately today, an operator
  must either wait for the next alarm-driven prune, or delete/reset the Durable Object (e.g. via a
  new `wrangler.jsonc` migration that deletes the `EccosGateway` class) — which also removes the
  `config` table (WABA id, phone number id, subscriber config) and requires re-onboarding.

**Export / delete (Bun target):**
- Simpler, because it's a plain file: `DATABASE_PATH` (default `./data/eccos.db`, see
  `.env.example`) is a single SQLite file. Export = copy the file, or `sqlite3 <path>
  ".dump"` / `SELECT * FROM ...`. Delete = stop the process and delete rows (`DELETE FROM
  inbound_events; DELETE FROM outbound_messages; DELETE FROM deliveries;`) or the file itself
  (it's recreated with schema on next boot — see `src/db/client.ts`).

## 7. Recommendations

1. ~~Make retention configurable (`RETENTION_DAYS`) rather than a hardcoded constant.~~ **Done** —
   both targets now read `RETENTION_DAYS` (default 30 days); see §2.
2. ~~Add pruning to the Bun target.~~ **Done** — `pruneOldRows()` now runs on every
   `processPending()` call in `src/delivery/forward.ts`; see §2.
3. Consider a single "export all as JSON" / "purge all now" operator action in the dashboard, so
   operators don't need direct DO/SQLite access for basic data-subject requests. **Not yet
   implemented** — the operator RPC surface (§6) still only offers paginated reads and
   `retryDelivery`, no bulk export or immediate purge.
