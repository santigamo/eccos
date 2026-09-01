# Auth email delivery — operational runbook (eccos-3ne)

How the customer dashboard delivers Better Auth emails (verification, password
reset, invitations), and what operating it requires.

The interface is `MailSender` (`apps/dashboard/src/auth/mail.ts`); the provider
adapter is `ReccadoMailSender` (`apps/dashboard/src/auth/mail-reccado.ts`),
selected automatically in `src/auth/config.ts` when `RECCADO_API_KEY` is
configured. Without the key, development uses `ConsoleMailSender` (logs the
recipient domain, the template, and the hashed idempotency key only — never
message URLs, which carry action-capable tokens).

This replaced Resend outright in eccos-3ne. There is no dual-provider or
fallback path: while there are no customers, a second live send path is only a
second thing to be wrong.

## Provider: reccado

A template-based transactional API over plain `fetch`, so the send path has no
Node-only dependencies in the Worker.

### The frozen contract

```
POST <base>/v1/mailboxes/{mailboxId}/transactional/messages
Authorization: Bearer <key>
Idempotency-Key: <caller-chosen, MANDATORY — 400 without it>
Content-Type: application/json        # 415 otherwise; 100 KB body cap
{"template":"verify-email","to":"user@example.com","variables":{"name":"…","url":"…"}}
```

| Status | Body | Meaning | What the adapter does |
|---|---|---|---|
| `200` | `{"status":"sent"}` | Delivered to the provider | `{status:"sent"}` |
| `200` | `{"status":"duplicate"}` | Replay of a stored key; not re-sent | `{status:"sent", deduplicated:true}` |
| `202` | `{"status":"accepted"}` | Queued | `{status:"sent"}` |
| `502` | `{"status":"permanent_failure"}` | Definitively did not arrive | `{status:"undeliverable", reason:"permanent_failure"}` |
| `504` | `{"status":"unknown"}` | **Terminal**, see below | `{status:"unresolved"}` |
| `403` | `{"status":"recipient_suppressed"}` | Address blocked at the provider | `{status:"undeliverable", reason:"recipient_suppressed"}` |
| `400` | `idempotency_key_required` | We omitted the header | **throws** |
| `401` | `missing_authorization` | No bearer token reached the provider | **throws** |
| `403` | anything else | `invalid_api_key`, `insufficient_scope`, `key_expired`, `key_revoked`, `template_not_allowed`, `template_not_found`, `denied_by_policy`, `test_key_not_allowed_in_production_send` | **throws** (misconfiguration) |
| `409` | `idempotency_conflict` | Same key, different payload | **throws** (the key derivation is broken) |
| `415` | — | Body was not `application/json` | **throws** |
| `429` | `quota_exceeded` | Sending budget exhausted | **throws** — should alarm |

The three outcomes (`sent`, `unresolved`, `undeliverable`) are delivery facts
and never throw. Everything that throws indicates a bug in this code or an
operational emergency.

### `unknown` (504) is TERMINAL — do not build a retry loop

Re-confirmed with the provider: a replay under the same key returns the
**stored** status without re-asking the provider, and delivery events cannot
resolve it either, because they correlate by a provider message id that is
`null` precisely when the outcome is unknown. There is nothing to retry and
nothing to poll.

The structured `warn` event emitted at send time is therefore the **entire**
record that a message was ever in doubt:

```json
{"level":"warn","area":"auth-mail","event":"send-unresolved",
 "template":"verify-email","toDomain":"example.com","idempotencyKey":"<sha256 hex>"}
```

It carries the recipient's **domain**, the template, and the **hashed** key —
never the URL, which carries an action-capable token. No call site throws on
`unresolved`: the check-your-inbox screen already offers a resend, and failing a
user's flow over a message that probably arrived is worse than the doubt.

### Idempotency keys

The `Idempotency-Key` header is **mandatory** and is always a SHA-256 hex digest
(`deriveIdempotencyKey` in `src/auth/mail.ts`):

| Template | Key |
|---|---|
| `verify-email` | `sha256("verify-email:" + to + ":" + <verification token>)` |
| `reset-password` | `sha256("reset-password:" + to + ":" + <reset token>)` |
| `invite-member` | `sha256("invite-member:" + to + ":" + invitation.id)` |

