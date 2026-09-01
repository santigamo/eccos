# Operations (Cloudflare Workers target)

Day-2 operations for `apps/gateway/` running as a Cloudflare Worker: what "healthy" means,
what gets logged, how to look at it, and what to do when something breaks. Written for the
account-scoped Workers product — these are practical targets to notice and react to problems, not
contractual multi-tenant SLAs. The Bun target remains a separate single-tenant deployment. For
deploy/rollback mechanics and the environment-variable matrix, see
[docs/deployment.md](./deployment.md); for retention/backup, see
[docs/data-lifecycle.md](./data-lifecycle.md).

## SLOs

| SLO | Target | Why it's set there |
|---|---|---|
| **Webhook ack latency** (`POST /webhooks/meta` response time) | p99 < 500 ms | The handler only verifies the signature, parses the payload, and writes to the Durable Object (`ingest()`) — it never waits on the downstream subscriber forward, which happens later via the DO alarm. Meta expects a fast response and will eventually disable a webhook subscription that times out or errors repeatedly, so this is the one latency budget that really matters. |
| **Forwarding success rate** (`deliveries` reaching `delivered`, not `failed`) | > 99% over a rolling day | A `deliveries` row only reaches `failed` after `FORWARD_MAX_ATTEMPTS` (default 6) exponential-backoff attempts (5s, ×5 per attempt, capped at 1h — see `backoffMs()` in `apps/gateway/src/gateway.ts`). Sustained failures almost always mean the *subscriber* endpoint (`SUBSCRIBER_WEBHOOK_URL`) is down or rejecting requests, not Eccos itself. |
| **Outbound send success rate** (`POST /v1/wabas/<WABA_ID>/messages` → `outbound_messages.status`) | > 99% "sent" | A "failed" row means the Meta Graph API call itself failed (bad token, invalid template/number, rate limit) — check `outbound_messages.error` via the dashboard's Outbound page. |
| **Readiness** (`GET /ready`) | 200 except during active incidents | Unlike liveness, a 503 here means "don't route real traffic here" — see below. |

There is no SLA and no automated alerting shipped in this repo (see Follow-ups). These numbers
are what to eyeball in `wrangler tail` / the dashboard, and thresholds worth an operator's
attention if they slip.

Each alarm invocation selects at most 40 pending deliveries and forwards them through a pool of
at most six concurrent subscriber requests per Durable Object. Each request has a 5-second
timeout. Delivery rows do not have a FIFO guarantee across the pool; event order within one
forwarded batch is preserved, and subscribers must deduplicate retries with
`x-idempotency-key`.

## Health vs. readiness

Two endpoints, deliberately different in cost and meaning:

### `GET /health` — liveness

```json
{ "ok": true, "name": "eccos", "version": "0.1.0" }
```

Always 200 while the Worker process is alive. No I/O, no config check, no Durable Object call —
this is what a load balancer / uptime pinger should hit at a tight interval. It tells you "the
Worker is running," nothing more; it will happily return `ok:true` even with a missing secret or
an unreachable Durable Object.

### `GET /ready` — readiness

```json
// 200 — ready (app secrets present and the control plane reachable)
{
  "ok": true,
  "config": {
    "META_APP_SECRET": true,
    "META_WEBHOOK_VERIFY_TOKEN": true
  },
  "durableObject": { "ok": true, "error": null }
}

// 503 — not ready (example: a secret is missing)
{
  "ok": false,
  "config": { "META_APP_SECRET": false, "META_WEBHOOK_VERIFY_TOKEN": true },
  "durableObject": { "ok": true, "error": null }
}
```

Checks two things, and reports **booleans and key names only — never secret values**:

1. **Config presence** — the two app-level webhook secrets (`META_APP_SECRET` and
   `META_WEBHOOK_VERIFY_TOKEN`) are non-empty in the Worker's environment. The bootstrap key is
   not part of this probe because an empty account registry is a valid freshly deployed state;
   without `ECCOS_ADMIN_API_KEY`, provisioning endpoints remain unusable until it is configured.
