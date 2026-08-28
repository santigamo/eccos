# Threat model

This is a lightweight, code-grounded threat model for Eccos — focused on the account-scoped
Cloudflare Workers mode and calling out where the separate Bun self-host target differs. Every
mitigation cited below is backed by a specific file; every gap is called a gap.

Two runtimes ship the same core: the **Cloudflare Workers target** (`apps/gateway/`, the actively
developed v1 surface — Hono app + `EccosGateway` Durable Object) and the **Bun target** (`src/`,
kept aside). This document focuses on the Workers target and its companion operator console
(`apps/dashboard/`), and calls out where the Bun target differs.

## 1. Assets

What an attacker would want, and where it lives:

| Asset | What it is | Where it lives |
|---|---|---|
| `META_ACCESS_TOKEN` | Permanent Meta System User token — can send messages and read templates as its WABA | Workers: control-plane WABA storage, never returned to callers. Bun: `.env`. |
| `META_APP_SECRET` | Verifies inbound webhook signatures; also used server-side to exchange OAuth codes | Secret: `wrangler secret` / `.env` |
| `META_WEBHOOK_VERIFY_TOKEN` | Shared value Meta echoes back on webhook subscription (`GET /webhooks/meta`) | Secret: `wrangler secret` / `.env` |
| `ECCOS_API_KEY` | Bun-target bearer key gating the WABA-scoped send/template routes | Secret: `.env` (Bun target only); account API keys are stored as SHA-256 hashes in the control plane |
| `ECCOS_ADMIN_API_KEY` | Bootstrap key for account and WABA provisioning | Secret: `wrangler secret` |
| `SUBSCRIBER_SECRET` | HMAC key Eccos uses to sign forwarded events (`X-Eccos-Signature`) so the subscriber can trust them | Workers: per-WABA DO config, rotatable via the dashboard's settings action. Bun: `.env`. |
| Message content | Inbound reply/echo text, delivery/read/failed statuses, phone numbers (`from`/`to`), Meta message ids | DO SQLite (`inbound_events`, `outbound_messages`, `deliveries` in `apps/gateway/src/gateway.ts`) / `bun:sqlite` (Bun target, `src/db/client.ts`) |
| The Embedded-Signup business token | 60-day token returned by `exchangeCodeForToken` during `/connect` | Stored only in the control-plane WABA row so later account-scoped sends and resubscriptions can use it; never written to the data-plane config or returned |
| Cloudflare Access session (operator console) | Proves "this is the operator" to the dashboard | Cloudflare-managed; re-verified in-Worker (`apps/dashboard/src/access.ts`) |

## 2. Trust boundaries

```
Meta Cloud API            (untrusted network, but requests are HMAC-signed)
     │  POST /webhooks/meta (X-Hub-Signature-256)
     ▼
Gateway Worker  ───────────────▶  Subscriber webhook   (your app; X-Eccos-Signature)
     ▲  POST /v1/wabas/<WABA_ID>/messages            (operator-owned, outside this repo's trust boundary)
     │  (Bearer / x-api-key)
your backend / integrations

Gateway Worker  ◀──(private RPC service binding, GatewayRPC)──  Dashboard Worker  ◀── operator's browser
                                                                       ▲
                                                          Cloudflare Access (JWT)
```

Four boundaries matter:

1. **Meta ↔ gateway** — inbound webhook calls are the only unauthenticated-by-default HTTP the
   gateway accepts from the public Internet; trust is established per-request by HMAC signature,
   not network position.
2. **caller ↔ gateway (`/v1/*`)** — callers are trusted once they present a hashed, revocable
   account API key resolved from the control plane, and must address a WABA they own.
3. **gateway ↔ subscriber** — the gateway pushes data outbound to a URL the operator configured;
   the subscriber is expected to verify `X-Eccos-Signature` before trusting the payload.
4. **operator ↔ dashboard ↔ gateway** — the operator console is a separate Worker with **no public
   HTTP path into the gateway at all**: it only holds a Cloudflare service binding to the
   `GatewayRPC` entrypoint (`apps/gateway/src/rpc.ts`), which cannot be reached over the network —
   only from a bound Worker. The dashboard itself sits behind Cloudflare Access.

## 3. Attack surfaces and existing mitigations

### 3.0 `/health`, `/ready` (unauthenticated, low-sensitivity)

