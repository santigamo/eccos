# Auth & tenancy contract — Better Auth Organizations

Implementation contract for replacing the Cloudflare Access installation identity
(`apps/dashboard/src/access.ts` + `dashboard_installations`) with **Better Auth** sessions and the
**Organization plugin** on a dedicated auth D1 database. This is the architecture gate for the
customer-auth beads: eccos-0x0.2 (D1 foundation), eccos-0x0.3 (organizations/RBAC/mapping),
eccos-0x0.5 (signup/provisioning/`/connect`), eccos-0x0.7 (hardening), eccos-0x0.9 (deploy
evidence), eccos-0x0.11 (email delivery).

Terminology follows [multi-tenancy.md](./multi-tenancy.md); trust boundaries and mitigations follow
[threat-model.md](./threat-model.md). Nothing here contradicts them: the account → WABA → phone
ownership model is unchanged; the Access-derived *installation identity* is deleted, not migrated
(§11). The docs that describe Access are updated by eccos-0x0.9.

## 1. Request-to-tenant flow

Every protected request — SSR page load, route loader, and server function — resolves the tenant
server-side, in this order:

1. **Canonical host check.** The custom server entry (`apps/dashboard/src/server.ts`) rejects any
   non-canonical host before routing (§6), replacing the Access gate.
2. **Session resolution.** The Better Auth handler is mounted at `/api/auth/*`; the session cookie
   is resolved server-side on every request.
3. **Active organization, resolved server-side.** The active organization comes from Better Auth
   membership resolved on the server, never from a client-sent value.
4. **Organization → account link.** The resolved `organization_id` is mapped to the Eccos
   `accountId` via `organization_accounts` in the gateway control plane (§2).
5. **WABA ownership validation.** The requested WABA id is validated against the resolved account
   (same fail-closed rule as today's `resolveScope`); unknown WABAs are rejected.
6. **GatewayRPC call.** The RPC method is invoked with the resolved `accountId` (§Reconciliation).

> **`activeOrganizationId`, organization slugs, organization metadata, and browser-supplied
> `accountId` / WABA ids are UX input, NEVER authorization evidence.** Every server function
> re-derives the tenant from session → membership → `organization_accounts` → account and
> validates WABA ids against that account. Changing any of these client-side values cannot cross
> the tenant boundary.

## 2. Identity plane / data plane split

Two planes, two stores, one authority per concern:

| Plane | Store | Owns |
|---|---|---|
| Identity plane | Better Auth on the dedicated auth D1 (§3) | users, sessions, credential accounts, organizations, members, invitations, verifications |
| Data plane (authority) | `EccosControlPlane` Durable Object | accounts, WABAs, phones, hashed API keys, connect states, **`organization_accounts`** |

The identity plane answers *who is signed in and what role they hold in which organization*. The
data plane answers *which Eccos account exists, which WABAs/phones it owns, which API keys work*.
Neither is trusted to answer the other's question: Better Auth membership alone never grants
gateway access, and an Eccos account alone never grants dashboard access.

### `organization_accounts` mapping (new, server-owned)

Added to the `EccosControlPlane` DO:

- **One-to-one** `organization_id` ↔ `account_id`, with a **UNIQUE index on both columns**.
- **Status**: `active | pending | disabled`. Only `active` resolves tenant requests; `pending` and
  `disabled` fail closed (§10).
- **Immutable**: no rebinding. A link row is never re-pointed at a different account or a
  different organization; a re-link attempt fails closed.
- **Created by the idempotent `ensureOrganizationAccount(organizationId, name?)` saga**: concurrent
  or retried calls produce exactly one Eccos account and one link row, **without issuing an API
  key** (§11). Partial failure surfaces as `pending` with a retryable reconciler, per eccos-0x0.3.
- Better Auth organization metadata is **not** the mapping store. Nothing may read org metadata,
  slugs, or IDs as the authority for an account link; they may only be re-validated inputs.

Trust boundary stays as in [threat-model.md](./threat-model.md): the dashboard reaches the gateway
only via the private `GatewayRPC` service binding; the gateway's operator API is never public HTTP;
account API keys remain the only machine credentials.

## 3. Better Auth schema & D1 ownership

- **One dedicated auth D1 database per environment**: local (wrangler/miniflare), staging,
  production. Never shared with another product and never shared with gateway storage — the
  control-plane DO SQLite and per-WABA message data stay entirely separate stores.
- **EU jurisdiction** for the staging and production databases (D1 location hint), matching the
  control-plane residency stance in multi-tenancy.md. Local uses the default local jurisdiction.
- **No read replicas in v1** (single primary; session reads are per-request and consistent).
- **Generated migrations are committed** to the repository (core + organization plugin tables).
- **Schema is applied explicitly by deploy** (`wrangler d1 migrations apply` in the deploy step).
  The Worker must never run DDL or migrations at startup; a missing/mismatched schema fails
  closed rather than self-healing at request time.
- **Pin the exact `better-auth` version** (no range specifiers) and track advisories (eccos-0x0.2 /
  eccos-0x0.7). The concrete pin is an open decision (§12).

Privacy implication: identity data (emails, names, invitation/reset tokens) lives only in the auth
D1 and the email adapter path; it never enters the gateway DOs, forwarded payloads, or logs.
Erasure of WhatsApp data remains a data-plane operation (`eraseByPhone`); erasure of identity data
follows the privacy/DPA package (eccos-8yy).

## 4. Role / capability matrix

Four organization roles, mapped onto Better Auth's Organization plugin (owner/admin are the
defaults; `operator` and `viewer` are configured custom roles):