2. **Durable Object reachability** — a cheap control-plane health RPC is called against the active
   `EccosControlPlane` instance, bounded by a 2s timeout, so a stuck/unreachable DO fails the
   check instead of hanging the probe.

Returns `200` only when both pass, `503` otherwise. Use this for post-deploy verification, and as
the "can it actually serve traffic" signal in any external uptime/synthetic check — `/health`
alone can't tell you that.

## Structured logs

Route handlers in `apps/gateway/src/worker.ts` emit one JSON line per notable outcome via
`console.log`, which Cloudflare Workers Logs (`observability.enabled: true` in
`apps/gateway/wrangler.jsonc`) captures automatically — no extra shipping/agent needed.

Every line has the same envelope:

```json
{ "time": "2026-07-01T12:00:00.000Z", "level": "info", "event": "webhook_ingested", "correlationId": "8f2...", "status": 200, "eventCount": 1, "received": 1 }
```

- **`correlationId`** — the incoming `cf-ray` header (ties the line back to the same edge
  request Cloudflare's own dashboards use), or a generated UUID for local/dev requests where
  that header is absent.
- **`level`** — derived from `status` (`>=500` → `error`, `>=400` → `warn`, else `info`).
- **`event`** — one of:

  | Event | Route | Meaning |
  |---|---|---|
  | `webhook_verify` | `GET /webhooks/meta` | Meta's subscription-verify challenge, accepted (200) or rejected (403) |
   | `webhook_signature_invalid` | `POST /webhooks/meta` | `X-Hub-Signature-256` failed to verify (401) |
   | `webhook_invalid_json` | `POST /webhooks/meta` | Body didn't parse as JSON (400) |
   | `webhook_misconfigured` | `POST /webhooks/meta` | Required webhook configuration was unavailable; payload acknowledged without ingestion (200) |
   | `webhook_ignored` | `POST /webhooks/meta` | Valid payload contained no registered active WABA/phone event (200) |
   | `webhook_ingested` | `POST /webhooks/meta` | Payload parsed and written to the DO (200) |
   | `unhandled_error` | Any route | Unexpected route failure; webhook requests are acknowledged (200), other requests fail (500) |
   | `v1_unauthorized` | `/v1/*` | Missing/invalid account or admin key (401) |
   | `v1_rate_limited` | `POST /v1/wabas/<WABA_ID>/messages` | Cloudflare Rate Limiting rejected the request (429) |
   | `outbound_send` | `POST /v1/wabas/<WABA_ID>/messages` | Result of a Graph API send (200/400/502) |
   | `templates_list` | `GET /v1/wabas/<WABA_ID>/templates` | Result of listing templates (200/502) |
   | `account_created` | `POST /v1/accounts` | Admin-created account (201) |
   | `key_issued` | `POST /v1/accounts/<accountId>/keys` | Account API key issued (201); only key metadata is logged |
   | `key_revoke` | `POST /v1/accounts/<accountId>/keys/<keyId>/revoke` | Account API key revoked (200/404) |
   | `waba_provisioning_started` | `POST /v1/accounts/<accountId>/wabas` | WABA registration queued for provisioning (202) |
   | `waba_reconcile` | `POST /v1/accounts/<accountId>/wabas/<WABA_ID>/reconcile` | Provisioning reconciliation result (200/404/502) |
   | `privacy_erasure` | `POST /v1/wabas/<WABA_ID>/privacy/erasure` | Phone erasure result (200/400) |
   | `export` | `GET /v1/wabas/<WABA_ID>/export` | Account-scoped data export result (200) |
   | `readiness_check` | `GET /ready` | Result of the readiness probe (200/503) |

- Everything else in a line is **safe metadata only** — ids (`messageId`), counts
  (`eventCount`, `received`, `count`), booleans (`configOk`, `doOk`), and enum-like strings
  (`messageType`, `path`, key names in `missingConfig`). Message bodies, full phone numbers,
  tokens, API keys, and signatures are never logged — see CLAUDE.md's "never log or write
  secrets" rule.

### Viewing logs

```bash
# live tail, from apps/gateway/
wrangler tail                       # human-readable
wrangler tail --format=json | jq .  # one JSON object per line, pipeable

# filter to one request's story
wrangler tail --format=json | jq 'select(.correlationId=="<id>")'
```

Or: Cloudflare dashboard → Workers & Pages → `eccos` → Logs (Real-time Logs / Workers Logs).
`head_sampling_rate: 1` in `wrangler.jsonc` means 100% of invocations are captured — appropriate
for the current early volume; revisit if traffic grows enough to make log volume/cost a concern.

## Incident + rollback runbook

1. **Detect.** `/health` failing means the Worker itself is down (rare — Cloudflare's platform,
   not your code, usually). `/ready` returning 503, a run of `level:"error"`/`"warn"` lines in
   `wrangler tail`, or the dashboard home page showing `health: "degraded"`/`"unhealthy"`
   (from `GatewayRPC.getStatus()`, based on failed/pending delivery counts) are the realistic
   signals.
2. **Triage.**
   - `curl <worker>/ready` — tells you immediately whether it's a **config** problem (a
     `config.*` key is `false`) or a **Durable Object** problem (`durableObject.ok: false`,
     with `durableObject.error` giving the timeout/exception message).
   - `wrangler tail --format=json`, filtered by `event`/`status`/`correlationId`, to see which
     route and how often.
   - Dashboard "Deliveries" page, filtered to `status=failed`, to see `last_error` per row if
     forwarding is the symptom.
