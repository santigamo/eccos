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
| `GATEWAY_PUBLIC_URL` | `""` | Public HTTPS origin used by the dashboard's Embedded Signup button. It becomes the OAuth `redirect_uri` as `<origin>/connect`, which Meta matches **exactly** against the app's Valid OAuth Redirect URIs — changing it without registering the new URI first breaks Embedded Signup. Origin only (scheme + host + optional port), HTTPS except on localhost. Direct `POST /connect/start` calls ignore it and derive the origin from the request |
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

### `apps/dashboard` — required app-level secrets

| Secret | Purpose |
|---|---|
| `BETTER_AUTH_SECRET` | Better Auth signing secret (at least 32 characters). A public (https) deployment refuses to boot without it |
| `RECCADO_API_KEY` | Transactional email provider key (reccado). Absent = the development console sender, which logs instead of sending — never set that way in production. See [docs/auth-email-delivery.md](./auth-email-delivery.md) |

### `apps/dashboard` — non-secret vars (`apps/dashboard/wrangler.jsonc` → `vars`)

| Var | Default | Purpose |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | `""` | Cloudflare Zero Trust team domain. Both this and `ACCESS_AUD` empty allow localhost development only; public requests fail closed |
| `ACCESS_AUD` | `""` | Cloudflare Access application Audience (AUD) tag |
| `BETTER_AUTH_URL` | canonical origin | Optional explicit base URL; defaults to `https://app.eccos.chat` |
| `RECCADO_BASE_URL` | *(none)* | Provider origin for transactional email. **Configuration, not a constant**: the provider's custom domain is behind Cloudflare Access and answers only on its `workers.dev` host today, and the contract is identical on both. Required whenever `RECCADO_API_KEY` is set — the adapter fails closed without it |
| `RECCADO_MAILBOX_ID` | *(none)* | Mailbox the transactional messages are sent from; it also determines the sending identity (there is no `MAIL_FROM`). Required whenever `RECCADO_API_KEY` is set |

The dashboard reaches the gateway via the `GATEWAY` service binding declared in
`apps/dashboard/wrangler.jsonc` (RPC only, never public HTTP); its own secrets are the two
above.
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
# one-time / whenever a secret rotates, from apps/dashboard:
cd apps/dashboard
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put RECCADO_API_KEY
# Set RECCADO_BASE_URL and RECCADO_MAILBOX_ID in wrangler.jsonc → vars (or pass
# them through the deploy helper). The adapter fails closed if the key is set
# and either var is missing.
cd ../..

cd apps/dashboard && bun run deploy   # == the validated helper
```

Configure `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `apps/dashboard/wrangler.jsonc` before the
production deploy, then open `/setup` once behind the Access policy to create the account.
Set `GATEWAY_PUBLIC_URL` in `apps/gateway/wrangler.jsonc` to the gateway's public HTTPS origin
before using the dashboard's **Connect WhatsApp** action. The button starts the same account-bound
Embedded Signup flow as `POST /connect/start` without exposing an account API key to the browser.

