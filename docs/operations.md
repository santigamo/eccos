# Operations (Cloudflare Workers target)

Day-2 operations for `apps/gateway/` running as a Cloudflare Worker: what "healthy" means,
what gets logged, how to look at it, and what to do when something breaks. Written for a
**single-tenant self-host** (one operator, one WABA/phone, one Durable Object) — these are
practical targets to notice and react to problems, not contractual multi-tenant SLAs. For
deploy/rollback mechanics and the environment-variable matrix, see
[docs/deployment.md](./deployment.md); for retention/backup, see
[docs/data-lifecycle.md](./data-lifecycle.md).

## SLOs

| SLO | Target | Why it's set there |
|---|---|---|
| **Webhook ack latency** (`POST /webhooks/meta` response time) | p99 < 500 ms | The handler only verifies the signature, parses the payload, and writes to the Durable Object (`ingest()`) — it never waits on the downstream subscriber forward, which happens later via the DO alarm. Meta expects a fast response and will eventually disable a webhook subscription that times out or errors repeatedly, so this is the one latency budget that really matters. |
| **Forwarding success rate** (`deliveries` reaching `delivered`, not `failed`) | > 99% over a rolling day | A `deliveries` row only reaches `failed` after `FORWARD_MAX_ATTEMPTS` (default 6) exponential-backoff attempts (5s, ×5 per attempt, capped at 1h — see `backoffMs()` in `apps/gateway/src/gateway.ts`). Sustained failures almost always mean the *subscriber* endpoint (`SUBSCRIBER_WEBHOOK_URL`) is down or rejecting requests, not Eccos itself. |
| **Outbound send success rate** (`POST /v1/messages` → `outbound_messages.status`) | > 99% "sent" | A "failed" row means the Meta Graph API call itself failed (bad token, invalid template/number, rate limit) — check `outbound_messages.error` via the dashboard's Outbound page. |
| **Readiness** (`GET /ready`) | 200 except during active incidents | Unlike liveness, a 503 here means "don't route real traffic here" — see below. |

There is no SLA and no automated alerting shipped in this repo (see Follow-ups). These numbers
are what to eyeball in `wrangler tail` / the dashboard, and thresholds worth an operator's
attention if they slip.

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
// 200 — ready
{
  "ok": true,
  "config": {
    "META_ACCESS_TOKEN": true,
    "META_PHONE_NUMBER_ID": true,
    "META_WABA_ID": true,
    "META_APP_SECRET": true,
    "META_WEBHOOK_VERIFY_TOKEN": true,
    "ECCOS_API_KEY": true
  },
  "durableObject": { "ok": true, "error": null }
}

// 503 — not ready (example: a secret is missing)
{
  "ok": false,
  "config": { "...": "...", "ECCOS_API_KEY": false },
  "durableObject": { "ok": true, "error": null }
}
```

Checks two things, and reports **booleans and key names only — never secret values**:

1. **Config presence** — the six required secrets (see `docs/deployment.md`) are non-empty in
   the Worker's environment.
2. **Durable Object reachability** — a cheap existing RPC (`getConfigValue`, a single indexed
   `SELECT`) is called against the singleton `EccosGateway` instance, bounded by a 2s timeout, so
   a stuck/unreachable DO fails the check instead of hanging the probe.

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
  | `webhook_ingested` | `POST /webhooks/meta` | Payload parsed and written to the DO (200) |
  | `v1_unauthorized` | `/v1/*` | Missing/invalid `ECCOS_API_KEY` (401) |
  | `v1_rate_limited` | `POST /v1/messages` | Cloudflare Rate Limiting rejected the request (429) |
  | `outbound_send` | `POST /v1/messages` | Result of a Graph API send (200/400/502) |
  | `templates_list` | `GET /v1/templates` | Result of listing templates (200/502) |
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
`head_sampling_rate: 1` in `wrangler.jsonc` means 100% of invocations are captured — fine at
single-tenant volume; revisit if traffic grows enough to make log volume/cost a concern.

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
   - Expired/rotated `META_ACCESS_TOKEN` → `outbound_send`/`templates_list` lines at 502.
     Fix: `wrangler secret put META_ACCESS_TOKEN` from `apps/gateway` — takes effect immediately,
     no redeploy needed.
   - Wrong or down `SUBSCRIBER_WEBHOOK_URL` → deliveries piling up in `pending`/`failed`.
     Fix: rotate it from the dashboard's Settings page (`setSubscriberConfig`), which updates the
     DO config without a deploy.
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
— alongside `delivered` and still-retrying `pending` rows — until it ages past the retention
window (`RETENTION_DAYS`, default 30; see
[docs/data-lifecycle.md#retention-retention_days](./data-lifecycle.md#retention-retention_days)),
at which point it is hard-deleted with no archive.

**Inspect today:** the dashboard's Deliveries page (`apps/dashboard`, route `/deliveries`) lists
rows with server-side status filtering and pagination, showing `attempts`, `last_error`, and the
stored `payload` per row.

**Replay today:** click "Retry" on a row (works for `failed` *or* already-`delivered` rows, i.e.
it doubles as a manual re-send). That calls `GatewayRPC.retryDelivery(id)` →
`EccosGateway.retryDelivery(id)`, which resets `status='pending'`, `attempts=0`, clears
`last_error`, and re-arms the alarm — the next alarm tick attempts the forward again. This is a
one-row-at-a-time operator action; there is no "retry all failed" bulk action.

**Caveat:** replay only works while the row still exists. Once it's pruned past
`RETENTION_DAYS` there's nothing to replay from inside the running system — the closest thing is
an application-level RPC export as described in
[docs/data-lifecycle.md#backup--restore](./data-lifecycle.md#backup--restore), which this repo
does not ship today.

**Why this is proportionate for now, and where it stops scaling:** this whole mechanism is a
query-and-retry loop against **one** Durable Object (`idFromName("singleton")`) backing the
entire tenant, which is fine at single-operator/single-number volume but becomes the throughput
ceiling and the single point of contention as soon as there's more than one WABA/phone or
meaningfully more traffic. See **eccos-6lv** (shard `EccosGateway` per WABA/phone, drop the
singleton DO) and its dependency **eccos-v80** (multi-tenant: multiple WABAs/phone numbers per
instance) for the roadmap items that would need to land before this DLQ-by-table-row approach
needs to become a real queue with bulk replay.

## Follow-ups

- `scripts/smoke.sh` doesn't yet check `GET /ready` — worth adding once the script itself is
  revisited, so a deploy pipeline can gate on readiness, not just `/health` + individual route
  checks.
- No alerting is wired up (no email/Slack/PagerDuty on sustained `readiness_check` 503s or a
  growing `deliveries.failed` count) — currently that requires an operator to actively watch
  `wrangler tail` or the dashboard.
- Bulk delivery replay ("retry all failed") isn't implemented — see the DLQ section above.
