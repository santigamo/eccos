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
- **API routes** (`/v1/*`) require an account API key — a Bearer token / `x-api-key` resolved to
  a hashed account key in the control plane — and verify WABA ownership before touching a
  data-plane object. The Bun target (`src/`) keeps its single `ECCOS_API_KEY` for its single
  tenant.
- **Forwarded events** are signed with `X-Eccos-Signature: sha256=<hex>` using
  `SUBSCRIBER_SECRET` so your subscriber can verify they came from Eccos.
- **Secrets** live only in `.env` (Bun target, gitignored), as `wrangler secret` values, or in
  Cloudflare-encrypted control-plane storage for tenant Meta tokens. Tenant Meta tokens are not
  application-encrypted and are never returned by operator APIs, committed to the repository, or
  written to logs. Account API keys are stored only as SHA-256 hashes and are returned once at issue.

## Data handling & logging

- Message content (inbound reply/echo text, outbound request bodies), API tokens, and other
  secrets are **not written to logs**, on either target. The Workers target's structured JSON
  logging (`apps/gateway/src/worker.ts`, `logEvent()`) is restricted at the type level to ids,
  counts, booleans, and enum-like strings (`LogMeta`) — never bodies, phone numbers, or secret
  values; the Bun target logs only a boot message and delivery-loop errors. See
  [`docs/privacy.md`](docs/privacy.md#5-data-handling-in-logs) for the full breakdown.

## Hardening notes

- Always set a strong, random `META_WEBHOOK_VERIFY_TOKEN`, `ECCOS_ADMIN_API_KEY` (Workers), and
  `SUBSCRIBER_SECRET` (`ECCOS_API_KEY` on the Bun target).
- Serve Eccos over HTTPS (the Workers target gives you a stable HTTPS URL for free).
- On Workers, per-account Meta tokens are stored in the control plane — rotate a WABA's token by
  re-registering the WABA if one is suspected exposed.
- If you use the provided `Dockerfile`, the included `.dockerignore` keeps `.env` and local
  data out of the image — keep it that way.
