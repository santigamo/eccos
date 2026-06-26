# Security Policy

Eccos handles credentials for the Meta WhatsApp Cloud API and verifies signed webhooks, so
we take security seriously.

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

## Hardening notes

- Always set a strong, random `ECCOS_API_KEY`, `META_WEBHOOK_VERIFY_TOKEN`, and
  `SUBSCRIBER_SECRET`.
- Serve Eccos over HTTPS (the Workers target gives you a stable HTTPS URL for free).
- Rotate your `META_ACCESS_TOKEN` if you suspect exposure.
- If you use the provided `Dockerfile`, the included `.dockerignore` keeps `.env` and local
  data out of the image — keep it that way.
