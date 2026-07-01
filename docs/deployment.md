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
| `ECCOS_API_KEY` | Bearer key your apps use to call `POST /v1/messages` / `GET /v1/templates` |

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

### `apps/dashboard` — non-secret vars (`apps/dashboard/wrangler.jsonc` → `vars`)

| Var | Default | Purpose |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | `""` | Cloudflare Zero Trust team domain. Both this and `ACCESS_AUD` empty = Access gate disabled |
| `ACCESS_AUD` | `""` | Cloudflare Access application Audience (AUD) tag |

The dashboard has no secrets of its own; it reaches the gateway via the `GATEWAY` service
binding declared in `apps/dashboard/wrangler.jsonc` (RPC only, never public HTTP) — nothing to
configure at deploy time beyond that binding already pointing at the gateway Worker name (`eccos`).

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
signature, invalid JSON), and — if `ECCOS_API_KEY` is set — an unauthorized `/v1/messages` call.
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
