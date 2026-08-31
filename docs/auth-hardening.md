# Auth hardening — operations runbook (eccos-0x0.7)

Operational security for the identity plane now that Eccos owns the auth stack.
The tenancy contract (docs/auth-tenancy-contract.md §8) fixes the policy; this
doc records the concrete implementation and the operator responsibilities.

## Implemented controls

### Distributed rate limiting

Better Auth rate limiting stores counters in the **auth D1 database**
(`rateLimit.storage: "database"`) — shared across all Worker isolates, never
per-isolate memory. Configured windows (`src/auth/auth.ts`):

| Path | Window | Max |
|---|---|---|
| default (any auth endpoint) | 60 s | 100 |
| `/sign-in/email` | 300 s | 10 |
| `/sign-up/email` | 3600 s | 20 |
| `/forgot-password` | 3600 s | 10 |
| `/send-verification-email` | 300 s | 5 |
| `/organization/invite` | 3600 s | 50 |

**What a bucket keys on.** Better Auth builds the key as `${callerIP}|${path}`
(`createRateLimitKey`, `@better-auth/core/utils/ip`) — the caller's address and
the route, never the request body. No rule above is a per-recipient guarantee:
they bound one caller. `/send-verification-email` matters most here because it
is unauthenticated and takes an arbitrary caller-supplied address, so every
call puts real mail in a third party's inbox off our sending domain; 5 per
300 s caps one caller at 60 mails/hour against a chosen address (`eccos-hk5`).
An attacker with many source addresses is still only bounded per address —
per-recipient send budgets, if we ever need them, belong to the mail layer.
The IP itself comes from `x-forwarded-for` (Better Auth's default header list);
if no trustworthy client IP can be resolved, every caller shares one bucket per
path, which fails safe for abuse but degrades availability.

Auth server-side calls made inside dashboard server functions do NOT pass
through the HTTP middleware — mutation rate limiting for those lives in the
gateway layer and the D1-level `429` behavior tested in
`tests/hardening.test.ts`.

### Two-factor authentication (TOTP)

- `twoFactor()` plugin enabled; enrollment via `POST /api/auth/two-factor/enable`
  with password (returns `otpauth://` URI + one-time backup codes).
- **Policy (contract §4/§8):** owner/admin must enroll TOTP before performing
  sensitive actions (connect, API keys, export, erasure, membership/role
  changes, subscriber config write). Enforcement rides on Better Auth's
  `sensitiveSessionMiddleware`/fresh-session checks plus the dashboard audit
  path; enrollment UX ships with the security dashboard pass.
- Backup codes are shown once at enrollment; they are hashed at rest like
  passwords and can be regenerated through the two-factor endpoints.

### Session freshness (step-up)

- Session expiry: 7 days; session refresh (`updateAge`): daily.
- `freshAge: 900` (15 minutes) — a sensitive action requires authentication or
  step-up within the last 15 minutes, matching the contract's step-up window.
- Revocation is immediate: sessions are looked up in the auth D1 on every
  request; a revoked/deleted session fails closed on the next protected
  request (no cached claims).

### Email verification

- `requireEmailVerification: true` — no session can be created for an
  unverified address.
- `requireEmailVerificationOnInvitation: true` — invitations only go to
  verified identities.

### Direct Organization endpoint governance

- `disableOrganizationDeletion: true` — `POST /organization/delete` is rejected
  in v1 (no offboarding saga yet).
- Create/invite/role changes wrapped by the dashboard server functions with the
  same permission checks as the matrix; unverified emails are rejected.

### CSRF / cookies / origins

- Cookies: HttpOnly, SameSite=Lax, Secure (https origins).
- Origin validation explicitly ON (`disableOriginCheck: false`) so it cannot be
  silently skipped in any environment.
- `trustedOrigins` is the canonical origin allowlist (§6); unexpected hosts are
  rejected by both the host gate and the auth layer.

### Dependency hygiene

- `better-auth` pinned to an exact version in `apps/dashboard/package.json`
  (no ranges). Upgrade = explicit change + full test suite + advisory review.
- Check advisories before each release: `bun pm ls | grep better-auth` and
  review the better-auth security advisories page. The June 2026 organization
  invitation ownership advisory is the standing reminder to keep this pin
  current.

## Operator responsibilities

- **Secret rotation** (`wrangler secret put BETTER_AUTH_SECRET`): Better Auth
  supports `BETTER_AUTH_SECRETS` (plural) for rolling to a new secret without
  invalidating existing sessions — add the new secret, deploy, remove the old.
- **Auth D1 backups**: point-in-time restore is available on paid D1 plans;
  schedule a weekly `wrangler d1 export` of `eccos-auth` into private storage
  for the free tier. Backups contain identity PII — store encrypted, restrict
  access, and delete with the same care as the live database.
- **D1 deletion/GDPR**: erasure of identity data = delete user rows (cascades
  sessions/accounts/members/twoFactor) via an operator script; WhatsApp
  message erasure stays a data-plane operation (`eraseByPhone`) and is
  unaffected.
- **Incident response**: on credential/token compromise rotate
  `BETTER_AUTH_SECRET` (invalidates all sessions), force password reset via the
  admin flow, and revoke active sessions (`revokeSessions`). Auth D1 and email
  provider outages degrade signup/recovery only — gateway webhook ingestion
  (`/webhooks/meta`) is independent of the identity plane.