After a fresh gateway deploy, point Meta's webhook subscription at
`<gateway-origin>/webhooks/meta` (subscribe the `messages` field) and confirm that origin is
reachable, since the Embedded Signup `/connect` flow and the smoke test both assume it is. On a
brand-new deploy the origin is the `workers.dev` URL; for anything a Meta reviewer will look at,
put the gateway on a custom domain under the app's declared application domain first — see
[Cutover](#cutover--moving-the-meta-facing-origin-to-a-custom-domain).

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
./scripts/smoke.sh https://api.eccos.chat

# equivalently
BASE_URL=https://api.eccos.chat ./scripts/smoke.sh

# the workers.dev origin, while it is still enabled
./scripts/smoke.sh https://eccos.<sub>.workers.dev
```

`BASE_URL` is the only thing that binds the script to a host, so the same script proves any
origin. Run it locally against `wrangler dev` (default `http://localhost:8787`, no arg needed)
before deploying, and again against the real public origin right after `bun run deploy`. While
both origins are live, run it against **each** — that is what proves the custom domain reaches the
same Worker before Meta is pointed at it.

## Cutover — moving the Meta-facing origin to a custom domain

The gateway Worker is the only Eccos surface Meta talks to, and it talks to it three ways: the
webhook callback (`POST/GET /webhooks/meta`), the Embedded Signup OAuth callback (`GET /connect`,
a top-level browser navigation), and the account-scoped `/v1` API customers integrate against. A
deploy that has never had a custom domain serves all three on `workers.dev`, which contradicts the
`eccos.chat` application domain the Meta app declares — an App Review reviewer sees a declared
domain and a set of working endpoints that disagree. This runbook moves them to
**`api.eccos.chat`** without an outage.

The order below is the point of the runbook: **the new origin is proven before Meta is pointed at
it, and `GATEWAY_PUBLIC_URL` moves only after the matching redirect URI is registered.** Every
step is additive — the `workers.dev` origin keeps working until the very last one — so any step
can be abandoned without breaking a live webhook.

### What is pinned to the origin

| Surface | Where it is configured | Breaks if the origin changes under it |
|---|---|---|
| Webhook callback | Meta panel → WhatsApp → Configuration → Callback URL | Yes — Meta stops delivering, and repeated failures can disable the subscription |
| Embedded Signup callback (browser) | Meta panel → Valid OAuth Redirect URIs | Yes — Meta rejects the `redirect_uri` and the OAuth dialog errors out |
| Embedded Signup from the dashboard button | `GATEWAY_PUBLIC_URL` (gateway `vars`) | Yes — it sends `<origin>/connect` as `redirect_uri`; it must already be registered |
| Embedded Signup from `POST /connect/start` | Nothing — derived from the request origin | No — it follows whichever host the browser used, so both origins work while both are live |
| Per-WABA webhook override | `callback_url` stored per WABA in the control plane, sent as `override_callback_uri` on `subscribed_apps` | **Yes, and silently.** Meta's per-WABA override wins over the app-level Callback URL, so switching the panel setting does not move delivery for a WABA registered under the old origin |
| `/v1` API | The customer's own integration | Yes, eventually — hence the overlap window before `workers.dev` is disabled |

> The `/connect` flow is a **server-side OAuth dialog redirect** to
> `https://www.facebook.com/<version>/dialog/oauth`; nothing in the repo loads the Facebook
> JavaScript SDK. The panel's *JavaScript SDK allowed domains* list is therefore not exercised by
> the code today — but leave it consistent with the other origins, because a reviewer reads it as
> part of the same declaration.

### Steps

**1 — Confirm the hostname is free (Cloudflare, by hand).** In the `eccos.chat` zone, check that
no DNS record already exists for `api`. A pre-existing record makes the custom-domain attach fail;
Cloudflare creates and manages the record itself for a `custom_domain` route.

**2 — Deploy the custom domain (additive).** The route is already declared in
`apps/gateway/wrangler.jsonc` alongside `"workers_dev": true`, so one deploy adds the new origin
and changes nothing about the old one:

```bash
bun run deploy     # == cd apps/gateway && wrangler deploy
```

Wait for the certificate to be issued (usually a minute or two; the Workers dashboard shows the
custom domain as *Active*). Nothing is pointed at the new host yet.

**3 — Prove the new origin, before Meta hears about it.** The gateway must answer on
`api.eccos.chat` exactly as it does on `workers.dev` — same Worker, same secrets, same Durable
Object routing — *and in particular the webhook challenge and the signature check must pass*,
because those are the two things Meta itself will exercise:

```bash
# needs META_APP_SECRET + META_WEBHOOK_VERIFY_TOKEN in .env or exported
./scripts/smoke.sh https://api.eccos.chat
```

That run covers `/health`, `/ready`, the `GET` challenge with a valid **and** an invalid verify
token (`403`), and a signed `POST /webhooks/meta` with a valid signature (`200`), an invalid
signature (`401`) and invalid JSON (`400`). Re-run it against the `workers.dev` origin too and
confirm both pass. **Do not continue until this is green** — every later step assumes the new host
is a working webhook receiver.

**4 — Register the new origin in the Meta panel, without removing the old one (by hand).** App
`1424473183036863`, all additive:

| Panel location | Add | Keep for now |
|---|---|---|
| App settings → Basic → App domains | `api.eccos.chat`, if the panel does not already accept it under the declared `eccos.chat` | `eccos.chat`, `www.eccos.chat` |
| Facebook Login → Settings → Valid OAuth Redirect URIs | `https://api.eccos.chat/connect` | `https://eccos.santi-gamo.workers.dev/` and `https://eccos.santi-gamo.workers.dev/connect` |
| Facebook Login → Settings → Allowed domains for the JavaScript SDK | `api.eccos.chat` | the existing `workers.dev` entry |

Meta matches `redirect_uri` exactly, so `https://api.eccos.chat/connect` must be present verbatim —
no trailing slash, no path variations. With both sets registered, Embedded Signup works from
either origin, which is what makes the next two steps reversible.

**5 — Flip `GATEWAY_PUBLIC_URL` (one line, one deploy).** Only now, with
`https://api.eccos.chat/connect` a registered redirect URI:

```jsonc
// apps/gateway/wrangler.jsonc → vars
"GATEWAY_PUBLIC_URL": "https://api.eccos.chat",
```

```bash
bun run deploy
```

Then click **Connect WhatsApp** in the dashboard once and confirm the OAuth dialog opens against
`api.eccos.chat` and returns to `/connect` without a `redirect_uri` error. The dashboard needs no
change of its own — it never hardcodes a gateway origin; it receives the full URL over the
`GatewayRPC` service binding.

**5b — Re-register every existing WABA under the new origin.** `subscribeApp` sends the control
plane's stored per-WABA `callback_url` as `override_callback_uri`, and that override takes
precedence over the app-level Callback URL. Nothing rewrites that column except registration
through `/connect` — `resubscribeWaba` re-asserts whatever is already stored. A WABA registered
while the origin was `workers.dev` therefore keeps receiving its webhooks there no matter what the
panel says, and step 6 alone will not move it.

Reconnect every registered number through Embedded Signup (dashboard → **Connect WhatsApp**), and
do it **after** step 5, never before: the reconnect writes `https://api.eccos.chat/webhooks/meta`
as the stored `callback_url` and re-subscribes Meta with the new override. Reconnecting before the
flip would just re-write the old origin and need a second pass.

> If this deploy also introduced token encryption, the pre-encryption rows are quarantined as
> `failed` with *"meta access token is not encrypted; reconnect the number"*. The same reconnect
> clears both — the quarantine and the stale override — in one action.

**6 — Switch the WABA webhook callback URL (by hand).** Meta panel → WhatsApp → Configuration →
Callback URL:

- from `https://eccos.santi-gamo.workers.dev/webhooks/meta`
- to `https://api.eccos.chat/webhooks/meta`

Keep the same verify token, click **Verify and save** (Meta re-runs the `GET` challenge against the
new host — step 3 already proved it answers), and confirm the `messages` field is still subscribed.

**7 — Verify a real inbound message.** Send a WhatsApp message to a connected number and confirm it
lands: the delivery shows up in the operator console and, if a subscriber is configured, at the
subscriber endpoint. This is the only check that proves Meta's own delivery path — not just a
locally signed request — reaches a live origin.

> **It only proves the *new* origin if step 5b was done.** A WABA still carrying a `workers.dev`
> override delivers to the old host, which is the same Worker, so the message lands in the console
> exactly as it would have — the check passes while proving nothing. Confirm first that no
> registered WABA still stores a `workers.dev` callback (`callbackUrl` on the account's WABA
> records).

**8 — Overlap, then retire `workers.dev` (separate change, later).** Leave both origins live long
enough for any customer integration still calling the `workers.dev` `/v1` host to move.

> **Hard gate before this step: no registered WABA may still store a `workers.dev` callback.**
> Disabling the old origin while an override still points at it stops webhook delivery for that
> WABA, and Meta retries a dead endpoint until it disables the subscription — the exact failure the
> "always answer 200 quickly" rule exists to prevent. Check every account's WABA records, not just
> the one you reconnected. When it is
confirmed unused, drop `"workers_dev": true` from `apps/gateway/wrangler.jsonc`, deploy, and remove
the `workers.dev` entries from the Valid OAuth Redirect URIs and the JavaScript SDK domains.
Retiring the old origin is never part of the same deploy that adds the new one.

### Rollback

Each step above is undone by reversing only itself; none of them touches Durable Object state, so
no message history, delivery queue or WABA config is at risk.

| Symptom | Undo |
|---|---|
| New origin fails the smoke test (step 3) | Nothing to undo — Meta is still on `workers.dev`. Fix the domain and re-run |
| Embedded Signup errors after step 5 | Set `GATEWAY_PUBLIC_URL` back to the `workers.dev` origin and `bun run deploy`. The `workers.dev` redirect URI is still registered, so it works immediately |
| Webhooks stop arriving after step 6 | In the Meta panel, set the Callback URL back to `https://eccos.santi-gamo.workers.dev/webhooks/meta` and **Verify and save**. The old origin is still live because step 8 has not run |
| Bad Worker code, unrelated to the domain | `wrangler rollback` (below) — the custom domain and the Meta panel entries are unaffected |

If the whole cutover is abandoned, remove the `routes` entry from `apps/gateway/wrangler.jsonc`,
deploy, and delete the `api.eccos.chat` entries from the Meta panel. Leaving the custom domain
attached while Meta points elsewhere is harmless.

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
