# Threat model

This is a lightweight, code-grounded threat model for Eccos — focused on the account-scoped
Cloudflare Workers mode and calling out where the separate Bun self-host target differs. Every
mitigation cited below is backed by a specific file; every gap is called a gap.

Two runtimes ship the same core: the **Cloudflare Workers target** (`apps/gateway/`, the actively
developed v1 surface — Hono app + `EccosGateway` Durable Object) and the **Bun target** (`src/`,
kept aside). This document focuses on the Workers target and its companion operator console
(`apps/dashboard/`), and calls out where the Bun target differs.

The MCP server (`apps/mcp`) and the console's OAuth authorization server are specified in
[openspec/changes/add-mcp-server](../openspec/changes/add-mcp-server/) and built in its phase 1.
Where this document covers them (§1, §2, §3.5, §4), a mitigation is a requirement of that change
until its code lands; §3.5 says which.

## 1. Assets

What an attacker would want, and where it lives:

| Asset | What it is | Where it lives |
|---|---|---|
| `META_ACCESS_TOKEN` | Meta Embedded Signup business token — can send messages and read templates as its WABA. It never expires under the current Embedded Signup config, but expires after 60 days under the legacy one (see [operations.md](operations.md#meta-token-expiry)) | Workers: control-plane WABA storage, **AES-256-GCM encrypted at the application layer** under `ECCOS_TOKEN_ENCRYPTION_KEY` (`apps/gateway/src/token-crypto.ts`), never returned to callers. Bun: `.env`. |
| `META_APP_SECRET` | Verifies inbound webhook signatures; also used server-side to exchange OAuth codes | Secret: `wrangler secret` / `.env` |
| `META_WEBHOOK_VERIFY_TOKEN` | Shared value Meta echoes back on webhook subscription (`GET /webhooks/meta`) | Secret: `wrangler secret` / `.env` |
| `ECCOS_API_KEY` | Bun-target bearer key gating the WABA-scoped send/template routes | Secret: `.env` (Bun target only); account API keys are stored as SHA-256 hashes in the control plane |
| `ECCOS_ADMIN_API_KEY` | Bootstrap key for account and WABA provisioning | Secret: `wrangler secret` |
| `ECCOS_TOKEN_ENCRYPTION_KEY` | Key material for the control plane's Meta-access-token encryption at rest; holding it plus a storage dump yields every stored business token | Secret: `wrangler secret` (never in storage — that is the point of the layer) |
| `SUBSCRIBER_SECRET` | HMAC key Eccos uses to sign forwarded events (`X-Eccos-Signature`) so the subscriber can trust them | Workers: per-WABA DO config, rotatable via the dashboard's settings action. Bun: `.env`. |
| Message content | Inbound reply/echo text, delivery/read/failed statuses, phone numbers (`from`/`to`), Meta message ids | DO SQLite (`inbound_events`, `outbound_messages`, `deliveries` in `apps/gateway/src/gateway.ts`) / `bun:sqlite` (Bun target, `src/db/client.ts`) |
| The Embedded-Signup business token | 60-day token returned by `exchangeCodeForToken` during `/connect` | Stored only in the control-plane WABA row, encrypted with the envelope above and bound to `<accountId>:<wabaId>`, so later account-scoped sends and resubscriptions can use it; never written to the data-plane config or returned |
| Better Auth session (operator console) | Proves which user is signed in to the dashboard; organization membership decides what they can do | Session cookie resolved server-side on every request against the auth D1 (`apps/dashboard/src/auth/`) |
| OAuth access token (agents) | A JWT that lets one client act as one user in one workspace, within its scopes, against the MCP resource | The agent, and in transit. Lives 10 minutes, audience-bound to the MCP resource, and useless without a live grant, membership, and account link |
| OAuth refresh token | Gets new access tokens for a grant | The agent; hashed in the auth D1. Rotates on use; a replay inside the 30-second reuse window gets the same response, a later replay revokes the whole family. Revoked with the grant |
| JWT signing key | Signs OAuth access tokens (EdDSA) | Auth D1, the private half encrypted with `BETTER_AUTH_SECRET`. The session-JWT route (`/api/auth/token`) is disabled, so a session JWT cannot pass as an access token |
| Consent rows (grants) | The record that a user let a client act in a workspace; deleting one is the revocation switch | Auth D1; listed and revoked under Connected agents in Settings |
| Elevation rows and approval requests | A 24-hour permission for one grant to run step-up tools | Auth D1. Written only by the grant's own user, signed in as an owner or admin, who passed step-up. Requests expire in 10 minutes; an elevation ends at expiry, at revoke, or when ended by hand |
| Secret claim token | A one-time bearer value that redeems a newly minted API key or subscriber secret | The tool result, then the agent's shell or a person's browser; hashed in the control plane. Single use, 10 minutes, `POST` only, and nothing is minted until it is spent |

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
                                                  host allowlist + Better Auth session

customer's agent ──(POST /mcp, Bearer)──▶ MCP Worker (apps/mcp) ──(ConsoleRPC)──▶ Dashboard Worker
                                                    │
                                                    └──(GatewayRPC, resolved accountId)──▶ Gateway Worker
```

Five boundaries matter:

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
   only from a bound Worker. The dashboard itself requires a Better Auth session and resolves the
   account from the user's organization, never from browser input.
5. **agent ↔ `apps/mcp`** — a customer's agent is trusted for one request once
   `ConsoleRPC.authorize` returns an actor for its bearer token. `apps/mcp` then calls
   `GatewayRPC` with the `accountId` that actor carries, as the console does, and the gateway's
   own WABA and phone ownership checks still run on every call. The token stops at `apps/mcp`; the
   gateway never sees it.

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
  Limiting binding (`SEND_RATE_LIMITER`, 60/min per key, `wrangler.jsonc`; accounts in `HIGH_THROUGHPUT_ACCOUNTS` get `SEND_RATE_LIMITER_HIGH`, 600/min) — it is
  per-location and eventually consistent: spike protection, not an exact global quota. The check
  runs after the WABA is resolved and owned, keyed on the stored WABA id, so URL encoding cannot
  open a fresh bucket.
- **Scope:** every account key is scoped to its account; unknown/revoked keys and cross-account
  WABA, phone, retry, export, and erasure access are rejected (fail closed).

### 3.3 `/connect`, `/connect/exchange` (Embedded Signup OAuth)

- **Surface:** `connectRoutes()` (`apps/gateway/src/routes/connect.ts`) is mounted at the app root
  (`app.route("/", connectRoutes())`), outside the `/v1/*` auth middleware — it has to be, since
  `GET /connect` is a browser redirect target from Meta (can't carry a bearer header).
- **Multi-tenant initiation:** `POST /connect/start` authenticates an account key and returns a
  short-lived state URL. The browser opens that URL without headers; `GET /connect` validates the
  state in the control plane and sets the CSRF cookie before redirecting to Meta.
- **CSRF/state mitigation (`GET /connect`):** `GET /connect` sets a short-lived (2 h, the
  lifetime of the connect state, which nothing extends), `httpOnly`, `SameSite=Lax` cookie
  (`eccos_connect_state`) carrying a random OAuth `state` before redirecting to Meta; it also
  sets `secure` on public HTTPS origins and omits it for localhost HTTP development. On the
  callback it compares the query `state` against the cookie value with `constantTimeEqual`
  (`oauthStateIsValid` in `connect.ts`) and fails closed (`400`) on a missing or mismatched
  value, clearing the cookie either way. This blocks an attacker from tricking a victim's browser
  into completing an OAuth exchange the victim didn't initiate.
- **Console return (`return_to`) mitigation:** the callback hands the operator back to the console
  instead of ending on the gateway's own result page (eccos-5z9). The return URL is accepted **only**
  on the RPC entrypoint (`startConnectForAccountId`), never on the public `POST /connect/start`, so
  it comes from the dashboard's own canonical origin — the console server entry has already rejected
  any other `Host` before the server function runs — and never from a browser parameter. The control
  plane validates it on write (absolute `https`, or `http` on localhost, no embedded credentials,
  length-capped) and `connectReturnUrl` validates it again on every use; anything that fails falls
  back to the result page rather than redirecting. A mirror cookie (`eccos_connect_return`, same
  flags and path as the state cookie) carries the target through the paths where the single-use
  state row is already gone (expiry, replay). Only the closed `ConnectFailureCode` vocabulary
  travels in the return URL, so a Meta Graph error message never lands in browser history.
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

### 3.3b Embedded Signup via the Facebook JavaScript SDK (dashboard)

The console's **Connect WhatsApp** button prefers Meta's JavaScript SDK over the server-side
redirect, because Meta's coexistence requirements demand *session logging* — a `message` listener on
the spawning page — which a redirect cannot provide.

**This loads `https://connect.facebook.net/en_US/sdk.js` into the console's origin.** It is the first
and only third-party script in the console, it runs with full access to that origin, and **there is
no Content-Security-Policy anywhere in this repository** to constrain it. That is a real, accepted
exposure, not an oversight; a CSP is separate work with its own blast radius.

What bounds it today:

- **Local.** The script is injected when the connect fork mounts (so the click can open Meta's window synchronously), from the Numbers page only. It is not in the
  base bundle and never loads on a page that renders message content, delivery payloads or keys.
- **Nothing valuable is on the page.** The dashboard holds no account API key in the browser at all;
  the authorization code is posted to a session-authenticated server function within its 30-second
  life and exchanged behind the private `GATEWAY` binding, where the app secret lives.
- **Optional.** Clearing `META_APP_ID` or `META_ES_CONFIG_ID` on the dashboard turns the SDK path
  off entirely and reverts to the redirect, with no code change and no deploy of new code.
- **The listener is not a door.** `parseSessionEvent` requires an `https` origin whose hostname is
  `facebook.com` or a subdomain — deliberately stricter than Meta's published sample, which uses
  `origin.endsWith('facebook.com')` and so accepts `notfacebook.com`. Everything else is dropped,
  and the server function re-validates the payload rather than trusting the client check.
- **The payload is identifiers only.** The event, the abandoned screen, Meta's error code and
  session id, and the WABA/phone ids — never the authorization code, never a token, never message
  content.

Residual risk: a compromise of `connect.facebook.net` would execute in the console's origin for any
operator who clicks Connect, with access to their session cookie. Mitigating that properly needs a
CSP with a pinned `script-src`, which is tracked separately.

### 3.4 Dashboard behind Better Auth + the RPC service binding

- **Surface:** the operator console (`apps/dashboard/`) renders gateway status, the message and
  event logs and the forwarding queue, exposes operator actions (retry delivery, rotate subscriber
  config, resubscribe),
  and starts account-bound Embedded Signup through `GatewayRPC.startConnect()`.
- **Mitigation, host:** the custom server entry (`src/server.ts`) answers only the hostname in
  `BETTER_AUTH_URL` (plus localhost in development) and returns `403` for anything else before
  routing, so the raw `*.workers.dev` and preview origins are not alternate paths. With
  `BETTER_AUTH_URL` unset or not HTTPS, every public host fails closed.
- **Mitigation, session:** every page load, loader and server function resolves the Better Auth
  session server-side; anonymous requests are redirected to `/signin` or refused. The tenant is
  re-derived on each call from session → organization membership → `organization_accounts` →
  account, and every operation checks an organization permission (`view`/`operate`/`configure`/
  `administer`/`erase`). Browser-supplied organization, account or WABA ids are never
  authorization evidence. The full contract is in [auth-tenancy-contract.md](./auth-tenancy-contract.md).
- **Mitigation, transport:** the dashboard reaches the gateway only via a Cloudflare service
  binding to the `GatewayRPC` `WorkerEntrypoint` (`apps/gateway/src/rpc.ts`) — not HTTP. This
  binding is not addressable from the public Internet at all; there is no URL to leak or CORS
  policy to misconfigure, because there is no operator route. The one browser handoff exception is
  the returned, short-lived gateway `/connect?state=...` URL; the OAuth callback remains on the
  gateway's public origin and the state is bound to the organization's account.
- **What the operator API returns:** `GatewayRPC.getSubscriberConfig()` returns only
  `{ url, hasSecret, lastForward }` — never the `SUBSCRIBER_SECRET` value itself (`gateway.ts`
  comment: "Never exposes the secret"). `lastForward` is delivery-queue metadata (status,
  attempts, timestamps, `last_error`) about the newest row, and carries no credential. `GatewayRPC.getConfig()` and `exportData()` filter private keys before
  returning config. The data-plane config table can contain the subscriber secret for forwarding,
  but access tokens are stored only in the control plane, encrypted at the application layer, and
  no private value is returned by the operator API.

### 3.5 `apps/mcp` and the console's OAuth authorization server

This surface is specified in [openspec/changes/add-mcp-server](../openspec/changes/add-mcp-server/)
(design § 2, § 3, § 5) and does not exist in the code yet. Each bullet is a requirement; tasks 1.2
to 1.10 of that change build them, and this section names the file once a mitigation lands.

- **Surface:** `apps/mcp` serves MCP over Streamable HTTP at `/mcp` on its own host, plus its
  protected-resource metadata. It holds no storage and no credential that grants access. Its one
  secret, `REQUEST_STATE_KEY`, seals the approval state; a leaked key can forge an approval state,
  which still cannot run a tool, because elevation is re-read from `authorize` on every request. It
  reaches the rest of Eccos only through the `ConsoleRPC` and `GatewayRPC` service bindings. The console gains the OAuth
  endpoints listed in [auth-tenancy-contract.md](./auth-tenancy-contract.md) §9, the workspace,
  consent, approval, and claim pages, Connected agents in Settings, and `POST /api/claim`.
- **Mitigation, the token is a pointer:** `apps/mcp` never verifies or parses a token itself. It
  passes it to `ConsoleRPC.authorize`, which verifies it in process (signature, issuer, audience
  equal to the MCP resource, expiry, `typ: at+jwt`, `azp`) and then re-reads the grant, the
  membership, the current role, and the account link on every request (contract §1). Nothing about
  authorization is cached in `apps/mcp`. Every refusal is the same `401` challenge. A request
  with a missing or malformed bearer is refused in `apps/mcp` before any RPC.
- **Mitigation, one workspace per grant:** the person picks the workspace at consent from their own
  memberships. No tool takes an organization or account id, so an agent cannot address another
  tenant; WABA and phone ids are checked against the account by the gateway.
- **Mitigation, role ∩ scope:** a tool runs only when both the user's live role and the grant's
  scopes allow it (contract §4). No scope allows erasure.
- **Mitigation, sensitive tools need elevation:** the tools behind the contract's step-up rows run
  only while the grant holds an elevation that its own user, as owner or admin, approved with TOTP
  within the step-up window. A token cannot create one. Step-up tools do not ship before the
  console enforces step-up itself.
- **Mitigation, secrets stay out of the model:** a minted API key or subscriber secret is delivered
  by a single-use claim. The claim stores only its intent, and the secret is minted in the same
  control-plane call that spends it.
- **Mitigation, origins:** the console's pages and cookies keep the one-origin rule (contract §6).
  Only the token, registration, JWKS, and metadata endpoints answer cross-origin, and they read no
  cookie. `apps/mcp` refuses a browser request whose `Origin` it does not allow.
- **Mitigation, clients:** client ID metadata documents are fetched over HTTPS only, with
  `global_fetch_strictly_public`, no redirects, and size and time caps. Dynamic registration is
  rate-limited per address. Consent is never skipped, and the consent page shows the redirect host
  next to the client name, because whoever registers a client chooses its name.
- **Mitigation, audit and abuse:** every mutating tool writes one audit line with ids, the tool,
  the client id, and the outcome, extended by `via: "mcp"`. `/mcp` has a per-user and
  per-client rate limit, and sends still pass the gateway's `SEND_RATE_LIMITER` on the same key
  as `/v1`.

## 4. Threats mapped to mitigations (and residual risk)

| Threat | Mitigated by | Residual risk |
|---|---|---|
| Forged/replayed Meta webhook | `verifyMetaSignature` + constant-time compare + unique indexes on `inbound_events` | None significant; HMAC verification happens before JSON parsing. |
| Misattributed signed webhook without phone metadata | Registered WABA filtering in `worker.ts`; the WABA id is the authoritative routing key | The event is retained at WABA scope when `phone_number_id` is absent, so phone-level attribution is unavailable. |
| Timing attack on webhook/API-key comparison | `constantTimeEqual` (XOR-accumulate, length-checked first) | The webhook **subscription** `hub.verify_token` check uses plain `===`, not `constantTimeEqual` — low severity (low-value, one-time setup token; Meta calls it directly), but inconsistent with the rest of the codebase. |
| Stolen Durable Object storage / database export | Meta access tokens are stored as AES-256-GCM `ecs1.` envelopes keyed by the `ECCOS_TOKEN_ENCRYPTION_KEY` Worker secret and bound to `<accountId>:<wabaId>`, so a storage-level compromise yields no usable business token; account API keys are already SHA-256 hashes | An attacker holding *both* the storage dump and the Worker secret recovers the tokens. The key is not rotatable in place: re-keying means reconnecting every number. |
| Stolen/leaked API key | Account-key hash lookup, revocation, WABA ownership checks, and rate limit on send | A leaked account key grants access to every WABA owned by that account until revoked; the admin bootstrap key remains deployment-wide. |
| Forged forwarded event reaching the subscriber | `X-Eccos-Signature: sha256=<hex>` via `signPayload`, using `SUBSCRIBER_SECRET` | The subscriber's own verification is out of this repo's control — if a subscriber implementation skips verification, forgery is possible from anyone who can reach its webhook URL. Document this expectation clearly for integrators. |
| Unauthorized WABA rebind via `/connect/exchange` | Account-key gate plus single-use account-bound OAuth state and ownership-conflict checks; valid Meta OAuth code required (see §3.3) | A failed external exchange after state consumption requires a new connect attempt. |
| Subscriber URL SSRF | Rotated subscriber URLs require HTTPS, no credentials, and reject private/special IP literals; forwarding validates the stored value too and rejects redirects | DNS rebinding after save-time validation remains possible because Workers does not expose a general DNS-resolution API to application code. |
| Dashboard reached on a host other than its own (`*.workers.dev`, previews) | Host allowlist from `BETTER_AUTH_URL`, enforced before routing, fail-closed | A public dashboard deployment answers `403` until `BETTER_AUTH_URL` is set. Only localhost development remains intentionally open. |
| Operator console leaking message content to the wrong person | Better Auth session plus organization membership, re-derived server-side on every request; data is scoped to the organization's account | The dashboard renders raw inbound message text (`apps/dashboard/src/routes/events.tsx` via `eventReading()` in `src/lib/logs.ts`) and, in the event inspection sheet, the whole stored event JSON verbatim, to any member with `view` — so organization membership *is* the access-control boundary for message content, not a separate per-field redaction. |
| DoS via flooding `/webhooks/meta` with invalid signatures | Cloudflare edge DDoS protection (platform-level, outside this repo) | No application-level rate limiting on the two public unauthenticated routes (`GET`/`POST /webhooks/meta`), unlike `/v1/wabas/<WABA_ID>/messages`. Each invalid POST still costs one HMAC computation before rejection. |
| Per-WABA Durable Object as an availability/scale boundary | N/A (architectural choice, not a security control) | Each WABA's reads/writes serialize through its own versioned DO; tenant state is not a global singleton, but there is no cross-region replica. |
| Stolen OAuth access or refresh token | Access tokens live 10 minutes; refresh tokens rotate with replay detection; every request re-checks the grant; Revoke under Connected agents; step-up tools also need a live elevation, which a token cannot create (§3.5) | Until revoked, the thief acts as the user within the granted scopes in one workspace, and can use step-up tools only inside an elevation the person already approved. |
| Token replayed against another resource, or a session JWT presented as an access token | `aud` must equal the MCP resource; `typ: at+jwt` and `azp` required; the session-JWT route `/api/auth/token` is disabled | None known. Better Auth 1.7 recognises access JWTs by `azp`, and nothing in Eccos signs other JWTs with that key. |
| Confused deputy: the agent's token forwarded onward | The token stops at `apps/mcp`; `GatewayRPC` receives an account id over a private binding, never a bearer value | None. |
| Cross-tenant access through an agent | No tool takes a tenant id; the account comes from the grant's workspace, re-resolved on every request; the gateway re-checks WABA and phone ownership | The same as the console's, plus `apps/mcp` as a second place where a bug could pass the wrong account. Each tool gets a negative two-account test. |
| Stale privilege after a role change or removal | Role and membership are read on every MCP request, and token issuance refuses a non-member | One request. |
| Malicious or look-alike OAuth client (open registration) | Consent is never skipped; the consent page shows the redirect host; step-up tools need a separate elevation; registration is rate-limited | A person can still approve a client they should not. This is phishing; the grant is visible and revocable under Connected agents. |
| Prompt injection: a WhatsApp message tells the agent to act | Reading conversations and writing use different scopes; step-up tools need an elevation that a person approved knowing which tool asked; destructive tools carry `destructiveHint`; erasure is not exposed | **Real, and Eccos cannot remove it.** An agent that holds `eccos:view` and `eccos:send` and reads hostile inbound text can be talked into sending, and during an elevation into a step-up tool. Customer docs recommend separate grants for reading conversations and for administration. |
| Secrets in the model's context | Minted secrets are delivered by a claim, so the value goes from Eccos to its destination | Inline delivery when the caller asks for it; a subscriber secret the caller supplies; the connection link, which is meant to be handed to a person. None is ever logged. |
| Claim token intercepted (a bearer value for 10 minutes that passes through the model) | Single use; `POST` only, so previews and scanners neither read nor spend it; the token travels in the body or the URL fragment, never a path or query; nothing exists until it is spent; a per-caller limit on wrong tokens; it stops resolving when its creator loses the right | Whoever reads the agent's context inside the window and redeems first gets the secret. The rightful redeemer then gets `410`, which is the signal to revoke the key, by then visible under its label. |
| Elevation abused: an agent asks for an approval the person did not expect | The approval page names the agent, the workspace, and the tool that asked; it needs the grant's own user, signed in, with TOTP; a request expires in 10 minutes, and one is pending per grant | Sudo semantics: once approved, every step-up tool is open to that agent for 24 hours, not only the one that asked. The person can end it early. |
| Approval link sent to the wrong person | The link is a pointer; only the grant's user, still an owner or admin, can approve | None. |
| Spend and abuse through agent sends | `eccos:send` is its own scope; a per-user, per-client rate limit on `/mcp`; `GatewayRPC` sends pass `checkSendRate` on the same `accountId:wabaId` key as `/v1` | The account's send budget is shared by the agent, the console, and `/v1`. |
| SSRF through client ID metadata document fetches | HTTPS only, `global_fetch_strictly_public`, no redirects, size and time caps | Weaker than the DNS pinning Better Auth's docs ask for; a Worker has no internal network to reach. |
| Flooding the MCP and OAuth endpoints | Cloudflare edge; the Rate Limiting binding on `/mcp`; Better Auth's rate limiter on the OAuth endpoints | `ConsoleRPC.authorize` costs D1 reads per request. A request without a well-formed bearer never reaches it. |
| Secrets/content in logs | The Workers target's `logEvent()` (`apps/gateway/src/worker.ts`) emits one structured JSON line per notable route outcome (event name, correlation id from `cf-ray`, HTTP status, and an explicit `LogMeta` allowlist typed as `string \| number \| boolean \| null \| undefined` — no nested objects). Every call site passes only ids, counts, booleans, or enum-like strings (`mode`, `path`, `bodyBytes`, `eventCount`, `messageType`, `messageId`, `limit`/`count`, `configOk`/`missingConfig` key names) — never a recipient number, message body, or secret value; the code carries an explicit "never pass message bodies, full phone numbers, tokens, API keys, or signatures" comment. The Bun target (`src/`) still has only two `console.*` calls total (`src/index.ts` boot message, `src/delivery/forward.ts` delivery-loop error), neither logging a secret or body. | Cloudflare Workers observability is enabled at `head_sampling_rate: 1` (`apps/gateway/wrangler.jsonc`) — captures whatever *is* logged. The `LogMeta` type prevents accidentally passing a whole object/body, but a developer could still pass a string field containing sensitive text at a future call site — this is a strong convention plus a type-level guard, not an automated content scan. See `docs/privacy.md`. |

## 5. Out of scope / explicitly not modeled

- Paid-customer isolation evidence — one dashboard serves many organizations, each linked to its
  own account (§3.4), but the end-to-end isolation matrix is not complete. The first-paid-customer
  gate in `PRODUCTION-READINESS.md` must clear before third-party Cloud customers are charged.
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