3. **Common causes & fixes.**
   - Expired/rotated per-WABA Meta access token → `outbound_send`/`templates_list` lines at 502.
     Fix: re-register the WABA through the admin bootstrap API (or reconnect it through
     `/connect`) so the control-plane credential is replaced; no Worker redeploy is needed.
   - Wrong or down per-WABA subscriber URL → deliveries piling up in `pending`/`failed`.
     Fix: rotate it from the dashboard's Settings page (`setSubscriberConfig`), which updates the
     WABA's DO config without a deploy.
   - Meta silently unsubscribed the webhook (e.g. after too many slow/erroring responses) →
     inbound events stop arriving with no error on the Eccos side. Fix: use the dashboard's
     "Resubscribe" action (`GatewayRPC.resubscribe()`), or re-subscribe manually in Meta's App
     Dashboard.
4. **Roll back** if a recent deploy is the cause:
   ```bash
   cd apps/gateway
   wrangler deployments list
   wrangler rollback [deployment-id]   # omit to roll back to the previous deployment
   ```
   Full mechanics and caveats in [docs/deployment.md#rollback](./deployment.md#rollback) — code
   only, the Durable Object's stored state (config, deliveries, inbound/outbound logs) is
   untouched by a rollback.
5. **Confirm recovery.** Re-run `./scripts/smoke.sh <url>`, check `GET /ready` is back to 200,
   and watch the Deliveries page drain (`pending` count falling, `failed` count not growing).

## DLQ / manual replay

There is no separate dead-letter queue. A delivery that exhausts `FORWARD_MAX_ATTEMPTS` (default
6) just sits as a `deliveries` row with `status='failed'` in the same Durable Object SQLite table
— alongside `delivered` and still-retrying `pending` rows. Past the content retention window
(`CONTENT_RETENTION_DAYS`, default 30) its `payload` is redacted — metadata (`attempts`,
`last_error`, timestamps) survives but the row can no longer be replayed — and past the delivery
window (`DELIVERY_RETENTION_DAYS`, default 90) the row is hard-deleted with no archive; see
[docs/data-lifecycle.md](./data-lifecycle.md#retention-split-content--delivery-windows).

**Inspect today:** the dashboard's Deliveries page (`apps/dashboard`, route `/deliveries`) lists
rows with server-side status filtering and pagination, showing `attempts`, `last_error`, and the
stored `payload` per row.

**Replay today:** click "Retry" on a row (works for `failed` *or* already-`delivered` rows, i.e.
it doubles as a manual re-send). That calls `GatewayRPC.retryDelivery(id)` →
`EccosGateway.retryDelivery(id)`, which resets `status='pending'`, `attempts=0`, clears
`last_error`, and re-arms the alarm — the next alarm tick attempts the forward again. This is a
one-row-at-a-time operator action; there is no "retry all failed" bulk action.

**Caveat:** replay only works while the row still holds its payload. Once the content window
(`CONTENT_RETENTION_DAYS`) redacts it — or an erasure request empties it — `retryDelivery`
refuses the row, and once it's deleted past `DELIVERY_RETENTION_DAYS` there's nothing left at
all to replay from inside the running system — the closest thing is
an application-level RPC export as described in
[docs/data-lifecycle.md#backup--restore](./data-lifecycle.md#backup--restore), which this repo
does not ship today.

**Why this is proportionate for now, and where it stops scaling:** each WABA owns its query-and-
retry loop in a separate Durable Object. This removes cross-tenant contention, while the per-WABA
10 GB storage ceiling and bounded six-request retry pool remain. Follow the export and deployment guidance
in [docs/deployment.md](./deployment.md) before adding a WABA with existing data.

## A connected account with no phone number

Embedded Signup v4 lets a customer finish the flow with a verified number, an unverified one, or
**none at all**. A WABA that arrives with none is connected and subscribed but has nothing to send
from, so it stays `pending` with:

    connected, but this WhatsApp Business account has no business phone number yet; add one in
    WhatsApp Manager and Eccos will pick it up

This is not a fault and there is nothing for an operator to fix. Each provisioning attempt re-reads
`GET /<WABA_ID>/phone_numbers` and adopts a number the moment one exists, so the customer adding it
is enough.

**This one state is exempt from the six-attempt cap.** Every other retryable failure gives up after
six tries (~65 minutes) and goes `failed`; this one keeps polling at the capped one-hour backoff for
as long as the WABA is `pending`, because a customer who finishes the flow in the evening and adds
their number the next morning is the expected path, not an edge case — and there would be no way
back if it stopped, since the cron only claims `pending` rows and **Re-check** is a per-row button
while rows are built from phone numbers. A WABA with no numbers has no row and so no button.

The cost, so it is on the record: an onboarding that is abandoned for good keeps costing one
`subscribed_apps` call (idempotent) and one `phone_numbers` read per hour until the WABA is removed.
The cron's batch is ordered by due time, so an hourly row cannot starve a fresh one.

The console shows the account under **"Waiting on a phone number"** — it has no rows in the numbers
table, because the table is built from phone numbers. A zero-phone WABA that failed for some *other*
reason (Meta refusing the subscription, say) appears under **"Connection failed"** with its error
instead, and that one does need reconnecting.

An **unverified** number is different: it registers and provisions normally, and only fails when
something tries to send. Eccos does not call `POST /<PHONE_NUMBER_ID>/register` yet, so a number the
customer never verified surfaces as an error on the outbound message.

## Coexistence sync failures (eccos-vss)

A number connected through `/connect` is *recorded as* a **coexistence** onboarding: it is meant to
stay on the customer's WhatsApp Business app. Meta requires the Tech Provider to initiate contacts
synchronisation and — **within 24 hours of the handoff** — message-history synchronisation, and
allows **each of them exactly once per phone number**. Both rules have the same remedy when broken,
and it is not a retry: the customer must be offboarded and complete Embedded Signup again.

> **The recorded type is a request, not a fact.** `/connect` asks Meta for the WhatsApp Business app
> flow by putting `featureType` in `extras` on the OAuth dialog URL, and `extras` is documented only
> as an `FB.login()` option — verified on 2026-09-01 that the dialog ignores it and runs the
> ordinary Cloud API flow instead. So before spending either once-only sync, the saga reads back
> what Meta actually did with `GET /<PHONE_NUMBER_ID>?fields=is_on_biz_app,platform_type` and issues
> only when both `is_on_biz_app` is `true` and `platform_type` is `CLOUD_API`, for **every** number
> the handoff registered. Anything else — including a field Meta did not return — declines the sync,
> because the one thing that must never happen is spending a once-only call on a number that did not
> need it.

Eccos runs this as a step of the provisioning saga, so a WABA that has not had it done never reads
as `active`. Two failures are terminal by design and need a human:

| `provisioningError` on the WABA | What happened | What to do |
| --- | --- | --- |
| `coexistence message-history sync window expired (24h); …` | The 24-hour window closed with the sync not initiated. Meta would answer `2593108`, so Eccos does not even send it. | Offboard the customer and re-run Embedded Signup. The reconnect starts a fresh window automatically. |
| `coexistence sync was issued but not confirmed by Meta …` | A sync request was sent and no success came back. It may well have been processed, so Eccos will **not** send it again — a duplicate is Meta's `2593107` and breaks the onboarding permanently. | Offboard the customer and re-run Embedded Signup. Do **not** look for a retry button; there deliberately isn't one. |

Pressing "re-check" on such a WABA is safe — it re-runs the saga, which refuses to re-issue a spent
sync and lands back on the same message. Only a genuinely new Embedded Signup handoff clears it.

### A number that turned out not to be a coexistence number

A third outcome is **not** a failure and needs no remedy. When the verification above says the
number is an ordinary Cloud API number, no sync is issued, the WABA provisions **`active`**, and its
coexistence status becomes `not_coexistence`. The console says so under the numbers table ("No
WhatsApp Business app history"). The number sends and receives normally; what it does not have is
the customer's existing WhatsApp Business app chats and contacts, and it never will without a fresh
onboarding that Meta actually runs as coexistence. Nothing here should be retried or offboarded —
tell the customer, and do not leave anyone waiting for history that is not coming.

A WABA in this state never ages into `expired`: it owes nothing, so the 24-hour clock has nothing
to run out on.

Where the state lives, on the control plane's `wabas` row: `onboarding_type` (what was requested),
`coexistence_verified_type` (what Meta reported, null until it has been read),
`coexistence_sync_status` (`not_applicable` / `pending` / `initiated` / `unconfirmed` /
`not_coexistence` / `expired`), `coexistence_sync_deadline_at`, `contacts_sync_started_at` +
`contacts_sync_request_id`, and `history_sync_started_at` + `history_sync_request_id`. The `*_started_at` columns are written
*before* each request goes out — that is what makes the once-only rule safe — and the request ids
are Meta's support references, worth quoting in a support ticket (Question Topic "WABiz: Cloud API",
Request Type "Coexistence Data Synchronization APIs and Webhooks").

Note that a 200 on the history sync means Meta *accepted* the request, not that history will
arrive: a business that turned history sharing off surfaces later as `2593109` on the `history`
webhook.

## Follow-ups

- No alerting is wired up (no email/Slack/PagerDuty on sustained `readiness_check` 503s or a
  growing `deliveries.failed` count) — currently that requires an operator to actively watch
  `wrangler tail` or the dashboard.
- Bulk delivery replay ("retry all failed") isn't implemented — see the DLQ section above.
- The coexistence sync state above is not surfaced in the operator console beyond
  `provisioningError`: the deadline and the per-sync request ids exist on the WABA row but are not
  in the `@eccos/gateway-contract` RPC surface yet, so there is no "12h left to sync" indicator.
