# Security Policy

Eccos handles credentials for the Meta WhatsApp Cloud API and verifies signed webhooks, so
we take security seriously.

For a deeper, code-grounded write-up of assets, trust boundaries, attack surfaces, and residual
risks, see [`docs/threat-model.md`](docs/threat-model.md). For what personal data Eccos stores,
for how long, and how an operator can inspect/export/delete it, see
[`docs/privacy.md`](docs/privacy.md).

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):
go to the repository's **Security** tab → **Report a vulnerability**.

Please include a description, reproduction steps, and the impact you foresee. We aim to
acknowledge reports within a few days and will keep you updated on the fix.

## Supported versions

Eccos is pre-1.0. Security fixes are applied to the latest `main`. Pin a commit if you need
stability and watch the repository for advisories.

## Security model

- **Inbound webhooks** are authenticated by verifying Meta's `X-Hub-Signature-256`
  (HMAC-SHA256 over the raw body with your `META_APP_SECRET`) using a **constant-time**
  comparison. Requests with a missing or invalid signature are rejected with `401`.
- **API routes** (`/v1/*`) require a Bearer token / `x-api-key` matching `ECCOS_API_KEY`,
  also compared in constant time.
- **Forwarded events** are signed with `X-Eccos-Signature: sha256=<hex>` using
  `SUBSCRIBER_SECRET` so your subscriber can verify they came from Eccos.
- **Secrets** live only in `.env` (Bun target, gitignored) or as `wrangler secret` values
  (Workers target) — never in the repository or in logs.

## Data handling & logging

- Message content (inbound reply/echo text, outbound request bodies), API tokens, and other
  secrets are **not written to logs**, on either target. The Workers target's structured JSON
  logging (`apps/gateway/src/worker.ts`, `logEvent()`) is restricted at the type level to ids,
  counts, booleans, and enum-like strings (`LogMeta`) — never bodies, phone numbers, or secret
  values; the Bun target logs only a boot message and delivery-loop errors. See
  [`docs/privacy.md`](docs/privacy.md#5-data-handling-in-logs) for the full breakdown.

## Hardening notes

- Always set a strong, random `ECCOS_API_KEY`, `META_WEBHOOK_VERIFY_TOKEN`, and
  `SUBSCRIBER_SECRET`.
- Serve Eccos over HTTPS (the Workers target gives you a stable HTTPS URL for free).
- Rotate your `META_ACCESS_TOKEN` if you suspect exposure.
- If you use the provided `Dockerfile`, the included `.dockerignore` keeps `.env` and local
  data out of the image — keep it that way.
