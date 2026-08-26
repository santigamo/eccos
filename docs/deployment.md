# Deployment (Cloudflare Workers target)

Operational runbook for deploying `apps/gateway/` (and, optionally, `apps/dashboard/`) to
Cloudflare Workers. For the Bun self-host target (Docker), see the root [README](../README.md#-quickstart--self-host-docker)
— it doesn't use Wrangler secrets/rollback and isn't covered here.

## Environment matrix

Everything below is set with `wrangler secret put <NAME>` (secrets) or lives in
`wrangler.jsonc` under `vars` (non-secret config) — never in a committed `.env` file. Secrets
are per-Worker: run `wrangler secret put` from inside the Worker's directory (`apps/gateway` or
`apps/dashboard`).

### `apps/gateway` — required secrets (all 6 must be set or the Worker fails to boot)

| Secret | Purpose |
|---|---|
| `META_ACCESS_TOKEN` | Permanent System User token (`whatsapp_business_messaging` + `whatsapp_business_management`) |
| `META_PHONE_NUMBER_ID` | The WABA phone number's `phone_number_id` |
| `META_WABA_ID` | WhatsApp Business Account id |
| `META_APP_SECRET` | Meta App Secret — verifies inbound `X-Hub-Signature-256` |
| `META_WEBHOOK_VERIFY_TOKEN` | Arbitrary string Meta echoes back on the `GET` webhook challenge |
| `ECCOS_API_KEY` | Bearer key your apps use to call the scoped Workers send/template routes |

### `apps/gateway` — optional secrets

| Secret | Purpose |
|---|---|
| `SUBSCRIBER_WEBHOOK_URL` | Where normalized inbound/status events are forwarded. Without it, events are stored but not pushed |
| `SUBSCRIBER_SECRET` | HMAC secret for the `X-Eccos-Signature` header on forwarded events |
| `META_APP_ID` | Needed only for the Embedded Signup `/connect` flow |
| `META_ES_CONFIG_ID` | Needed only for the Embedded Signup `/connect` flow |

### `apps/gateway` — non-secret vars (`apps/gateway/wrangler.jsonc` → `vars`)