The property that makes this correct: **the key derives from the unique element
of the payload, so key and payload move together.** A framework retry replays
the same token and dedupes into `duplicate` (no second mail); a user-initiated
resend mints a fresh token and therefore genuinely sends; and `409
idempotency_conflict` — same key, different payload — becomes impossible by
construction.

**Never put a raw token in the header.** The provider stores
`client_idempotency_key` deliberately and never purges it, so a raw verification
or reset token there would leave a live, action-capable credential in a third
party's storage permanently. The token is read out of the URL Better Auth hands
the callback (`extractTokenFromUrl`); the URL itself is never hashed.

> **A future "resend invitation" button MUST be cancel-plus-recreate.** Better
> Auth's reuse-the-same-invitation resend keeps the same invitation id and only
> extends `expiresAt`, so the payload is identical under an identical key and
> the provider dedupes it into `duplicate`: **the mail silently never sends**
> while the console reports success. Cancelling and creating a new invitation
> mints a new id, hence a new key, hence a real send. The console has no resend
> invitation UI today; the note is in `src/auth/auth.ts` at `sendInvitationEmail`.

### Templates

Three templates: `verify-email`, `reset-password`, `invite-member`. Each one's
declared variable set is **one explicit constant** in `src/auth/mail.ts`
(`VERIFY_EMAIL_VARIABLES`, `RESET_PASSWORD_VARIABLES`,
`INVITE_MEMBER_VARIABLES`), so a provider-side rename is a one-line change.

**Variable validation is exact in both directions**: a missing declared
placeholder *or* an extra undeclared variable is a hard reject. The adapter
checks the set locally before sending, so a mismatch surfaces as the local bug
it is instead of an opaque 403. Escaping is the provider's: a variable declared
`html` is HTML-escaped on interpolation and a `text` one is not, so we always
send plain strings and never pre-escape.

> The declared sets are being registered provider-side and are **not yet
> final**. When they settle, update the constants — and only the constants.

### Per-flow policy

The same status means different things to different flows, so the policy lives
at the call sites (`applyVerificationSendPolicy`, `applyResetSendPolicy`,
`applyInvitationSendPolicy` in `src/auth/auth.ts`):

| Flow | `unresolved` | `undeliverable` |
|---|---|---|
| Sign-up / verification | log, continue | **surface** — bounded, membership-neutral message |
| Password reset | log, continue | **swallow**, log, keep the generic response |
| Invitation | log, continue | **surface** to the inviter |

- **Sign-up may surface it** because an existing account short-circuits *before*
  any send happens, so it discloses the deliverability of a freshly typed
  address, not membership — and the dominant cause is the user's own typo, which
  only they can fix.
- **Password reset must not**, ever. `sendResetPassword` only runs for accounts
  that exist, so any observable difference there is a membership oracle.