| Dashboard operation | Minimum role | MFA / step-up (§8) | Notes |
|---|---|---|---|
| View status, logs (inbound/outbound/deliveries), templates | viewer | — | Read-only |
| Retry delivery | operator | — | |
| Subscriber config read | operator | — | Secret value never returned |
| Subscriber config write | admin | **Yes** | TOTP (owner/admin) + ≤15 min recent auth |
| Resubscribe webhook (Meta handshake) | admin | **Yes** | |
| API key management (issue/revoke) | admin | **Yes** | Keys are machine credentials only |
| Embedded Signup `/connect` start + callback | admin | **Yes** | Account-bound OAuth state |
| Export data | admin | **Yes** | |
| GDPR erasure (`eraseByPhone`) | owner | **Yes** | Owner-only destructive action |
| Invitations & member role changes | owner/admin (Better Auth defaults) | **Yes** | Verified email required (§7) |
| Organization create | any verified user | — | Own new org only; allowlisted signup (§7) |
| Organization delete | disabled in v1 | — | Rejected everywhere (§9) |

"**Yes**" means: the acting user must have TOTP MFA enrolled (owner/admin roles) **and** a
recent authentication within the step-up window (15 minutes); otherwise the server demands
re-authentication before executing the action. Reads never require step-up.

## 5. Session & active-organization rules

- Session cookie: **HttpOnly, Secure, SameSite=Lax** (Better Auth cookie configuration; no
  JS-readable tokens).
- **Server-side session resolution on every server function and every SSR loader.** No client
  component, request header, or query parameter may assert identity or role.
- **No session-derived authorization caching across requests.** Role, membership, and the
  organization→account mapping are re-resolved per request; module-scope or isolate-reuse caches
  must not carry authorization state.
- **Organization switch**: the client sets the active organization through the wrapped
  `set-active` endpoint; the server re-validates membership in that organization before accepting.
  The stored active org is then only a UX default — step 3 of §1 re-derives it server-side anyway.
- **Revocation latency**: a revoked membership, removed invitation, disabled mapping, expired
  session, or deleted user takes effect on the **next protected request**. No long-lived role
  claims (JWTs or otherwise) are ever trusted across requests.

## 6. Canonical host / origin policy

- `https://app.eccos.chat` is the **only** customer origin.
- `workers_dev: true` in `apps/dashboard/wrangler.jsonc` is **disabled**; preview URLs are
  disabled for the customer surface. Raw `*.workers.dev` and preview origins **fail closed** —
  they are not alternate customer paths.
- The custom server entry replaces `enforceAccess` with a **host allowlist enforced before
  routing**: requests whose host is not the canonical origin (or `localhost` in development)
  get `403`. This preserves the old gate's key property — the raw Workers origin cannot bypass
  the app boundary — without Access.
- Better Auth `trustedOrigins` is an allowlist of exactly the canonical origin (plus localhost for
  development). **No credentials are accepted over cross-origin** requests; unexpected hosts are
  rejected by both the host gate and the auth layer.
- The staging hostname is an open decision (§12). Until decided, any non-canonical host fails
  closed, so staging cannot silently run on a workers.dev URL.

## 7. Signup / invitation policy

- **Invite-only / allowlist signup** for the initial release: only allowlisted emails may create
  an account (eccos-0x0.5 owns the mechanism).
- **Email verification is required before organization creation or any membership use.**
- Invitations are **sent only to verified email addresses**, and invitation delivery flows through
  the application email adapter (§8).
- **Invitation acceptance requires the signed-in matching identity**: the accepting user must be
  signed in with the exact invited (and verified) address; invitation tokens are never
  capability URLs for anonymous use.
