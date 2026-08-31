# Deployment (Cloudflare Workers target)

Operational runbook for deploying `apps/gateway/` (and, optionally, `apps/dashboard/`) to
Cloudflare Workers. For the Bun self-host target (Docker), see the root [README](../README.md#-quickstart--self-host-docker)
— it doesn't use Wrangler secrets/rollback and isn't covered here.

## Environment matrix

Everything below is set with `wrangler secret put <NAME>` (secrets) or lives in
`wrangler.jsonc` under `vars` (non-secret config) — never in a committed `.env` file. Secrets
are per-Worker: run `wrangler secret put` from inside the Worker's directory (`apps/gateway` or
`apps/dashboard`).

The Workers target is **account-scoped by default**: there are no global tenant credentials.
Per-WABA Meta credentials (tokens, phone ids), account API keys, and subscriber settings are
**runtime/control-plane/WABA state** — the operator creates the account and registers WABAs through
the bootstrap API or Embedded Signup (`docs/multi-tenancy.md`), and the dashboard rotates
subscriber targets per WABA.

### `apps/gateway` — required app-level secrets

| Secret | Purpose |
|---|---|
| `META_APP_SECRET` | Meta App Secret — verifies inbound `X-Hub-Signature-256` and exchanges OAuth codes server-side |
| `META_WEBHOOK_VERIFY_TOKEN` | Arbitrary string Meta echoes back on the `GET` webhook challenge |
| `ECCOS_ADMIN_API_KEY` | Bootstrap secret for creating accounts, rotating account keys, and registering existing WABAs |
| `ECCOS_TOKEN_ENCRYPTION_KEY` | Key material for the application-layer encryption of the Meta access tokens the control plane stores. At least 32 characters — generate with `openssl rand -base64 32`. See [Meta access token encryption](#meta-access-token-encryption) |

### `apps/gateway` — optional app-level secrets

| Secret | Purpose |
|---|---|
| `META_APP_ID` | Needed only for the Embedded Signup `/connect` flow |
| `META_ES_CONFIG_ID` | Needed only for the Embedded Signup `/connect` flow |

### `apps/gateway` — non-secret vars (`apps/gateway/wrangler.jsonc` → `vars`)

| Var | Default | Purpose |
|---|---|---|
| `META_GRAPH_VERSION` | `v24.0` | Meta Graph API version used for all calls |
| `GATEWAY_PUBLIC_URL` | `""` | Public HTTPS origin used by the dashboard's Embedded Signup button; direct `/connect/start` calls derive the origin from the request |
| `FORWARD_MAX_ATTEMPTS` | `6` | Max delivery attempts before a forwarded event is marked failed |
| `CONTENT_RETENTION_DAYS` | `30` (clamped to 7–90) | Content window: past it, `inbound_events`/`outbound_messages` rows are deleted and terminal `deliveries` rows are redacted to metadata-only |
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

> **WABA routing is mandatory.** The object name is
> `v1:<jurisdiction-or-auto>:waba:<WABA_ID>`. Changing the WABA, jurisdiction, routing version, or
> namespace derives a different Durable Object; Cloudflare does not move SQLite data between
> objects. Export and import existing data before deploying this routing scheme, then verify counts,
> subscriber configuration, and the smoke test.

All stateful HTTP routes are scoped by WABA, and the WABA must belong to the authenticated account
(bearer: a hashed, revocable account API key issued by the control plane):

| Method | Route |
|---|---|
| `POST` | `/v1/wabas/<WABA_ID>/messages` |
| `POST` | `/v1/wabas/<WABA_ID>/phones/<PHONE_NUMBER_ID>/messages` |
| `GET` | `/v1/wabas/<WABA_ID>/templates` |
| `POST` | `/v1/wabas/<WABA_ID>/privacy/erasure` |
| `GET` | `/v1/wabas/<WABA_ID>/export` |

Admin bootstrap endpoints (`POST /v1/accounts`, `POST /v1/accounts/<id>/keys`,
`POST /v1/accounts/<id>/keys/<key>/revoke`, `POST /v1/accounts/<id>/wabas`) use the
`ECCOS_ADMIN_API_KEY`. See [`docs/multi-tenancy.md`](./multi-tenancy.md).

### `apps/dashboard` — non-secret vars (`apps/dashboard/wrangler.jsonc` → `vars`)

| Var | Default | Purpose |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | `""` | Cloudflare Zero Trust team domain. Both this and `ACCESS_AUD` empty allow localhost development only; public requests fail closed |
| `ACCESS_AUD` | `""` | Cloudflare Access application Audience (AUD) tag |

The dashboard has no secrets of its own; it reaches the gateway via the `GATEWAY` service
binding declared in `apps/dashboard/wrangler.jsonc` (RPC only, never public HTTP).
Use one dashboard deployment and one Access application per account. The Access application
identity is resolved server-side and mapped by the gateway control plane; it is not a
browser-supplied selector.

> Configure these non-secret Access vars in `apps/dashboard/wrangler.jsonc` or pass them through
> the dashboard deploy helper. Keep actual secrets out of the repository and set gateway secrets
> with `wrangler secret put`.

## Deploy

```bash
bun install
bun run cf-types   # generate apps/gateway/worker-configuration.d.ts

# one-time / whenever a secret rotates, from apps/gateway:
cd apps/gateway
wrangler secret put META_APP_SECRET
wrangler secret put META_WEBHOOK_VERIFY_TOKEN
wrangler secret put ECCOS_ADMIN_API_KEY
# Meta access token encryption — generate once, then paste the value:
#   openssl rand -base64 32
wrangler secret put ECCOS_TOKEN_ENCRYPTION_KEY
wrangler secret put META_APP_ID     # optional: Embedded Signup /connect
wrangler secret put META_ES_CONFIG_ID # optional: Embedded Signup /connect
# Set GATEWAY_PUBLIC_URL in wrangler.jsonc (or pass --var) for dashboard-initiated Embedded Signup.
cd ../..

bun run deploy     # == cd apps/gateway && wrangler deploy
```

If you also run the operator console:

```bash
cd apps/dashboard && bun run deploy   # == the validated helper
```

Configure `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `apps/dashboard/wrangler.jsonc` before the
production deploy, then open `/setup` once behind the Access policy to create the account.
Set `GATEWAY_PUBLIC_URL` in `apps/gateway/wrangler.jsonc` to the gateway's public HTTPS origin
before using the dashboard's **Connect WhatsApp** action. The button starts the same account-bound
Embedded Signup flow as `POST /connect/start` without exposing an account API key to the browser.

After a fresh gateway deploy, point Meta's webhook subscription at
`https://<worker>.workers.dev/webhooks/meta` (subscribe the `messages` field) and confirm the
Worker's `workers.dev` URL, since the Embedded Signup `/connect` flow and the smoke test both
assume it's reachable.

## Meta access token encryption

Meta business access tokens are the highest-value secret the platform holds: they can send
messages and read templates as a customer's WABA. Cloudflare encrypts Durable Object storage at
rest, but the key belongs to the storage system — so the control plane adds an **application
layer** on top, keyed by a Worker secret the storage system never sees.

- `wabas.meta_access_token` only ever holds an envelope: `ecs1.<base64url iv>.<base64url
  ciphertext>` — AES-256-GCM with a fresh random 96-bit IV per record.
- The AES key is derived with HKDF-SHA-256 from `ECCOS_TOKEN_ENCRYPTION_KEY`; the secret itself is
  never used as a key directly, so any high-entropy value of 32+ characters works.
- The GCM additional data binds each envelope to `<accountId>:<wabaId>`. Moving one account's
  sealed token onto another account's WABA row makes it undecryptable — the account-scoping
  invariant is enforced by the crypto, not only by the queries.
- Sealing happens in exactly one place (`prepareWabas`) and opening in exactly one place
  (`decryptStoredToken`) in `apps/gateway/src/control-plane.ts`; the crypto itself lives in
  `apps/gateway/src/token-crypto.ts`. Tokens are never logged (`LogMeta` allows only ids, counts,
  booleans, and enum-like strings) and never returned to an API caller.

**Fail closed.** A missing, blank, or too-short `ECCOS_TOKEN_ENCRYPTION_KEY` makes every token
read and write throw `Invalid Eccos configuration: ECCOS_TOKEN_ENCRYPTION_KEY is required`. A
record that cannot be opened — wrong key, tampered bytes, or a mismatched account/WABA binding —
throws too. There is no plaintext fallback and no "try plaintext" read path.

**Rotation.** The secret is *not* rotatable in place: re-keying would require re-sealing every
row. Rotating `ECCOS_TOKEN_ENCRYPTION_KEY` today means every registered number must be reconnected
through Embedded Signup. Treat the value as long-lived and back it up wherever your other Worker
secrets are kept — losing it is equivalent to losing every stored token.

### Rows written before token encryption (one-time cut-over)

Rows written by an earlier deploy hold a plaintext token, which by design cannot be read back.
Eccos Cloud is multi-tenant by default and legacy/shadow/dual-path compatibility is forbidden, so
those rows are **not** migrated in place. Instead, every control-plane Durable Object init
quarantines them (idempotently): the WABA is set to `status = 'failed'` with
`provisioning_error = "meta access token is not encrypted; reconnect the number"`, and:

- the dashboard shows the WABA as failed with that message;
- sends, templates, exports and erasures for it return "WABA is not configured" (404);
- the cron reconciler never picks it up, and **Retry** cannot re-queue it.

**Operator action:** reconnect the number through Embedded Signup (dashboard → *Connect
WhatsApp*, or `POST /connect/start`). That upserts the row with a sealed envelope and clears the
quarantine. There is exactly one such number in the current production deployment.

## Post-deploy smoke test

`scripts/smoke.sh` exercises the deployed Worker end-to-end: `/health`, `/ready`, the webhook
`GET` challenge (valid + invalid token), a signed `POST /webhooks/meta` (valid signature, invalid
signature, invalid JSON), and — if `ECCOS_ACCOUNT_API_KEY` is set — an unauthorized
`/v1/wabas/<SMOKE_WABA_ID>/messages` call (the account key is not sent, so the request must be
`401`). The smoke WABA id defaults to a non-sensitive placeholder and does not need to be
registered. It uses `set -euo pipefail` and `curl -f`, so it exits non-zero on the first failed
check — safe to gate a deploy pipeline on its exit code.

```bash
# needs META_APP_SECRET + META_WEBHOOK_VERIFY_TOKEN (from .env, or exported)
# SMOKE_WABA_ID is optional and only labels the signed test webhook; it is ignored unless
# that WABA is registered in the account control plane.
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
rotated `META_APP_SECRET`), fix the secret with `wrangler secret put` instead/in addition.
