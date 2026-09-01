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
| `META_GRAPH_VERSION` | `v25.0` | Meta Graph API version every Graph call and the Embedded Signup dialog are pathed with. Must match the version the app's *subscribed* webhook fields carry in the Meta panel — see [Meta Graph API version](#meta-graph-api-version) |
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
| `RECCADO_ENDPOINT` | Full transactional message endpoint, `https://<host>/v1/mailboxes/<mailboxId>/transactional/messages`. A secret rather than a var because it carries the provider host and `apps/dashboard/wrangler.jsonc` is in a public repo — the Cloudflare account subdomain deliberately stays out of it. Required whenever `RECCADO_API_KEY` is set; the adapter validates it and fails closed on boot without it |

### `apps/dashboard` — non-secret vars (`apps/dashboard/wrangler.jsonc` → `vars`)

| Var | Default | Purpose |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | `""` | Cloudflare Zero Trust team domain. Both this and `ACCESS_AUD` empty allow localhost development only; public requests fail closed |
| `ACCESS_AUD` | `""` | Cloudflare Access application Audience (AUD) tag |
| `BETTER_AUTH_URL` | canonical origin | Optional explicit base URL; defaults to `https://app.eccos.chat` |
| `META_APP_ID` | `""` | Meta app id, for the Embedded Signup **JavaScript SDK** path. Public by design — Meta's own guide puts it in client-side JS. **Empty disables the SDK path** and the Connect button falls back to the server-side redirect |
| `META_ES_CONFIG_ID` | `""` | Facebook Login for Business configuration id (the v4 one). Same value as the gateway's secret; public by design. **Empty disables the SDK path** |
| `META_GRAPH_VERSION` | `v25.0` | Passed to `FB.init`. Keep equal to the gateway's — see [Meta Graph API version](#meta-graph-api-version) |

The dashboard reaches the gateway via the `GATEWAY` service binding declared in
`apps/dashboard/wrangler.jsonc` (RPC only, never public HTTP); its own secrets are the three
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
# The whole message endpoint, mailbox id and all — one value, because the key
# already binds to exactly one mailbox. The adapter validates it and fails
# closed if the key is set and this is missing or malformed.
wrangler secret put RECCADO_ENDPOINT
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

## Meta Graph API version

**Eccos targets Graph API `v25.0`.** One version, everywhere: the `META_GRAPH_VERSION` var, the
code defaults behind it, and — this is the part that is not in the repository — the API version
each webhook field is subscribed at on the WhatsApp Business Account object in the Meta app panel.

Meta's own webhooks panel warns to **use the same API version for every field subscribed on an
object, or updates may not be delivered on time**. A field subscribed at one version while the
gateway calls another is not a cosmetic mismatch: it is a delivery-timing risk on the ingest path,
and it is invisible from the code, because the subscription version lives only in the panel.

Why `v25.0`: as of 2026-09-01 all twelve fields subscribed on the WABA object (`messages`,
`smb_message_echoes`, `history`, `smb_app_state_sync`, `account_alerts`, `account_review_update`,
`calls`, `security`, `phone_number_name_update`, `phone_number_quality_update`,
`message_template_status_update`, `message_template_quality_update`) are on `v25.0`; `v25.0` is
supported until 2028; and `v26.0`'s changelog carries no WhatsApp Business Platform change, so
there is nothing to gain from moving past it. (Panel fields showing `v26.0` are unsubscribed ones
sitting on the panel default — they carry no traffic.)

### How to bump it

Change all six, in this order, and treat it as one change:

1. `apps/gateway/wrangler.jsonc` → `vars.META_GRAPH_VERSION` — **the value that wins in
   production**; the code defaults below only apply where this var is absent.
2. `packages/core/src/config-schema.ts` → the `META_GRAPH_VERSION` zod `.default(...)`.
3. `packages/core/src/config-schema.ts` → the `metaGraphVersion()` fallback that feeds
   `graphBaseUrl()`.
