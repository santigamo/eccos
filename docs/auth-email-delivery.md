# Auth email delivery — operational runbook (eccos-0x0.11)

How the customer dashboard delivers Better Auth emails (verification, password
reset, and later invitations/security notices), and what operating it requires.

The interface is `MailSender` (`apps/dashboard/src/auth/mail.ts`); the provider
adapter is `ResendMailSender` (`apps/dashboard/src/auth/mail-resend.ts`),
selected automatically in `src/auth/config.ts` when `RESEND_API_KEY` is
configured. Without the key, development uses `ConsoleMailSender` (logs the
recipient domain and subject only — never message URLs, which carry
action-capable tokens).

## Provider: Resend

Chosen for a first-party Cloudflare Workers send path (plain REST over fetch)
and EU-region sending domains. [API docs](https://resend.com/docs/api-reference/emails/send-email).

### Secrets (Worker secrets only — never in the repo)

```bash
cd apps/dashboard
wrangler secret put RESEND_API_KEY   # re_xxx — Resend API key
wrangler secret put BETTER_AUTH_SECRET
```

Non-secret configuration (`wrangler.jsonc` vars or deploy script):

- `MAIL_FROM` — verified sending identity, e.g. `Eccos <noreply@notify.eccos.chat>`.
  Defaults to the Resend sandbox sender in development only.

### Domain + DNS

1. Add a **sending subdomain** in the Resend dashboard (deliverability best
   practice; e.g. `notify.eccos.chat`), region **EU (Frankfurt)** to match the
   auth D1 residency stance (contract §3).
2. Add the DNS records Resend shows for the subdomain:
   - **SPF**: TXT on the subdomain including `include:amazonses.com`.
   - **DKIM**: the two TXT/CNAME records Resend generates (2048-bit key).
   - **DMARC**: TXT `_dmarc.eccos.chat` starting at `p=none` with `rua=` reports,
     moving to `p=quarantine` once alignment is confirmed.
   - **Return-Path**: MX/CNAME for the bounce subdomain Resend provides.
3. Wait for the domain to show **Verified** before relying on delivery.

### Inbound events (bounces / complaints)

Resend posts delivery events via webhooks
([event types](https://resend.com/docs/webhooks/event-types.md), request
verification via signing secret
[here](https://resend.com/docs/webhooks/verify-webhooks-requests.md)). v1
posture:

- Register a webhook endpoint for `email.bounced` / `email.complained` /
  `email.delivery_delayed` events; verification of the signing secret is
  REQUIRED before acting on payloads.
- Bounce handling: hard bounces on verification/reset emails are surfaced in
  the Resend dashboard; a repeat-bounce address should be excluded from
  future sends (mail-provider-side suppression is acceptable for v1).
- This is monitoring/abuse plumbing only: it must never gate sign-in (no
  account state depends on email events), so the failure domain stays inside
  the identity plane.

### Rate limits and anti-abuse

- Better Auth's own rate limiting (enabled in eccos-0x0.7) throttles
  verification/resend/invitation endpoints; the Resend API rate limit is a
  second, separate ceiling (see account settings).
- Verification resend is user-triggered and rate-limited; invitation emails
  are only sent to verified addresses (contract §7).
- Anti-enumeration: sign-up and password-reset responses are generic
  (Better Auth behavior with `requireEmailVerification: true`).

### Failure behavior (contract §10)

- Adapter errors **throw** — a failed send fails the auth flow closed rather
  than silently losing the verification/reset email. Resend retries transient
  API failures internally; the dashboard surfaces a bounded error to the user.
- Provider outage: sign-up/verification/reset/invitation flows degrade to an
  explicit error state; sign-in of already-verified users is unaffected;
  gateway webhook ingestion (`/webhooks/meta`) is fully independent of the
  identity plane.

### Privacy / DPA

- Identity-plane data (emails, tokens) lives in the auth D1 and the mail
  provider only — never in gateway DOs, payloads, or logs (contract §3).
- Record Resend as a subprocessor in the Eccos DPA package (eccos-8yy): data
  processed = recipient email address + message content; retention per Resend
  defaults; region = EU-selected sending domain; SCCs per Resend DPA.
- Raw invitation/reset tokens and URLs are never logged anywhere in the
  dashboard (adapter logs recipient domain + subject only).

## Local testing

No provider is needed locally: without `RESEND_API_KEY` the dev sender logs
instead of sending, and tests use `CaptureMailSender`
(`tests/auth.test.ts`) to assert on the produced emails.
