# Auth hardening — operations runbook (eccos-0x0.7)

Operational security for the identity plane now that Eccos owns the auth stack.
The tenancy contract (docs/auth-tenancy-contract.md §8) fixes the policy; this
doc records the concrete implementation and the operator responsibilities.

## Implemented controls

### Distributed rate limiting

Better Auth rate limiting stores counters in the **auth D1 database**
(`rateLimit.storage: "database"`) — shared across all Worker isolates, never
per-isolate memory. Configured windows (`packages/auth-baseline/src/rate-limit.ts`,
shared by the dashboard and the baseline; a test asserts every path is a real
endpoint, since Better Auth silently ignores a misspelled rule):

| Path | Window | Max |
|---|---|---|
| default (any auth endpoint) | 60 s | 100 |
| `/sign-in/email` | 300 s | 10 |
| `/sign-up/email` | 3600 s | 20 |
| `/request-password-reset` | 3600 s | 10 |
| `/send-verification-email` | 300 s | 5 |
| `/organization/invite-member` | 3600 s | 50 |

**What a bucket keys on.** Better Auth builds the key as `${callerIP}|${path}`
(`createRateLimitKey`, `@better-auth/core/utils/ip`) — the caller's address and
the route, never the request body. No rule above is a per-recipient guarantee:
they bound one caller. `/send-verification-email` matters most here because it
is unauthenticated and takes an arbitrary caller-supplied address, so every
call puts real mail in a third party's inbox off our sending domain; 5 per
300 s caps one caller at 60 mails/hour against a chosen address (`eccos-hk5`).
An attacker with many source addresses is still only bounded per address —
per-recipient send budgets, if we ever need them, belong to the mail layer.
The IP comes from `cf-connecting-ip` only (`advanced.ipAddress`, eccos-g5h),
which Cloudflare's edge sets on every request and overwrites if a client sends
it. `x-forwarded-for` is never read: Cloudflare appends to a caller-supplied
XFF, the resulting chain resolves to no IP, and every such caller would share
one bucket per path, so one spoofer could lock everyone out. Requests without
the header (local dev, tests) fall back to one `127.0.0.1` bucket under
`NODE_ENV=test|development`, else one `no-trusted-ip` bucket per path; that
fallback is never keyed on a caller-chosen value and is unreachable from the
internet behind Cloudflare.

Auth server-side calls made inside dashboard server functions do NOT pass
through the HTTP middleware — mutation rate limiting for those lives in the
gateway layer and the D1-level `429` behavior tested in
`tests/hardening.test.ts`.

### Two-factor authentication (TOTP)

- `twoFactor()` plugin enabled. Enrollment is the Two-factor authentication
  panel on `/settings` (`src/components/dashboard/two-factor.tsx`): password,
  then a QR code and key for an authenticator app, then the first code. Backup
  codes are shown once after that code verifies; they are stored encrypted.
- Sign-in for an enrolled account stops after the password and asks for the
  code (or a backup code) before any session exists
  (`src/components/auth/two-factor-code-form.tsx`).
- There is no console control to turn TOTP off or regenerate backup codes yet;
  a user who loses both the authenticator and the codes needs an operator.

### Step-up enforcement (contract §4/§8)

`stepUpRefusal` in `src/auth/step-up.ts` is the one rule: the user has TOTP
enrolled, and `session.stepUpAt` is within `STEP_UP_WINDOW_SECONDS` (15
minutes).

**What counts as fresh.** `stepUpAt` is stamped in exactly two ways, and never
from the session's age:

- by `stepUpGuard` (`src/auth/step-up-guard.ts`) when a second-factor
  verification MINTS the session: the code step of a sign-in, or the first code
  of an enrollment;
- by the step-up challenge (`confirmStepUp`, `src/auth/step-up-confirm.ts`),
  which checks an authenticator or backup code against the CURRENT session and
  stamps that same row. It mints nothing: the cookie, the active organization
  and the user's other sessions are untouched, and a trusted-device cookie is
  never consulted.