| Var | Default | Purpose |
|---|---|---|
| `META_GRAPH_VERSION` | `v24.0` | Meta Graph API version used for all calls |
| `FORWARD_MAX_ATTEMPTS` | `6` | Max delivery attempts before a forwarded event is marked failed |
| `CONTENT_RETENTION_DAYS` | `30` (clamped to 7–90) | Content window: past it, `inbound_events`/`outbound_messages` rows are deleted and terminal `deliveries` rows are redacted to metadata-only. The deprecated `RETENTION_DAYS` is still honored as a fallback for this value |
| `DELIVERY_RETENTION_DAYS` | `90` | Delivery-audit window: past it, terminal (`delivered`/`failed`) `deliveries` rows are deleted entirely. See [docs/data-lifecycle.md](./data-lifecycle.md#retention-split-content--delivery-windows) |
| `DO_JURISDICTION` | `eu` in this repo; unset = no jurisdiction | Optional Durable Object jurisdiction: `eu`, `fedramp`, or `fedramp-high` (Cloudflare has no `us` jurisdiction). Unset/empty = no jurisdiction, i.e. the DO is created wherever the first request lands. An invalid value makes every DO-touching request fail with a clear error instead of being silently ignored |

> **CRITICAL — set `DO_JURISDICTION` before you have production data, and never change it
> afterwards.** A jurisdiction produces a *different* `DurableObjectId` for the same WABA routing
> key, which means a **brand-new, empty Durable Object**. Setting or
> changing the jurisdiction on an existing deployment does **not** migrate anything: all stored
> state (inbound/outbound history, the delivery queue, and the `config` table with the connected
> WABA/phone and subscriber settings) stays behind in the old object, invisible to the running
> gateway, and the number must be re-onboarded. If you need EU data residency, set
> `DO_JURISDICTION = "eu"` in `wrangler.jsonc` → `vars` as part of the *first* deploy.

> **Self-hosters upgrading from an earlier version:** `wrangler.jsonc` in this repo ships with
> `DO_JURISDICTION = "eu"`, the value the hosted deployment runs. If your deployment already has
> data and is *not* pinned to the EU, **delete that line before you deploy** — otherwise the
> gateway starts talking to a new, empty Durable Object and your connected number, history, and
> delivery queue are left behind in the old one. A fresh deploy can keep it, change it to another
> supported jurisdiction, or drop it, whichever matches where your data has to live.

> **WABA routing is mandatory.** The object name is
> `v1:<jurisdiction-or-auto>:waba:<WABA_ID>`. Changing the WABA, jurisdiction, routing version, or
> namespace derives a different Durable Object; Cloudflare does not move SQLite data between
> objects. Export and import existing data before deploying this routing scheme, then verify counts,
> subscriber configuration, and the smoke test.

All stateful HTTP routes are scoped by WABA:

| Method | Route |
|---|---|
| `POST` | `/v1/wabas/<WABA_ID>/messages` |
| `GET` | `/v1/wabas/<WABA_ID>/templates` |
| `POST` | `/v1/wabas/<WABA_ID>/privacy/erasure` |

The RPC methods require an explicit WABA ID. The dashboard receives its operator scope through
`GATEWAY_WABA_ID`; it does not infer a tenant or fall back to a global object.

### `apps/dashboard` — non-secret vars (`apps/dashboard/wrangler.jsonc` → `vars`)

| Var | Default | Purpose |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | `""` | Cloudflare Zero Trust team domain. Both this and `ACCESS_AUD` empty = Access gate disabled |
| `ACCESS_AUD` | `""` | Cloudflare Access application Audience (AUD) tag |
| `GATEWAY_WABA_ID` | required | WABA scope passed to every dashboard RPC call; set it to the same WABA configured in the gateway |

The dashboard has no secrets of its own; it reaches the gateway via the `GATEWAY` service
binding declared in `apps/dashboard/wrangler.jsonc` (RPC only, never public HTTP). Configure
`GATEWAY_WABA_ID` alongside the binding; the dashboard never guesses a tenant.

> Do not put real values from the table above in `.env` for a Workers deploy — `.env` is only
> read by the Bun target and by `scripts/smoke.sh` for local/CI checks. Use `wrangler secret put`.

## Deploy

```bash
bun install
bun run cf-types   # generate apps/gateway/worker-configuration.d.ts

# one-time / whenever a secret rotates, from apps/gateway:
cd apps/gateway
wrangler secret put META_ACCESS_TOKEN
wrangler secret put META_PHONE_NUMBER_ID
wrangler secret put META_WABA_ID
wrangler secret put META_APP_SECRET
wrangler secret put META_WEBHOOK_VERIFY_TOKEN
wrangler secret put ECCOS_API_KEY
cd ../..

bun run deploy     # == cd apps/gateway && wrangler deploy
```

If you also run the operator console:

```bash
cd apps/dashboard && bun run deploy   # == wrangler deploy
```

After a fresh gateway deploy, point Meta's webhook subscription at
`https://<worker>.workers.dev/webhooks/meta` (subscribe the `messages` field) and confirm the
Worker's `workers.dev` URL, since the Embedded Signup `/connect` flow and the smoke test both
assume it's reachable.

## Post-deploy smoke test

`scripts/smoke.sh` exercises the deployed Worker end-to-end: `/health`, the webhook `GET`
challenge (valid + invalid token), a signed `POST /webhooks/meta` (valid signature, invalid
signature, invalid JSON), and — if `ECCOS_API_KEY` is set — an unauthorized
`/v1/wabas/<WABA_ID>/messages` call.
It uses `set -euo pipefail` and `curl -f`, so it exits non-zero on the first failed check —
safe to gate a deploy pipeline on its exit code.

```bash
# needs META_APP_SECRET + META_WEBHOOK_VERIFY_TOKEN (from .env, or exported) to build requests
./scripts/smoke.sh https://eccos.<sub>.workers.dev

# equivalently
BASE_URL=https://eccos.<sub>.workers.dev ./scripts/smoke.sh
```

Run it locally against `wrangler dev` (default `http://localhost:8787`, no arg needed) before
deploying, and again against the real `workers.dev` URL right after `bun run deploy`.

## Rollback

Cloudflare Workers keeps prior deployments; rolling back doesn't touch the Durable Object's
stored state (SQLite storage + config), only which Worker code is live.

```bash
cd apps/gateway   # or apps/dashboard, for the console

wrangler deployments list        # find the last-known-good deployment id
wrangler rollback [deployment-id]  # omit the id to roll back to the previous deployment
```

After rolling back, re-run `./scripts/smoke.sh <url>` against the Worker to confirm it's
healthy again. Rollback only affects code — if the incident was caused by a bad secret (e.g. a
rotated `META_ACCESS_TOKEN`), fix the secret with `wrangler secret put` instead/in addition.
