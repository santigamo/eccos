# Privacy & data handling

Eccos can run as self-hosted single-tenant software or as an account-scoped Workers deployment.
The operator is the data controller for the data it stores, and a Cloud deployment is responsible
for isolating each account's WABAs and phones. This document describes, based on the actual code,
what personal data Eccos stores, where, for how long, who can see it, and how an operator can
inspect, export, or delete it. It complements `docs/threat-model.md` (attack surfaces / mitigations)
and `SECURITY.md` (vulnerability reporting).

## 1. What data Eccos stores

Eccos is a message *gateway*, not a CRM — it stores just enough to normalize, forward, and retry
delivery of WhatsApp events, plus a short operator-visible history.

| Data | Contains | Table / store | Where |
|---|---|---|---|
| Inbound events | Business phone number id, WhatsApp phone number (`from`), Meta message id (`messageId`), **message text** (for `reply` events), timestamps | `inbound_events` | DO SQLite (Workers) / `bun:sqlite` (Bun target) |
| Outbound (sent) messages | Business phone number id, recipient phone number (`to`), the full outbound request JSON (which includes message content you asked Eccos to send), Meta transport message id, send status/error | `outbound_messages` | DO SQLite / `bun:sqlite` |
| Delivery/status/echo events | Business phone number id when Meta supplies it, Meta transport message id, delivery/read/failed status, error codes, or (for `echo`) staff-sent reply text from WhatsApp coexistence | `inbound_events` (statuses share the same table as replies) | DO SQLite / `bun:sqlite` |
| Forwarding queue (`deliveries`) | Business phone number id and a JSON copy of the batch of normalized events (`{ events: [...] }`) queued to POST to your subscriber, plus attempt count / last error | `deliveries` | DO SQLite / `bun:sqlite` |
| Onboarding/config metadata | Account/WABA/phone ownership, WABA callback URL, and Meta access token; plus `META_WABA_ID`, `META_PHONE_NUMBER_ID`, `DISPLAY_PHONE_NUMBER`, `CONNECTED_AT`, and (Workers target) an operator-rotatable subscriber URL/secret | Control-plane `accounts`/`wabas`/`phones` tables plus the WABA `config` table | DO SQLite (`apps/gateway/src/control-plane.ts`, `apps/gateway/src/gateway.ts`) |

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

Both targets prune old rows on an ongoing basis; the Workers target uses a **split** retention
model so message content ages out before the operational audit trail does:

- **Workers target (`apps/gateway/`, the active v1 target):** `EccosGateway.alarm()`
  (`apps/gateway/src/gateway.ts`) sweeps with two windows:
  - **`CONTENT_RETENTION_DAYS`** (default **30**, clamped to **7–90**): past it, `inbound_events`
    and `outbound_messages` rows are **deleted**, and terminal (`delivered`/`failed`)
    `deliveries` rows are **redacted in place** — `payload` (the stored copy of the forwarded
    event batch, i.e. the message content) is emptied while `id`, `status`, `attempts`,
    `last_error`, `next_attempt_at`, `created_at`, `finished_at`, and the business
    `phone_number_id` survive. A `deliveries` row still **`pending`** past this window is
    **deleted outright**, not redacted: it was never forwarded, so redacting it would leave a
    row that still drains later and reaches the subscriber as an empty body. This covers events
    the gateway is *holding* because no forwarding target has been configured yet — the hold
    lasts a retention window, not forever.
    After this window no message content or contact phone number remains anywhere in storage,
    whether or not it was ever forwarded.
  - **`DELIVERY_RETENTION_DAYS`** (default **90**): past it, the metadata-only terminal
    `deliveries` rows are deleted entirely.

  Both are plain (non-secret) `vars` entries in `apps/gateway/wrangler.jsonc`; the Workers target
  uses only the split vars and has no tenant-wide retention setting. All values are guard-railed
  (`resolveRetentionDays()`): invalid values fall back to the defaults rather than feeding a
  destructive window. The sweep runs from the alarm that also drains the delivery queue,
  throttled to at most once an hour; while the drain is held for want of a forwarding target the
  alarm re-arms itself on that same hourly cadence so held content still ages out on a WABA with
  no traffic. A Durable Object with nothing pending arms nothing, so stale rows there can persist
  slightly past the configured window until the next alarm.
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
- The console **never** displays `SUBSCRIBER_SECRET` or an account API key — `getSubscriberConfig()`
  returns `{ url, hasSecret: boolean, lastForward }` only (`apps/gateway/src/gateway.ts`), never the
  secret value itself, and no RPC method returns an API key, `META_ACCESS_TOKEN`, or
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

## 6. Delete / export

On the Workers target every export and erasure request is checked against the authenticated
account's WABA registry before the data-plane object is touched (the Bun target has a single
operator account).

**Export (Workers target):**
- `GET /v1/wabas/<WABA_ID>/export` returns the full retained snapshot of inbound, outbound, delivery,
  and non-secret config rows. It requires the owning account key. The RPC surface also exposes
  `exportData()` for the private dashboard binding.