- **A member invitation never provisions a new tenant.** Accepting joins the existing organization
  and its already-linked account; it must never create an organization, an Eccos account, or an
  `organization_accounts` row.

## 8. Email / MFA / recovery assumptions

- **Application-owned email adapter interface**: a small server-side adapter (send verification,
  reset, invitation, and security-notification email) with the provider chosen and configured in
  eccos-0x0.11. Provider secrets live only in Worker secrets/bindings; the interface ships in
  eccos-0x0.2 so auth flows are testable with a stub sender.
- **MFA policy**: TOTP is **required for owner/admin roles before sensitive actions** — connect,
  API keys, export, erasure, membership/role changes, and subscriber config write (§4). eccos-0x0.7
  implements enrollment and enforcement; this contract fixes the policy.
- **Recent-authentication step-up window: 15 minutes.** A sensitive action requires an
  authentication (fresh sign-in or step-up challenge) within the last 15 minutes; older sessions
  must re-authenticate first.
- **Recovery** uses the email reset flow with **anti-enumeration generic responses** — identical
  responses and timing whether or not the address exists; reset links only work for verified,
  existing identities.

## 9. Direct Better Auth plugin endpoint inventory

Better Auth's Organization plugin exposes HTTP endpoints under `/api/auth/organization/*`. They
exist and cannot all be removed, so each carries an explicit policy. The dashboard's own server
functions remain the primary UI path; direct plugin calls are subject to the same rules.

**Three of them are not served at all.** `src/server.ts` refuses `organization/create`,
`organization/check-slug` and `organization/update` with better-call's own 404 before the request
reaches `auth.handler`, so a blocked endpoint is indistinguishable from one that was never
registered. The reasoning lives in `src/auth/blocked-endpoints.ts`; the short version is that all
three answer questions about `organization.slug`, which the schema declares globally unique across
every tenant, and Better Auth checks that uniqueness *before* any `organizationHooks` interception
point — so no hook can sanitize the answer. `check-slug` in particular is a purpose-built oracle
that needs a session and no membership, and 1.7.2 has no option to disable it. The slug itself is
now a server-minted random UUID (`createOrganization` in `src/organizations.ts`), never derived
from customer input and never returned to the browser, so **workspace names may repeat freely** —
across tenants and inside one user's own membership list.

| Plugin endpoint (POST unless noted) | Purpose | Policy |
|---|---|---|
| `create` | Create organization | **Not served** — 404 before dispatch. Creation is the `createOrganization` server function only: it mints the slug, and on success triggers the idempotent `ensureOrganizationAccount` saga; never issues an API key. A direct HTTP call skipped that saga entirely and stranded the organization with no account link |
| `check-slug` | Probe slug availability | **Not served** — 404 before dispatch. A cross-tenant existence oracle with no legitimate caller: nothing in the console is slug-addressed |
| `list`, `get`, `get-full` (GET) | List/read organizations | Session required; only memberships of the caller |
| `set-active` | Set active organization | Wrapped by app validation: server re-verifies membership; result is UX state only (§5) |
| `update` | Update organization (name, metadata) | **Not served** — 404 before dispatch, because the same slug-uniqueness probe is reachable through a rename. There is no rename UI in v1; when one is built it must be a server function that never accepts a slug. Metadata/slug changes **never authorize the account mapping** (§2) |
| `delete` | Delete organization | **Disabled in v1** — rejected regardless of role |
| `create-invitation` (POST), `list-invitations` (GET) | Invitations | Owner/admin + verified email + step-up (§4); recipients must be verified identities (§7) |
| `accept-invitation`, `reject-invitation`, `cancel-invitation`, `get-invitation` (GET) | Invitation lifecycle | Acceptance requires signed-in matching identity (§7); never provisions a tenant |
| `add-member` (remove-member), `update-member-role` | Member add/remove, role update | Owner/admin per Better Auth defaults + verified email + step-up (§4) |
| `transfer-ownership` | Ownership transfer | Owner→owner + step-up |

Invariants for all of them: no endpoint issues or returns an API key; no endpoint creates or
modifies `organization_accounts`; no endpoint bypasses the role matrix; a direct call that the app
wrapper would refuse (e.g. unverified email, disabled org, deleted member) is refused here too.
No endpoint's error text may vary with the state of another tenant — the console maps organization
creation failures through a closed allowlist of generic copy and logs the provider's own message
server-side instead (§7/§8 anti-enumeration, applied to the organization plane).

## 10. Failure behavior