4. `apps/gateway/src/tenant-config.ts` → the `getAppConfig()` per-tenant fallback.
5. `apps/gateway/src/routes/connect.ts` → the Embedded Signup OAuth dialog URL fallback.
6. **The Meta app panel** — WhatsApp > Configuration > Webhooks: set the new version on *every*
   subscribed field, not just `messages`. This is the step no test can catch.

`.env.example`, `apps/gateway/wrangler.vitest.jsonc` and the version pinned in the unit tests
follow along. Before bumping, read the Graph changelog for breaking changes between the current
version and the target, especially around the Embedded Signup dialog, `subscribed_apps`, and the
version-pathed `POST /<API_VERSION>/<PHONE_NUMBER_ID>/smb_app_data` sync — that sync can only be
performed once per number, so a version mistake there costs an offboard/re-onboard, not a retry.

## Embedded Signup version

**Eccos targets Embedded Signup v4.** Embedded Signup is versioned separately from the Graph API,
and the version is a property of the **Facebook Login for Business configuration** whose id is
`META_ES_CONFIG_ID` — not of anything in this repository. v2 is deprecated on **15 October 2026**
and v3 retires the same month, so v4 is the only surviving version.

There used to be an `extras` object on the OAuth dialog URL carrying
`featureType: "whatsapp_business_app_onboarding"`, `sessionInfoVersion` and an empty `setup`. It is
gone, for two reasons:

- **It never worked.** `extras` is documented only as an `FB.login()` option; it is not a parameter
  of `dialog/oauth`. Verified against production on 2026-09-01 — the flow ran the ordinary Cloud API
  path and the WABA-selection screen was *not* replaced by the "connect your existing WhatsApp
  Business account" screen, which is Meta's own test for the coexistence feature being enabled.
- **v4 does not want it.** Meta's v4 `extras` object is "purposely empty": products and version come
  from the login configuration. `sessionInfoVersion` was a v2-only field; v3 and v4 return session
  info for every flow.

So the dialog URL now carries only what Meta documents for the manual login flow — `client_id`,
`redirect_uri`, `state`, `response_type`, `override_default_response_type` — plus `config_id`.

### Creating the v4 configuration (panel, by hand)

The login **variation cannot be changed after creation**, so a v4 configuration has to be a *new*
one rather than an edit of the existing v2 configuration. In **App Dashboard → Facebook Login for
Business → Configurations**:

1. **Create configuration** (not "Create from template", which yields the v2 template).
2. Login variation: **Embedded Signup**. This is the irreversible choice.
3. Products: select **Cloud API**. Selecting products is what puts the configuration on v4.
   Selecting more than one is optional — do not select Marketing Messages, CTWA, CTM, CTD or
   Conversions API unless they are actually wanted, because every extra product adds assets and
   permissions the customer is asked to grant, and unwanted asset screens are where customers
   abandon the flow.
4. Assets: **WhatsApp Business accounts**. Permissions: `whatsapp_business_management` and
   `whatsapp_business_messaging` — both need **Advanced Access**, which is App Review
   (`whatsapp_business_messaging`, `whatsapp_business_management`). Standard access still works for
   people with a role on the app, which is enough for a pilot on our own numbers.
5. Copy the configuration id and set it as `META_ES_CONFIG_ID` (`wrangler secret put`, gateway).
   Nothing else in the deploy changes.

Keep the old configuration until the new one is proven: rolling back is `wrangler secret put
META_ES_CONFIG_ID` with the previous id.

### What a wrong or missing configuration id does

| Situation | How it surfaces |
|---|---|
| `META_ES_CONFIG_ID` unset or empty | **Loud.** `/connect` and `POST /connect/start` answer `503` with `META_ES_CONFIG_ID is required for /connect`; the console shows the connect failure |
| Id is not a real configuration | **Loud.** Meta's dialog refuses and redirects back with `error=…`; the callback maps it to `connectError=denied` |
| Id is a *valid but wrong* configuration — a stale v2 one, or a v4 one without the products we need | **Silent, by construction.** The dialog opens and the customer completes a flow. Nothing in the URL or the callback says which version ran |

