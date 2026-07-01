# Threat model

This is a lightweight, code-grounded threat model for Eccos — proportionate to what it actually
is: a **single-tenant, self-hosted** WhatsApp gateway (one WABA, one phone number, one operator).
It is not written for a multi-tenant SaaS, and it does not invent controls the codebase doesn't
have. Every mitigation cited below is backed by a specific file; every gap is called a gap.

Two runtimes ship the same core: the **Cloudflare Workers target** (`apps/gateway/`, the actively
developed v1 surface — Hono app + `EccosGateway` Durable Object) and the **Bun target** (`src/`,
kept aside). This document focuses on the Workers target and its companion operator console
(`apps/dashboard/`), and calls out where the Bun target differs.

## 1. Assets

What an attacker would want, and where it lives:

| Asset | What it is | Where it lives |
|---|---|---|
| `META_ACCESS_TOKEN` | Permanent Meta System User token — can send messages and read templates as your WABA | Secret: `wrangler secret` (Workers) / `.env` (Bun). Never persisted to the DO or SQLite. |
| `META_APP_SECRET` | Verifies inbound webhook signatures; also used server-side to exchange OAuth codes | Secret: `wrangler secret` / `.env` |
| `META_WEBHOOK_VERIFY_TOKEN` | Shared value Meta echoes back on webhook subscription (`GET /webhooks/meta`) | Secret: `wrangler secret` / `.env` |
| `ECCOS_API_KEY` | Bearer key gating `POST /v1/messages` and `GET /v1/templates` | Secret: `wrangler secret` / `.env` |
| `SUBSCRIBER_SECRET` | HMAC key Eccos uses to sign forwarded events (`X-Eccos-Signature`) so the subscriber can trust them | Secret, or rotatable via the dashboard's "settings" operator action (`apps/gateway/src/gateway.ts` `setSubscriberConfig`) |
| Message content | Inbound reply/echo text, delivery/read/failed statuses, phone numbers (`from`/`to`), Meta message ids | DO SQLite (`inbound_events`, `outbound_messages`, `deliveries` in `apps/gateway/src/gateway.ts`) / `bun:sqlite` (Bun target, `src/db/client.ts`) |
| The transient Embedded-Signup business token | 60-day token returned by `exchangeCodeForToken` during `/connect` | In-memory only for the duration of one request (`apps/gateway/src/routes/connect.ts`); **not persisted** — confirmed by reading `exchangeAndPersist`, which only saves `META_WABA_ID` / `META_PHONE_NUMBER_ID` / `DISPLAY_PHONE_NUMBER` / `CONNECTED_AT` to DO config |
| Cloudflare Access session (operator console) | Proves "this is the operator" to the dashboard | Cloudflare-managed; re-verified in-Worker (`apps/dashboard/src/access.ts`) |

## 2. Trust boundaries