Both are intentionally public (LB/uptime polling). `GET /health` is a pure liveness check with no
I/O. `GET /ready` (`apps/gateway/src/worker.ts`) additionally reports whether the two required
app-level webhook secrets are present and whether the control-plane Durable Object responds — but
only as **booleans and key names** (`REQUIRED_CONFIG_KEYS`), never values. Confirmed by reading
`configPresence()`: it returns `Boolean(rec[key]?.trim())` per key, not the value itself. Worth
knowing this surface exists and is unauthenticated, but it does not leak secrets or message data.

### 3.1 `POST /webhooks/meta` (inbound from Meta)

- **Surface:** public, unauthenticated by network position; anyone can POST to this URL.
- **Mitigation:** `verifyMetaSignature` (`packages/core/src/signature.ts`) recomputes
  HMAC-SHA256 over the *raw* body with `META_APP_SECRET` and compares it to
  `X-Hub-Signature-256` using `constantTimeEqual` — a length check plus an XOR-accumulate loop,
  not `===`, so response timing doesn't leak how many leading bytes matched. Missing/invalid
  signature → `401` before the body is even parsed (`apps/gateway/src/worker.ts`).
- **`GET /webhooks/meta`** (Meta's subscription challenge) compares `hub.verify_token` to
  `META_WEBHOOK_VERIFY_TOKEN` with `constantTimeEqual` on the Workers target. The separate Bun
  target still uses a direct string comparison.
- Ingest is idempotent: `inbound_events` has unique indexes on `(transport_message_id, type)` and
  on `message_id`, so a replayed (validly-signed) webhook delivery doesn't double-insert.
- A signed batch is accepted only for a WABA (and phone) registered in the control plane.
  A batch without `metadata.phone_number_id` is intentionally retained at WABA scope because the
  WABA id remains authoritative; it cannot cross account boundaries, but it cannot be attributed to
  one phone inside that WABA either.

### 3.2 `/v1/*` (outbound send, templates, erasure, export)

- **Surface:** every request authenticates an account API key — a SHA-256 hash lookup in the
  control plane (revoked keys fail closed) — and the WABA must be owned by that account before
  dispatch to a data-plane object (`apps/gateway/src/worker.ts`).
- **Rate limiting:** `POST /v1/wabas/<WABA_ID>/messages` is additionally throttled by Cloudflare's native Rate
  Limiting binding (`SEND_RATE_LIMITER`, 60/min per key, `wrangler.jsonc`) — the code comment in
  `worker.ts` is explicit that this is "per-location and eventually consistent: good abuse/spike
  protection, not an exact global quota counter."
- **Scope:** every account key is scoped to its account; unknown/revoked keys and cross-account
  WABA, phone, retry, export, and erasure access are rejected (fail closed).

### 3.3 `/connect`, `/connect/exchange` (Embedded Signup OAuth)

- **Surface:** `connectRoutes()` (`apps/gateway/src/routes/connect.ts`) is mounted at the app root
  (`app.route("/", connectRoutes())`), outside the `/v1/*` auth middleware — it has to be, since
  `GET /connect` is a browser redirect target from Meta (can't carry a bearer header).
- **Multi-tenant initiation:** `POST /connect/start` authenticates an account key and returns a
  short-lived state URL. The browser opens that URL without headers; `GET /connect` validates the
  state in the control plane and sets the CSRF cookie before redirecting to Meta.
- **CSRF/state mitigation (`GET /connect`):** `GET /connect` sets a short-lived (30 min),
  `httpOnly`, `SameSite=Lax` cookie (`eccos_connect_state`) carrying a random OAuth `state`
  before redirecting to Meta; it also sets `secure` on public HTTPS origins and omits it for
  localhost HTTP development. On the callback it compares the query `state` against the cookie
  value with `constantTimeEqual` (`oauthStateIsValid` in `connect.ts`) and fails closed (`400`)
  on a missing or mismatched value, clearing the cookie either way. This blocks an attacker from
  tricking a victim's browser into completing an OAuth exchange the victim didn't initiate.
- **Auth mitigation (`POST /connect/exchange`):** this endpoint — which takes a
  `code`/`state`/`waba_id`/`redirect_uri` body — requires an account API key and an account-bound
  OAuth state, and registers all available WABAs and phones discovered from the exchanged token
  under that account. Unselected foreign WABAs are skipped with warnings; an explicit foreign
  WABA selector is rejected before registry mutation.
- Exchanging a `code` still additionally requires the operator's own `META_APP_SECRET`
  server-side (`exchangeCodeForToken`) — defense in depth beyond the two checks above.
- The business token from the exchange is stored only in the control-plane WABA
  row so later tenant-scoped sends and resubscriptions can use it; it is never written to data-plane
  config or returned by the operator API.
- **Residual risk:** the account-scoped callback consumes its single-use state before the external
  exchange and subscription calls complete, so a failed Meta call requires a new connect attempt.
  The handoff URL is itself a bearer capability until consumed; operators must not forward it to a
  different account or an untrusted browser.

### 3.4 Dashboard behind Cloudflare Access + the RPC service binding

- **Surface:** the operator console (`apps/dashboard/`) renders gateway status, inbound/outbound/
  delivery logs, exposes operator actions (retry delivery, rotate subscriber config, resubscribe),
  and starts account-bound Embedded Signup through `GatewayRPC.startConnect()`.
- **Mitigation, edge:** Cloudflare Access sits in front of the dashboard's custom domain
  (account-level Zero Trust config, not code).
- **Mitigation, in-Worker:** `enforceAccess` (`apps/dashboard/src/access.ts`) independently
  re-verifies the `Cf-Access-Jwt-Assertion` JWT (falling back to the `CF_Authorization` cookie)
  against the team's JWKS with `jose`, checking RS256 signature + `iss`/`aud`/`exp`/`nbf` — so
  hitting the raw `*.workers.dev` origin directly cannot bypass Access. **Fails closed**: any
  verification failure → `403`. Wired into a custom server entry (`src/server.ts`) so it runs
  before SSR pages, server routes, and server-function calls alike.
  This gate allows localhost development when both `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are empty.
  Public requests and partial configuration **fail closed with `403`**, so a production dashboard
  can never silently become public. The Access-derived installation identity is not a secret; the
  private service binding is the boundary that lets the dashboard resolve account scope.
- **Mitigation, transport:** the dashboard reaches the gateway only via a Cloudflare service
  binding to the `GatewayRPC` `WorkerEntrypoint` (`apps/gateway/src/rpc.ts`) — not HTTP. This
  binding is not addressable from the public Internet at all; there is no URL to leak or CORS
  policy to misconfigure, because there is no operator route. The one browser handoff exception is
  the returned, short-lived gateway `/connect?state=...` URL; the OAuth callback remains on the
  gateway's public origin and the state is bound to the dashboard installation account.
- **What the operator API returns:** `GatewayRPC.getSubscriberConfig()` explicitly returns only
  `{ url, hasSecret }` — never the `SUBSCRIBER_SECRET` value itself (`gateway.ts` comment: "Never
  exposes the secret"). `GatewayRPC.getConfig()` and `exportData()` filter private keys before
  returning config. The data-plane config table can contain the subscriber secret for forwarding,
  but access tokens are stored only in the control plane and no private value is returned by the
  operator API.

## 4. Threats mapped to mitigations (and residual risk)

| Threat | Mitigated by | Residual risk |
|---|---|---|
| Forged/replayed Meta webhook | `verifyMetaSignature` + constant-time compare + unique indexes on `inbound_events` | None significant; HMAC verification happens before JSON parsing. |
| Misattributed signed webhook without phone metadata | Registered WABA filtering in `worker.ts`; the WABA id is the authoritative routing key | The event is retained at WABA scope when `phone_number_id` is absent, so phone-level attribution is unavailable. |
| Timing attack on webhook/API-key comparison | `constantTimeEqual` (XOR-accumulate, length-checked first) | The webhook **subscription** `hub.verify_token` check uses plain `===`, not `constantTimeEqual` — low severity (low-value, one-time setup token; Meta calls it directly), but inconsistent with the rest of the codebase. |
| Stolen/leaked API key | Account-key hash lookup, revocation, WABA ownership checks, and rate limit on send | A leaked account key grants access to every WABA owned by that account until revoked; the admin bootstrap key remains deployment-wide. |
| Forged forwarded event reaching the subscriber | `X-Eccos-Signature: sha256=<hex>` via `signPayload`, using `SUBSCRIBER_SECRET` | The subscriber's own verification is out of this repo's control — if a subscriber implementation skips verification, forgery is possible from anyone who can reach its webhook URL. Document this expectation clearly for integrators. |
| Unauthorized WABA rebind via `/connect/exchange` | Account-key gate plus single-use account-bound OAuth state and ownership-conflict checks; valid Meta OAuth code required (see §3.3) | A failed external exchange after state consumption requires a new connect attempt. |
| Subscriber URL SSRF | Rotated subscriber URLs require HTTPS, no credentials, and reject private/special IP literals; forwarding validates the stored value too and rejects redirects | DNS rebinding after save-time validation remains possible because Workers does not expose a general DNS-resolution API to application code. |
| Dashboard reached directly on `*.workers.dev`, bypassing Access at the edge | In-Worker `enforceAccess` re-verification, fail-closed | A public dashboard deployment fails closed until `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` are configured. Only localhost development without Access remains intentionally open. |
| Operator console leaking message content to the wrong person | Access JWT gate (edge + in-Worker) restricts *who* reaches the dashboard at all | The dashboard renders raw inbound message text (`apps/dashboard/src/routes/inbound.tsx`, `inboundSummary()` reads `ev.text`) to anyone who passes the Access policy — so the Access policy *is* the access-control boundary for message content, not a separate per-page permission. |
| DoS via flooding `/webhooks/meta` with invalid signatures | Cloudflare edge DDoS protection (platform-level, outside this repo) | No application-level rate limiting on the two public unauthenticated routes (`GET`/`POST /webhooks/meta`), unlike `/v1/wabas/<WABA_ID>/messages`. Each invalid POST still costs one HMAC computation before rejection. |
| Per-WABA Durable Object as an availability/scale boundary | N/A (architectural choice, not a security control) | Each WABA's reads/writes serialize through its own versioned DO; tenant state is not a global singleton, but there is no cross-region replica. |
| Secrets/content in logs | The Workers target's `logEvent()` (`apps/gateway/src/worker.ts`) emits one structured JSON line per notable route outcome (event name, correlation id from `cf-ray`, HTTP status, and an explicit `LogMeta` allowlist typed as `string \| number \| boolean \| null \| undefined` — no nested objects). Every call site passes only ids, counts, booleans, or enum-like strings (`mode`, `path`, `bodyBytes`, `eventCount`, `messageType`, `messageId`, `limit`/`count`, `configOk`/`missingConfig` key names) — never a recipient number, message body, or secret value; the code carries an explicit "never pass message bodies, full phone numbers, tokens, API keys, or signatures" comment. The Bun target (`src/`) still has only two `console.*` calls total (`src/index.ts` boot message, `src/delivery/forward.ts` delivery-loop error), neither logging a secret or body. | Cloudflare Workers observability is enabled at `head_sampling_rate: 1` (`apps/gateway/wrangler.jsonc`) — captures whatever *is* logged. The `LogMeta` type prevents accidentally passing a whole object/body, but a developer could still pass a string field containing sensitive text at a future call site — this is a strong convention plus a type-level guard, not an automated content scan. See `docs/privacy.md`. |

## 5. Out of scope / explicitly not modeled

- Shared-dashboard user-to-account authorization — the shipped dashboard maps one Access
  application identity to one generated account. Deploy a separate dashboard and Access
  application for each customer account; the browser's Access user identity is not itself used as
  an account selector. The first-paid-customer gate in `PRODUCTION-READINESS.md` must clear before
  third-party Cloud customers are charged.
- Multi-tenant support in the Bun target — the Bun deployment remains single-tenant and uses its
  existing environment-based credentials.
- Physical/host security of a self-hosted Bun deployment (Docker image, VM, disk encryption) — the
  operator's own infrastructure, not this codebase.
- Meta's own platform security (Graph API auth, WABA-level abuse controls) — trusted upstream.
- Supply-chain (dependency) security — not covered here; see standard `bun audit` / Dependabot
  practice, which is a repo-hygiene concern rather than a runtime threat surface.

## 6. Recommendations

1. Switch the `hub.verify_token` comparison in the Bun target's `GET /webhooks/meta` to
   `constantTimeEqual` for consistency; the Workers target already uses it. The practical
   exposure is low because the token is used during one-time subscription setup.
2. Account API keys can be issued and revoked through the admin bootstrap API (hashed at rest);
   the Bun target's single `ECCOS_API_KEY` rotation still requires a redeploy. A customer-facing
   key manager is not yet implemented.
3. ~~Gate `/connect/exchange` more tightly (auth + CSRF state).~~ **Done** — `POST
   /connect/exchange` now requires an account API key and an account-bound OAuth `state`, and
   `GET /connect`'s callback validates the OAuth state cookie (see §3.3).
4. If/when the Bun target is retaken post-v1, carry the same signature/timing hygiene, and the
   same structured, secret-free logging discipline the Workers target now has (`worker.ts`
   `logEvent`), forward to `src/`.