That last row is the failure that cost a day on 2026-09-01, and no code here can close it: Meta
exposes no way to read a login configuration's version or products back. What *does* close it is
downstream — the coexistence verification reads
`GET /<PHONE_NUMBER_ID>?fields=is_on_biz_app,platform_type` per number before spending anything
irreversible, and a number that came out of the wrong flow is recorded `not_coexistence` and shown
in the console. **After changing `META_ES_CONFIG_ID`, connect one number and check that**, rather
than trusting that the dialog opened.

### The two Embedded Signup paths

The **Connect WhatsApp** button takes one of two paths, and both must keep working:

| Path | When | What it needs |
|---|---|---|
| **JavaScript SDK** (preferred) | `META_APP_ID` *and* `META_ES_CONFIG_ID` are set on the **dashboard** and `connect.facebook.net` loads | `app.eccos.chat` registered in the panel's *Allowed domains for the JavaScript SDK* **and** *Valid OAuth Redirect URIs* |
| **Server-side redirect** (fallback, and the only self-host path) | the SDK is unconfigured or fails to load | `GATEWAY_PUBLIC_URL` and its `/connect` registered as a Valid OAuth Redirect URI |

The SDK path exists because Meta's coexistence requirements end with *"You must use Embedded Signup
with session logging"* — a `message` listener on the page that spawned the flow, which a server-side
redirect has no way to provide. It captures the screen a customer abandoned on and the error code
and session id they report, which nothing else does; those land in the dashboard audit log as
`connect_session_event`. The authorization code from `FB.login()` lives **30 seconds** and is posted
straight to a session-authenticated server function, which forwards it over the private `GATEWAY`
binding — no account API key ever exists in the browser.

`POST /connect/start` and `GET /connect` on the gateway are untouched by any of this. A self-hoster
with no console still connects a number with an API key and a browser, exactly as before.

> **Panel, for the SDK path.** Add `app.eccos.chat` to **Facebook Login for Business → Settings →
> Allowed domains for the JavaScript SDK** *and* to **Valid OAuth Redirect URIs** — Meta returns the
> asset ids to the spawning window only when the spawning page's domain is in both. Confirm the
> Client OAuth toggles are all **Yes**, including **Login with the JavaScript SDK**.

> **Third-party script.** `https://connect.facebook.net/en_US/sdk.js` is the first and only
> third-party script in the console. It is loaded lazily, on click, on the Numbers page alone — but
> there is no Content-Security-Policy in this repository to constrain it. See
> [docs/threat-model.md](./threat-model.md).

### Completion states v4 allows that v2 did not

v2 always handed back a **verified** phone number. v4 lets a customer finish with a verified number,
an **unverified** number, or **no number at all**, so the gateway no longer assumes one:

| Completion | What Eccos does |
|---|---|
| Verified number | Unchanged: subscribe, configure the data plane, verify coexistence, go `active` |
| **No number** | The WABA is registered and `subscribed_apps` still runs (it needs no number), the data plane is left unconfigured, and the WABA stays `pending` with `connected, but this WhatsApp Business account has no business phone number yet…`. Every retry re-reads `GET /<WABA_ID>/phone_numbers` and adopts a number as soon as one appears — no reconnect needed. **Exempt from the six-attempt cap**: it keeps polling hourly while `pending`, because the customer may add the number the next day and a zero-phone WABA has no row and so no Re-check button. The console shows "Waiting on a phone number" |
| **Unverified number** | It registers and provisions like any other number, because Meta returns it on the WABA. Sends will fail at Meta until the number is registered with the Cloud API — Eccos does not yet call `POST /<PHONE_NUMBER_ID>/register` (tracked separately), so the failure surfaces as an error on the outbound message rather than at connect time |

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