```
Meta Cloud API            (untrusted network, but requests are HMAC-signed)
     │  POST /webhooks/meta (X-Hub-Signature-256)
     ▼
Gateway Worker  ───────────────▶  Subscriber webhook   (your app; X-Eccos-Signature)
     ▲  POST /v1/messages            (operator-owned, outside this repo's trust boundary)
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
2. **caller ↔ gateway (`/v1/*`)** — your own backend/apps are "trusted" once they present
   `ECCOS_API_KEY`; the gateway does not attempt to distinguish between callers beyond that.
3. **gateway ↔ subscriber** — the gateway pushes data outbound to a URL the operator configured;
   the subscriber is expected to verify `X-Eccos-Signature` before trusting the payload.
4. **operator ↔ dashboard ↔ gateway** — the operator console is a separate Worker with **no public
   HTTP path into the gateway at all**: it only holds a Cloudflare service binding to the
   `GatewayRPC` entrypoint (`apps/gateway/src/rpc.ts`), which cannot be reached over the network —
   only from a bound Worker. The dashboard itself sits behind Cloudflare Access.

## 3. Attack surfaces and existing mitigations

### 3.0 `/health`, `/ready` (unauthenticated, low-sensitivity)

Both are intentionally public (LB/uptime polling). `GET /health` is a pure liveness check with no
I/O. `GET /ready` (`apps/gateway/src/worker.ts`) additionally reports whether the required Meta/
API secrets are present and whether the Durable Object responds — but only as **booleans and key
names** (`REQUIRED_CONFIG_KEYS`), never values. Confirmed by reading `configPresence()`: it returns
`Boolean(rec[key]?.trim())` per key, not the value itself. Worth knowing this surface exists and is
unauthenticated, but it does not leak secrets or message data.

### 3.1 `POST /webhooks/meta` (inbound from Meta)

- **Surface:** public, unauthenticated by network position; anyone can POST to this URL.
- **Mitigation:** `verifyMetaSignature` (`packages/core/src/signature.ts`) recomputes
  HMAC-SHA256 over the *raw* body with `META_APP_SECRET` and compares it to
  `X-Hub-Signature-256` using `constantTimeEqual` — a length check plus an XOR-accumulate loop,
  not `===`, so response timing doesn't leak how many leading bytes matched. Missing/invalid
  signature → `401` before the body is even parsed (`apps/gateway/src/worker.ts`).
- **`GET /webhooks/meta`** (Meta's subscription challenge) is protected by comparing
  `hub.verify_token` to `META_WEBHOOK_VERIFY_TOKEN` — but with plain `===` (`worker.ts` line 30),
  not `constantTimeEqual`. See residual risks below.
- Ingest is idempotent: `inbound_events` has unique indexes on `(transport_message_id, type)` and
  on `message_id`, so a replayed (validly-signed) webhook delivery doesn't double-insert.

### 3.2 `/v1/*` (outbound send, templates)

- **Surface:** requires a Bearer token or `x-api-key` equal to `ECCOS_API_KEY`, checked with
  `constantTimeEqual` (`apps/gateway/src/worker.ts`).
- **Rate limiting:** `POST /v1/messages` is additionally throttled by Cloudflare's native Rate
  Limiting binding (`SEND_RATE_LIMITER`, 60/min per key, `wrangler.jsonc`) — the code comment in
  `worker.ts` is explicit that this is "per-location and eventually consistent: good abuse/spike
  protection, not an exact global quota counter."
- **Single key, no scoping:** there is one `ECCOS_API_KEY` for the whole tenant; any caller that
  holds it can send as your business number and read templates. This is by design for v1
  (single-tenant, no per-caller ACLs) — not a bug, but worth stating plainly.

### 3.3 `/connect`, `/connect/exchange` (Embedded Signup OAuth)

- **Surface:** `connectRoutes()` (`apps/gateway/src/routes/connect.ts`) is mounted at the app root
  (`app.route("/", connectRoutes())`), outside the `/v1/*` auth middleware — it has to be, since
  `GET /connect` is a browser redirect target from Meta (can't carry a bearer header).
- **CSRF/state mitigation (`GET /connect`):** `GET /connect` sets a short-lived (5 min),
  `httpOnly`, `secure`, `SameSite=Lax` cookie (`eccos_connect_state`) carrying a random OAuth
  `state` before redirecting to Meta; on the callback it compares the query `state` against the
  cookie value with `constantTimeEqual` (`oauthStateIsValid` in `connect.ts`) and fails closed
  (`400`) on a missing or mismatched value, clearing the cookie either way. This blocks an
  attacker from tricking a victim's browser into completing an OAuth exchange the victim didn't
  initiate.
- **Auth mitigation (`POST /connect/exchange`):** this endpoint — which takes a
  `code`/`waba_id`/`redirect_uri` body and, on success, **overwrites** the gateway's
  `META_WABA_ID` / `META_PHONE_NUMBER_ID` in DO config — now requires the same Bearer/`x-api-key`
  check as `/v1/*` (`isAuthorized`/`extractApiKey` in `connect.ts`, `constantTimeEqual` against
  `ECCOS_API_KEY`), rejecting with `401` before touching `exchangeAndPersist`. So a caller must
  already hold `ECCOS_API_KEY` to rebind the WABA/phone number via this path.
- Exchanging a `code` still additionally requires the operator's own `META_APP_SECRET`
  server-side (`exchangeCodeForToken`) — defense in depth beyond the two checks above.
- The transient business token from the exchange is used in-request (`listPhoneNumbers`,
  `subscribeApp`) and discarded; it is never written to DO storage or logged.
- **Residual risk:** none significant identified for this surface at present — both the CSRF gap
  and the missing auth on `/connect/exchange` (both previously flagged in this document) have been
  closed in code.

### 3.4 Dashboard behind Cloudflare Access + the RPC service binding

- **Surface:** the operator console (`apps/dashboard/`) renders gateway status, inbound/outbound/
  delivery logs, and exposes operator actions (retry delivery, rotate subscriber config,
  resubscribe).
- **Mitigation, edge:** Cloudflare Access sits in front of the dashboard's custom domain
  (account-level Zero Trust config, not code).
- **Mitigation, in-Worker:** `enforceAccess` (`apps/dashboard/src/access.ts`) independently
  re-verifies the `Cf-Access-Jwt-Assertion` JWT (falling back to the `CF_Authorization` cookie)
  against the team's JWKS with `jose`, checking RS256 signature + `iss`/`aud`/`exp`/`nbf` — so
  hitting the raw `*.workers.dev` origin directly cannot bypass Access. **Fails closed**: any
  verification failure → `403`. Wired into a custom server entry (`src/server.ts`) so it runs
  before SSR pages, server routes, and server-function calls alike.
  This gate is a documented **no-op until both `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set**
  (`apps/dashboard/README.md`) — a bare deploy is unauthenticated by default.
- **Mitigation, transport:** the dashboard reaches the gateway only via a Cloudflare service
  binding to the `GatewayRPC` `WorkerEntrypoint` (`apps/gateway/src/rpc.ts`) — not HTTP. This
  binding is not addressable from the public Internet at all; there is no URL to leak or CORS
  policy to misconfigure, because there is no route.
- **What the operator API returns:** `GatewayRPC.getSubscriberConfig()` explicitly returns only
  `{ url, hasSecret }` — never the `SUBSCRIBER_SECRET` value itself (`gateway.ts` comment: "Never
  exposes the secret"). `getConfig()` / `getAllConfig()` do return whatever is in the DO `config`
  table, which today only holds non-secret onboarding metadata (WABA id, phone number id, display
  phone, subscriber URL) — no access tokens are ever written there.

## 4. Threats mapped to mitigations (and residual risk)

| Threat | Mitigated by | Residual risk |
|---|---|---|
| Forged/replayed Meta webhook | `verifyMetaSignature` + constant-time compare + unique indexes on `inbound_events` | None significant; HMAC verification happens before JSON parsing. |
| Timing attack on webhook/API-key comparison | `constantTimeEqual` (XOR-accumulate, length-checked first) | The webhook **subscription** `hub.verify_token` check uses plain `===`, not `constantTimeEqual` — low severity (low-value, one-time setup token; Meta calls it directly), but inconsistent with the rest of the codebase. |
| Stolen/leaked `ECCOS_API_KEY` | Bearer/`x-api-key` check, constant-time compare, rate limit on send | No key rotation mechanism exists yet (unlike `SUBSCRIBER_SECRET`, which the dashboard can rotate); rotating `ECCOS_API_KEY` today means redeploying the secret. No per-caller scoping — one leaked key = full send + template-read access. |
| Forged forwarded event reaching the subscriber | `X-Eccos-Signature: sha256=<hex>` via `signPayload`, using `SUBSCRIBER_SECRET` | The subscriber's own verification is out of this repo's control — if a subscriber implementation skips verification, forgery is possible from anyone who can reach its webhook URL. Document this expectation clearly for integrators. |
| Unauthorized WABA rebind via `/connect/exchange` | `ECCOS_API_KEY` gate (`isAuthorized`, `constantTimeEqual`) on `POST /connect/exchange`, plus a `state`-cookie CSRF check on `GET /connect`'s callback, plus requiring a valid single-use Meta OAuth `code` (see §3.3) | Low. Both previously-identified gaps (no auth on the exchange endpoint, no CSRF state check on the callback) are now closed in code. |
| Dashboard reached directly on `*.workers.dev`, bypassing Access at the edge | In-Worker `enforceAccess` re-verification, fail-closed | Only enforced once `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` are configured — a fresh, un-configured deploy is fully open. This is documented but relies on the operator completing setup before exposing the URL. |
| Operator console leaking message content to the wrong person | Access JWT gate (edge + in-Worker) restricts *who* reaches the dashboard at all | The dashboard renders raw inbound message text (`apps/dashboard/src/routes/inbound.tsx`, `inboundSummary()` reads `ev.text`) to anyone who passes the Access policy — so the Access policy *is* the access-control boundary for message content, not a separate per-page permission. |
| DoS via flooding `/webhooks/meta` with invalid signatures | Cloudflare edge DDoS protection (platform-level, outside this repo) | No application-level rate limiting on the two public unauthenticated routes (`GET`/`POST /webhooks/meta`), unlike `/v1/messages`. Each invalid POST still costs one HMAC computation before rejection. |
| Single Durable Object as a availability/scale bottleneck | N/A (architectural choice, not a security control) | `idFromName("singleton")` means all reads/writes for the one tenant serialize through one DO instance — appropriate for single-tenant v1, but worth knowing it's not a distributed system. |
| Secrets/content in logs | The Workers target's `logEvent()` (`apps/gateway/src/worker.ts`) emits one structured JSON line per notable route outcome (event name, correlation id from `cf-ray`, HTTP status, and an explicit `LogMeta` allowlist typed as `string \| number \| boolean \| null \| undefined` — no nested objects). Every call site passes only ids, counts, booleans, or enum-like strings (`mode`, `path`, `bodyBytes`, `eventCount`, `messageType`, `messageId`, `limit`/`count`, `configOk`/`missingConfig` key names) — never a recipient number, message body, or secret value; the code carries an explicit "never pass message bodies, full phone numbers, tokens, API keys, or signatures" comment. The Bun target (`src/`) still has only two `console.*` calls total (`src/index.ts` boot message, `src/delivery/forward.ts` delivery-loop error), neither logging a secret or body. | Cloudflare Workers observability is enabled at `head_sampling_rate: 1` (`apps/gateway/wrangler.jsonc`) — captures whatever *is* logged. The `LogMeta` type prevents accidentally passing a whole object/body, but a developer could still pass a string field containing sensitive text at a future call site — this is a strong convention plus a type-level guard, not an automated content scan. See `docs/privacy.md`. |

## 5. Out of scope / explicitly not modeled

- Multi-tenant isolation — this is a single-tenant system by design (see `CLAUDE.md`); there is
  nothing to isolate between tenants because there is only one.
- Physical/host security of a self-hosted Bun deployment (Docker image, VM, disk encryption) — the
  operator's own infrastructure, not this codebase.
- Meta's own platform security (Graph API auth, WABA-level abuse controls) — trusted upstream.
- Supply-chain (dependency) security — not covered here; see standard `bun audit` / Dependabot
  practice, which is a repo-hygiene concern rather than a runtime threat surface.

## 6. Recommendations

1. Switch the `hub.verify_token` comparison in `GET /webhooks/meta` (both targets) to
   `constantTimeEqual` for consistency, even though the practical exposure is low. **Not yet
   implemented** — both targets still use plain `===` for this one comparison.
2. Consider adding a rotation story for `ECCOS_API_KEY` (mirroring the dashboard's
   `setSubscriberConfig` rotation for `SUBSCRIBER_SECRET`). **Not yet implemented.**
3. ~~Gate `/connect/exchange` more tightly (auth + CSRF state).~~ **Done** — `POST
   /connect/exchange` now requires `ECCOS_API_KEY`, and `GET /connect`'s callback now validates an
   OAuth `state` cookie (see §3.3).
4. If/when the Bun target is retaken post-v1, carry the same signature/timing hygiene, and the
   same structured, secret-free logging discipline the Workers target now has (`worker.ts`
   `logEvent`), forward to `src/`.