| Condition | Behavior |
|---|---|
| Missing / invalid session | Pages redirect to sign-in; server functions return `401` |
| Signed in, no organization membership | Organization onboarding screen (create/join an org) |
| Mapping `pending` or `disabled`, or no `organization_accounts` row | **Fail closed** (`403`); no fallback resolution path |
| Requested WABA not owned by the resolved account | Fail closed (existing `resolveScope` rule) |
| Gateway unreachable / RPC error | Existing graceful degraded states (`{ ok: false, error }`) preserved — **strictly after** auth and tenant resolution succeed |
| Auth D1 unavailable | Protected pages and mutations fail closed; no read-only bypass |
| Email provider unavailable / delivery failing | Auth mutations that require email (signup verify, reset, invitations) fail closed or surface bounded retries; **gateway webhook ingestion (`/webhooks/meta`) remains fully independent** of the identity plane |

## 11. Clean-reset invariants

The cutover is a **fresh-state reset**, not a migration. There are no real users or data to carry
over; the development deployment is intentionally broken and re-created.

**Reset sequence:**

1. Create a **fresh auth D1** per environment and apply the committed migrations once, at deploy.
2. **Reset the development control-plane bootstrap**: empty `accounts`/`organization_accounts`
   starting state; no `dashboard_installations` rows; the first organization/account pair is
   created deterministically by the new flow (`ensureOrganizationAccount`).
3. Re-run the deploy and smoke evidence (eccos-0x0.9).

**Artifacts to DELETE:**

- `apps/dashboard/src/access.ts` (the Access JWT gate)
- `apps/dashboard/tests/access.test.ts`
- `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` vars from `apps/dashboard/wrangler.jsonc`
- the `jose` dependency
- the `dashboard_installations` table in the control plane
- `getDashboardAccount` and `initializeDashboard` (GatewayApi methods + DO implementations) and
  the installation-key identity (`dashboardInstallationKey`) everywhere
- automatic API-key issuance on dashboard init (side effect inside `initializeDashboard`)
- the setup-screen installation flow (`initializeDashboard` server function and the `/setup` route)

**Explicitly PROHIBITED** — none of these may be implemented, even behind a flag:

- legacy mode or a legacy auth code path
- shadow mode / dual auth (Access **or** Better Auth, both **or** either)
- data migration or schema compatibility readers for the discarded model
- relinking or reusing Access installation/bootstrap records
- any runtime fallback that authorizes a request without a resolved session + membership +
  `organization_accounts` link

**API keys remain the only machine credentials.** Signup, organization creation, and mapping
provisioning must never issue one; keys are created only through explicit admin key management.

## 12. Unresolved decisions

Intentionally deferred; this contract does not block on them.

| Decision | Owner |
|---|---|
| Exact email provider + adapter configuration (SPF/DKIM, templates, retries) | eccos-0x0.11 |
| Exact `better-auth` version pin (audited release) | eccos-0x0.2 |
| Staging hostname / canonical-origin configuration for staging | eccos-0x0.9 |
| D1 backup policy (backup cadence, retention, deletion responsibilities) | eccos-0x0.7 |
| Organization deletion / offboarding saga details (v1 keeps deletion disabled) | eccos-0x0.3 |

## Reconciliation with the existing control plane

The existing account → WABA → phone ownership model and every `GatewayRPC` ownership check remain
the data-plane authority. Only the *source of `accountId`* changes: from the Access installation
key to the server-resolved organization link. Per-method mapping of `GatewayApi`
(`packages/gateway-contract/src/index.ts`):

| GatewayApi method | New identity input |
|---|---|
| `getStatus`, `getConfig`, `listInbound`, `listOutbound`, `listDeliveries`, `getDelivery`, `retryDelivery`, `listTemplates`, `getSubscriberConfig`, `setSubscriberConfig`, `resubscribe`, `eraseByPhone`, `exportData`, `listAccountResources` | Unchanged signatures. `accountId` is resolved server-side from the organization link (§1); the requested WABA is validated against it. Browser-supplied ids are never passed through |
| `startConnect(installationKey)` | **Becomes `startConnect(accountId)`** — the installation key is replaced by the resolved account id. `startConnectState` / `consumeConnectStateForAccount` are already account-bound and stay unchanged |
| `getDashboardAccount(installationKey)` | **Removed** — no installation identity exists |
| `initializeDashboard(installationKey, name)` | **Removed** — replaced by the idempotent `ensureOrganizationAccount(orgId, name)` saga on the DO, which creates no API key |

Control-plane tables: `dashboard_installations` is dropped; `organization_accounts` is added;
`accounts`, `api_keys`, `wabas`, `phones`, and `connect_states` are unchanged. The existing
provisioning saga (`beginWabaProvisioning`, claims, retries) and Embedded Signup state binding
continue to work per account, now reached from an organization-scoped dashboard.