- The paginated `listInbound`, `listOutbound`, and `listDeliveries` methods remain available for
  cursor-based reads. Export rows include the business `phone_number_id` when the event or send had
  a known phone.

**Delete (Workers target):**
- Normal operation already removes message content automatically after ~30 days and the
  remaining delivery metadata after ~90 (§2).
- <a id="erasure"></a>**Per-number erasure (GDPR Art. 17)** — `EccosGateway.eraseByPhone(phone)`,
  exposed as `GatewayRPC.eraseByPhone()` (operator RPC, service binding only) and as
  `POST /v1/wabas/<WABA_ID>/privacy/erasure` with body `{"phone": "+34..."}` behind the account
  API-key gate (the number travels in the body, never the URL, so it can't leak into request logs).
  It removes every stored trace of one phone number and returns per-table counts as evidence of the
  erasure. How it matches:
  - the input and stored numbers are normalized to digits-only and compared for exact equality —
    pass the full international number (`+34 600 00 00 00`, `34600000000`, … all match the same
    stored contact; a national short form does not);
  - `outbound_messages` rows are matched on `recipient` and deleted; `inbound_events` rows are
    matched on the `from`/`to` inside the normalized event JSON (replies/echoes) and deleted;
  - status events (`delivered`/`read`/`failed`) carry only a Meta message id, no phone — they are
    linked through the message ids of the deleted outbound/echo rows and deleted too;
  - `deliveries` batches (which can mix several numbers' events) are rewritten without the
    erased number's events; a batch left empty is redacted in place when terminal (the
    metadata row remains as erasure evidence) or deleted when still pending.

  Known limitations: (a) status events whose outbound/echo row already aged out of retention
  can no longer be linked to the number — by then they contain no phone number or content,
  only a Meta message id; (b) a phone number quoted inside the free text of *another*
  contact's message is not matched (that row is the other data subject's content); (c) erasure
  covers this gateway's storage only — events already forwarded to your
  `SUBSCRIBER_WEBHOOK_URL` live in your downstream system and must be erased there separately.
- Beyond that there is **no full "purge everything now" action** in `GatewayApi`. To wipe the
  entire store immediately, an operator must either wait for the alarm-driven prune, or
  delete/reset the Durable Object (e.g. via a new `wrangler.jsonc` migration that deletes the
  `EccosGateway` class) — which also removes the `config` table (WABA id, phone number id,
  subscriber config) and requires re-onboarding.
- Since this doc was written, the operator console gained the Webhooks page
  (`apps/dashboard/src/routes/webhooks.tsx`), which reads `getSubscriberConfig()` and calls
  `setSubscriberConfig()` / `resubscribe()`. `getSubscriberConfig()` still never returns the
  secret value — `hasSecret` is its only trace, and the console can reveal only a secret it has
  not yet saved.
- **Cloud → self-host:** the operator surface's paginated reads are also the migration
  mechanism. What transfers, what does not, and the full cutover steps are documented on
  [eccos.chat/migrate](https://eccos.chat/migrate) (guide source:
  `apps/site/src/page-content/migrate.html`) — the short version: no Meta token, operator secret,
  `DurableObjectId`/Alarm, or Embedded Signup OAuth connection is ever exportable; re-create
  them in the new deployment and decommission Cloud only after an end-to-end smoke test.

**Export / delete (Bun target):**
- Simpler, because it's a plain file: `DATABASE_PATH` (default `./data/eccos.db`, see
  `.env.example`) is a single SQLite file. Export = copy the file, or `sqlite3 <path>
  ".dump"` / `SELECT * FROM ...`. Delete = stop the process and delete rows (`DELETE FROM
  inbound_events; DELETE FROM outbound_messages; DELETE FROM deliveries;`) or the file itself
  (it's recreated with schema on next boot — see `src/db/client.ts`).

## 7. Recommendations

1. ~~Make retention configurable (`RETENTION_DAYS`) rather than a hardcoded constant.~~ **Done** —
   and since split into `CONTENT_RETENTION_DAYS` (30, clamped 7–90) + `DELIVERY_RETENTION_DAYS`
   (90) on the Workers target, with payload redaction in between; see §2.
2. ~~Add pruning to the Bun target.~~ **Done** — `pruneOldRows()` now runs on every
   `processPending()` call in `src/delivery/forward.ts`; see §2. (Still the single
   window — split retention lands when the Bun target is retaken post-v1.)
3. ~~Support data-subject erasure requests without direct DO/SQLite access.~~ **Done** —
   `eraseByPhone` (RPC + `POST /v1/wabas/<WABA_ID>/privacy/erasure`) erases one number and returns evidence
   counts; see §6 — though the operator console has no per-number erasure UI yet (the dashboard
   currently exposes the subscriber-target settings and resubscribe only). Remaining: a single
   "export all as JSON" / "purge all now" operator action — the RPC surface still only offers
   paginated reads, `retryDelivery`, and `eraseByPhone`, no bulk export or full immediate purge.
   Cloud → self-host cutover is guided by [eccos.chat/migrate](https://eccos.chat/migrate).