Better Auth mints sessions on endpoints that ask for the password alone
(`change-password` with `revokeOtherSessions`, `two-factor/disable`) and on the
email-verification link, so a stolen cookie plus the password could otherwise
renew itself; those sessions carry no stamp of their own and never pass.

**Wrong codes.** The challenge counts wrong codes per user in the auth D1's
`rateLimit` table (key `step-up|<userId>`): 5 inside 15 minutes lock it for
that user, on every session and from every address, until the window passes. A
right code clears the count. Better Auth's own `two-factor/verify-totp` and
`verify-backup-code` count nothing on an existing session, so over HTTP they
are refused (`USE_STEP_UP`) for an enrolled, signed-in caller; they stay open
to a sign-in's challenge and to a first enrollment.

**Where it is enforced.**

| Matrix row | Where |
|---|---|
| Embedded Signup start, token attach | `STEP_UP_ROWS.connect`: `startConnect`, `connectWithToken` |
| API key issue and revoke | `STEP_UP_ROWS["api-keys"]`: `issueApiKey`, `revokeApiKey` |
| Conversation retention write (it purges history) | `STEP_UP_ROWS["conversation-retention"]`: `setConversationRetention` |
| Subscriber config write, resubscribe | `STEP_UP_ROWS["subscriber-config"]`, `.resubscribe` |
| Invitations and member role changes | `STEP_UP_ROWS.members` (`inviteMember`) and, inside Better Auth, `STEP_UP_ORGANIZATION_PATHS`: `invite-member`, `cancel-invitation`, `update-member-role`, `remove-member` |
| Changing or revealing a factor | `STEP_UP_ACCOUNT_PATHS`: `change-password`, `change-email`, `two-factor/disable`, `two-factor/generate-backup-codes`, `two-factor/get-totp-uri`; `two-factor/enable` once the account is enrolled (first enrollment stays open) |

`STEP_UP_ROWS` is the single table for the Eccos server functions: a function
names its row, and `requireGatewayPermission` checks the row's role and then
the step-up. The role always comes first, in Better Auth's endpoints too, so a
role that lacks the action gets a permission error rather than a prompt to
enroll.

The Embedded Signup code exchange (`exchangeConnectCode`) has no step-up of
its own: Meta's code is single-use and lives 30 seconds, so a refusal there
would lose it. The account-bound state it must present was issued by
`startConnect`, the step-up row, moments earlier.

Export and erasure have no console path: they are reachable only with an
account API key, so there is nothing for a session step-up to gate. A console
action for either must add its row to `STEP_UP_ROWS`.

The organization endpoints resolve their target the way Better Auth does: the
body's `organizationId` or, when it is empty, the session's active one; for
`cancel-invitation`, the invitation's own. Step-up is skipped only when the
caller's role is KNOWN to lack the permission there. An organization,
invitation or membership that cannot be resolved does not skip it.

**What the operator sees.** A refusal is a typed `forbidden` failure with
reason `totp-required` or `reauth-required` (`StepUpReason`, defined once in
`@eccos/auth-baseline/step-up`). `withStepUp` (`src/lib/step-up.ts`) opens the
step-up sheet (`src/components/dashboard/step-up-sheet.tsx`) beside the page:
the code, or enrollment for an account with none. On success the action runs
again. Nothing navigates and no session changes, so the form the operator was
filling in is untouched, and closing the sheet only declines.

Connecting a number asks ahead of the click (`canStartConnect`, when the fork
appears): Meta's window only opens on the customer's own click, and a prompt
in between would spend it. The cards stay disabled until step-up is settled.

### Session freshness

- Session expiry: 7 days; session refresh (`updateAge`): daily.
- `freshAge: 900` (15 minutes) governs Better Auth's own fresh-session checks.
  Eccos step-up does not use it; see "What counts as fresh" above.
- `session.stepUpAt` is migration `0004_session_step_up.sql`. Apply it before
  deploying the code that reads and writes it.
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