- **Invitation may**, because the inviter is authenticated and typed the address.
- **`recipient_suppressed` gets its own message** ("email to this address is
  currently blocked"), never the typo message: retyping cannot fix a suppression.

> **Known gap — better-auth 1.7.2 swallows these throws at two of the three call
> sites.** Sign-up (`dist/api/routes/sign-up.mjs`), forgot-password
> (`dist/api/routes/password.mjs`) and create-invitation
> (`dist/plugins/organization/routes/crud-invites.mjs`) all wrap the send in
> `ctx.context.runInBackgroundOrAwait` (`dist/context/create-context.mjs:214`),
> which awaits the promise inside a `try/catch` and merely **logs** a rejection.
> So the sign-up and invitation `undeliverable` messages do not reach the
> response today; only `POST /send-verification-email` re-throws
> (`dist/api/routes/email-verification.mjs:117`). The policy is written to the
> contract regardless — it is correct, it starts surfacing the moment better-auth
> propagates, and the structured log is the durable record meanwhile. The
> behaviour is pinned by a test in `tests/mail-policy.test.ts` so it fails loudly
> when it changes. (Incidentally this is *why* the reset flow's "swallow" is
> belt-and-braces rather than the only thing standing between us and an oracle.)

### Configuration

```bash
cd apps/dashboard
wrangler secret put RECCADO_API_KEY     # provider API key
wrangler secret put RECCADO_ENDPOINT    # full message endpoint (see below)
wrangler secret put BETTER_AUTH_SECRET
```

`RECCADO_ENDPOINT` is the whole message endpoint, mailbox id included:

```
https://<host>/v1/mailboxes/<mailboxId>/transactional/messages
```

**One setting, not a host plus a mailbox id.** An API key addresses exactly one
mailbox — the binding is fixed when the key is minted, from the owning Durable
Object's name, and there is no way to mint a multi-mailbox key. A separate
mailbox id could therefore only ever agree with the key or contradict it: it
adds no information, only a way to be wrong. And it is wrong *misleadingly*,
because keys live inside the owning mailbox's own Durable Object: a key minted
for mailbox A, presented against mailbox B's path, is looked up in B's storage,
is simply absent, and comes back **`403 invalid_api_key`** — so the operator is
told their key is bad when what is actually bad is their pairing. Carrying one
value makes that failure unreachable. Do not split it back apart.

The host stays configuration rather than a constant: the provider's custom
domain currently sits behind Cloudflare Access and answers only on its
`workers.dev` host, the contract is identical on both, and hardcoding either
would strand the deployment the moment the other becomes live.

It is a **secret, not a var**: it carries the provider host, and
`apps/dashboard/wrangler.jsonc` is in a public repo — the Cloudflare account
subdomain deliberately stays out of it.

The adapter validates the value at construction and fails closed: it must be an
absolute URL, `https` (`http` only on `localhost`/`127.0.0.1`/`[::1]`, the same
carve-out `validatePublicOrigin` makes in `apps/gateway`), and it must carry no
credentials, query string, or fragment. A malformed endpoint refuses to boot
rather than failing at the first send. A key without an endpoint is likewise a
half-configured deployment, not a degraded one.

There is no separate status-lookup setting, and there must never be one: the
provider's status endpoint is this same string plus `/<requestId>`. The adapter
has no status lookup today (a `504 unknown` is terminal by design), so if one is
ever added it derives its URL that way.

### Inbound events (bounces / complaints)

**Not applicable — reccado has no outbound webhook.** This section is not
deleted silently because the previous provider had one and its absence is a
design property, not an omission: the synchronous status codes are what make
the send path self-reporting. `502` already says a message definitively did not
arrive and `403 recipient_suppressed` already says the address is blocked, both
*at send time*, so there is no asynchronous channel to verify, no signing secret
to hold, and no bounce endpoint to expose. Suppression is maintained
provider-side and surfaces on the next send.

The corollary is the one in the `unknown` section: a `504` is never resolved
later, because there is no later.

### Rate limits and anti-abuse

- Better Auth's own rate limiting throttles the verification / resend /
  invitation endpoints (`rateLimit.customRules` in `src/auth/auth.ts`); the
  provider's quota is a second, separate ceiling. A `429` (or `403
  quota_exceeded`) throws and should alarm.
- Verification resend is user-triggered and rate-limited (5 per 300 s,
  eccos-hk5); invitation emails only go to verified addresses (contract §7).
- Anti-enumeration: sign-up and password-reset responses are generic.

### Failure behavior (contract §10)

- The three delivery outcomes never throw; per-flow policy decides what the user
  sees (table above).
- Misconfiguration, contract violations and quota exhaustion **throw**, so a
  broken deployment fails loudly instead of silently dropping mail.
- Provider outage: verification/reset/invitation degrade to an explicit error
  state; sign-in of already-verified users is unaffected; gateway webhook
  ingestion (`/webhooks/meta`) is fully independent of the identity plane.

### Privacy / DPA

- Identity-plane data (emails, tokens) lives in the auth D1 and the mail
  provider only — never in gateway DOs, payloads, or logs (contract §3).
- Record reccado as a subprocessor in the Eccos DPA package (eccos-8yy): data
  processed = recipient email address + template variables; note that the
  provider **retains `client_idempotency_key` indefinitely**, which is why that
  value is a SHA-256 digest and never a raw token.
- Raw invitation/reset tokens and URLs are never logged anywhere in the
  dashboard. Logs carry the recipient domain, the template, and the hashed key.

## Local testing

No provider is needed locally: without `RECCADO_API_KEY` the dev sender logs
instead of sending. Tests use `CaptureMailSender` (`tests/auth.test.ts`,
`tests/mail-policy.test.ts`) to assert on the produced messages, and
`tests/mail-reccado.test.ts` drives the adapter against a mocked `fetch` to pin
every documented status.
