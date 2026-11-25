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
(§11).

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

**An agent's request enters through a bearer token instead of a session.** `apps/mcp` passes the
token from each MCP request to `ConsoleRPC.authorize` over a private service binding, and the
console then does, in order:

1. **Token verification, in process.** Signature against the auth instance's own keys, `iss`
   equal to the console origin, `aud` equal to the MCP resource, `exp`, `typ: at+jwt`, and a
   present `azp`. No network call and no key cache.
2. **Grant check.** The consent row for (user, client, workspace) still exists. Revoking the grant
   deletes it (§5).
3. **Steps 3 to 6 above**, with the workspace the grant is bound to in place of the active
   organization: the user's current membership and role in it, its `organization_accounts` link,
   and WABA ownership in the gateway.

Every refusal answers the agent with the same `401` challenge; the reason stays inside Eccos. The
token names a user, a client, and a workspace. It is a pointer to a grant, never evidence of a role.

> **`activeOrganizationId`, organization slugs, organization metadata, and browser-supplied
> `accountId` / WABA ids are UX input, NEVER authorization evidence.** Every server function
> re-derives the tenant from session → membership → `organization_accounts` → account and
> validates WABA ids against that account. Changing any of these client-side values cannot cross
> the tenant boundary.

## 2. Identity plane / data plane split

Two planes, two stores, one authority per concern:

| Plane | Store | Owns |
|---|---|---|
| Identity plane | Better Auth on the dedicated auth D1 (§3) | users, sessions, credential accounts, organizations, members, invitations, verifications, OAuth clients, consents (grants), access and refresh tokens, JWT signing keys, elevations |
| Data plane (authority) | `EccosControlPlane` Durable Object | accounts, WABAs, phones, hashed API keys, connect states, hashed connection links, **`organization_accounts`** |

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
account API keys remain the only *account* credentials. An OAuth grant (§4) is a delegated *user*
credential: it acts as one user in one workspace, bounded by that user's live role. `apps/mcp`
is the gateway's second private caller and, like the console, passes only an `accountId` it was
given by `ConsoleRPC.authorize`, never a bearer value.

## 3. Better Auth schema & D1 ownership

- **One dedicated auth D1 database per environment**: local (wrangler/miniflare), staging,
  production. Never shared with another product and never shared with gateway storage — the
  control-plane DO SQLite and per-WABA message data stay entirely separate stores.
- **EU jurisdiction** for the staging and production databases (D1 location hint), matching the
  control-plane residency stance in multi-tenancy.md. Local uses the default local jurisdiction.
- **No read replicas in v1** (single primary; session reads are per-request and consistent).
- **Generated migrations are committed** to the repository (core, organization, two-factor, OAuth provider, and JWKS tables).
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
| View status, logs (messages/events/forwarding queue), broadcasts, scheduled sends, templates | viewer | — | Read-only |
| Retry delivery | operator | — | |
| Cancel broadcast or scheduled send | operator | — | Stops sends not yet attempted; ids-only audit line |
| Subscriber config read | operator | — | Secret value never returned |
| Subscriber config write | admin | **Yes** | TOTP (owner/admin) + ≤15 min recent auth |
| Resubscribe webhook (Meta handshake) | admin | **Yes** | |
| API key management (issue/revoke) | admin | **Yes** | Keys are machine credentials only |
| Embedded Signup `/connect` start, token attach | admin | — | Issues the account-bound OAuth state. No step-up: Meta's window opens on the click, before the start answers, so a refusal would only show after the customer went through Meta |
| Embedded Signup callback / code exchange | admin | — (by design) | Must present the state the start issued. Meta's code is single-use and lives 30 seconds, so a step-up refusal here would lose it and force the whole flow again |
| Connection link: make or replace | admin | **Yes** | One per workspace; see below. Reading its status needs no step-up |
| Conversation retention write | admin | **Yes** | Shortening it purges history |
| Export data | admin | **Yes** | |
| GDPR erasure (`eraseByPhone`) | owner | **Yes** | Owner-only destructive action |
| Invitations & member role changes | owner/admin (Better Auth defaults) | **Yes** | Verified email required (§7) |
| Organization create | any verified user | — | Own new org only; allowlisted signup (§7) |
| Workspace rename | admin | — | `renameWorkspace` server function (§9): name only, never a slug; refused when the session moved to another workspace; the gateway account's name follows; ids-only audit line |
| Organization delete | disabled in v1 | — | Rejected everywhere (§9) |

"**Yes**" means: the acting user must have TOTP MFA enrolled (owner/admin roles) **and** have
proved that second factor within the step-up window (15 minutes); otherwise the server demands
re-authentication before executing the action. A password alone never renews it, and neither does
a session's age. Reads never require step-up.

**The connection link is the one unauthenticated actor.** An admin makes a link for their
workspace; whoever holds it may run Embedded Signup into that workspace from the public `/connect`
page, with no Eccos session. The token is bound in the control plane to (account, creating user),
lives 7 days, is spent by the first registration and revoked by the next link. The account always
comes from the token's row, never from the request; the bearer can add their own WABA and can read
nothing. A link stops resolving once its creator is no longer an owner or admin of the workspace,
and its use is audited as `connect_link` under the creator's user id.

**Agents act through an OAuth grant.** A person connects an agent to one workspace through the
console's OAuth authorization server (§9). The agent acts as that person, so the matrix above still
decides what it may do, read on every request from the person's current role. The grant's scopes
narrow it further: an agent may do what both its user's role and its scopes allow. A viewer whose
grant carries `eccos:administer` can only view.

| Scope | Allows | Console permission behind it | Least role |
|---|---|---|---|
| `eccos:view` | Status, numbers, templates, logs | `view` | viewer |
| `eccos:operate` | Retry deliveries, cancel broadcasts and scheduled sends, read the subscriber config | `operate` | operator |
| `eccos:send` | Send messages: test templates, text, broadcasts, scheduled sends | `operate` | operator |
| `eccos:configure` | Templates, subscriber config write, resubscribe, re-check a number, phone settings | `configure` | admin |
| `eccos:administer` | Connection link, API keys, billing state and checkout, export | `administer` | admin |
| `offline_access` | A refresh token | — | any |

No scope allows `erase`. No agent path deletes an organization, transfers ownership, or changes a
role. Sending has its own scope although the console gates it on `operate`, because it spends the
customer's money with Meta and reaches real people.

For an agent, "**Yes**" in the step-up column means a live **elevation** on the grant. The grant's
own user, currently an owner or admin, passed the console's step-up (TOTP, §8) at consent or on an
approval page, and the elevation lasts 24 hours. It is a row in the auth D1, never a claim in the
token. It ends at its expiry, when the grant is revoked, or when the person ends it under
Connected agents. A demotion needs no handling: the live role check refuses first.

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
- **OAuth access tokens carry no authority of their own.** An access token is a JWT that names a
  user, a client, and a workspace, and lives 10 minutes. Each request re-reads the grant, the
  membership, the role, and the account link (§1). Revoking a grant under Connected agents deletes
  its consent row **and** revokes its refresh tokens: deleting the consent row alone does not stop
  a refresh.
- **Revocation latency**: a revoked membership, removed invitation, disabled mapping, expired
  session, deleted user, or revoked OAuth grant takes effect on the **next protected request**. No long-lived role
  claims (JWTs or otherwise) are ever trusted across requests.

## 6. Canonical host / origin policy

- The origin in `BETTER_AUTH_URL` (`https://app.eccos.chat` on Eccos Cloud) is the **only**
  customer origin. Unset or non-HTTPS means local development: only localhost is served.
- `workers_dev` in `apps/dashboard/wrangler.jsonc` is **disabled** (`false`); preview URLs are
  disabled for the customer surface. Raw `*.workers.dev` and preview origins **fail closed** —
  they are not alternate customer paths.
- The custom server entry replaces `enforceAccess` with a **host allowlist enforced before
  routing** (`isAllowedHost` in `src/auth/config.ts`): requests whose host is not the
  `BETTER_AUTH_URL` host (or `localhost` in development)
  get `403`. This preserves the old gate's key property — the raw Workers origin cannot bypass
  the app boundary — without Access.
- Better Auth `trustedOrigins` is an allowlist of exactly the `BETTER_AUTH_URL` origin (plus
  localhost for development). **No credentials are accepted over cross-origin** requests; unexpected hosts are
  rejected by both the host gate and the auth layer.
- **One exception, for software rather than browsers.** The OAuth token, dynamic registration,
  JWKS, and authorization-server metadata endpoints (§9) answer cross-origin requests that carry no
  cookie, because MCP clients call them from other origins. They never read the session cookie, and
  they authenticate by what the request carries (the PKCE verifier, the refresh token, the client
  id). The authorize, sign-in, workspace, and consent pages stay same-origin and cookie-bound. The
  MCP endpoint lives on its own host (`apps/mcp`), where the browser never sends a console cookie.
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
- **MFA policy**: TOTP is **required for owner/admin roles before sensitive actions** — connection
  links, API keys, export, erasure, membership/role changes, and subscriber config write (§4). Enrollment
  and enforcement are implemented (`eccos-eyel`; docs/auth-hardening.md, "Step-up enforcement");
  this contract fixes the policy. **Setting up TOTP requires a code mailed to the account's
  verified address**, so the password alone never yields a second factor, and every change to
  the second factor is notified by email.
- **Recent-authentication step-up window: 15 minutes.** A sensitive action requires the second
  factor to have been proved within the last 15 minutes, by a sign-in that included it or by the
  step-up challenge on the current session; otherwise the code is asked for again first.
- **Recovery** uses the email reset flow with **anti-enumeration generic responses** — identical
  responses and timing whether or not the address exists; reset links only work for verified,
  existing identities.

## 9. Direct Better Auth plugin endpoint inventory

Better Auth's Organization plugin exposes HTTP endpoints under `/api/auth/organization/*`. They
exist and cannot all be removed, so each carries an explicit policy. The dashboard's own server
functions remain the primary UI path; direct plugin calls are subject to the same rules.

**Seven of them are not served at all**: the three slug-bearing endpoints below, and the four
membership writes, whose rules and audit live in the console's server functions. `src/server.ts` refuses `organization/create`,
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
| `update` | Update organization (name, metadata) | **Not served** — 404 before dispatch, because the same slug-uniqueness probe is reachable through a rename. Renaming goes through the `renameWorkspace` server function instead (Settings, owner/admin, §4), which calls Better Auth in process with the name only and never accepts or returns a slug. Metadata/slug changes **never authorize the account mapping** (§2) |
| `delete` | Delete organization | **Disabled in v1** — rejected regardless of role |
| `invite-member`, `cancel-invitation`, `remove-member`, `update-member-role` | Invite, cancel an invitation, remove a member, change a role | **Not served** — 404 before dispatch. Served only through the console's server functions (`src/members.ts`), which call them in process: owner/admin, only `admin`/`operator`/`viewer` may be granted, an owner is changed or removed only by an owner and never the last one, removing a member cancels the invitations they sent that are still pending, ids-only audit line, at most 20 invitations per inviter per hour (enforced in the plugin's `beforeCreateInvitation` hook). Every one needs step-up (§4), checked by those functions and again by the plugin's organization hooks |
| `list-invitations` (GET) | Invitations | Owner/admin; recipients must be verified identities (§7) |
| `accept-invitation`, `reject-invitation`, `get-invitation` (GET) | Invitation lifecycle | Acceptance requires signed-in matching identity (§7); never provisions a tenant |
| `add-member` | Member add | Server-only in Better Auth; not reachable over HTTP |
| `transfer-ownership` | Ownership transfer | Owner→owner + step-up |

Invariants for all of them: no endpoint issues or returns an API key; no endpoint creates or
modifies `organization_accounts`; no endpoint bypasses the role matrix; a direct call that the app
wrapper would refuse (e.g. unverified email, disabled org, deleted member) is refused here too.
No endpoint's error text may vary with the state of another tenant — the console maps organization
creation failures through a closed allowlist of generic copy and logs the provider's own message
server-side instead (§7/§8 anti-enumeration, applied to the organization plane).

### OAuth authorization server endpoints

The console's Better Auth instance is the OAuth 2.1 authorization server for the MCP resource
(`apps/mcp`), through the `jwt`, `mcp` (`@better-auth/mcp`), and `cimd` plugins. The issuer
is the bare `BETTER_AUTH_URL` origin. Paths below are under `/api/auth` unless they start with
`/.well-known`. A path marked **Not served** gets the same 404 before dispatch as the organization
endpoints above, so it is indistinguishable from one that was never registered.

| Endpoint | Purpose | Policy |
|---|---|---|
| `GET /.well-known/oauth-authorization-server` (root) | RFC 8414 metadata: endpoints, `S256`, `client_id_metadata_document_supported`, `none` among the token endpoint auth methods | Public, no session, cross-origin without cookies (§6). `src/server.ts` serves it before the page gate. It is the only metadata document |
| `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`, `/.well-known/oauth-protected-resource*` under `/api/auth`, and `/.well-known/openid-configuration` at the root | Copies the plugins mount, OIDC discovery, and resource metadata | **Not served.** The resource metadata belongs to `apps/mcp`, and no OpenID scope is offered |
| `GET /oauth2/authorize` | Start an authorization: PKCE `S256`, `resource` equal to the MCP resource | Browser navigation, rate-limited per address (10 per 60 s). Without a session it goes to sign-in or sign-up, which carry the signed authorization query forward and follow the URL Better Auth returns; sign-up's verification link returns to the pending authorization |
| `POST /oauth2/continue` | Resume the authorization after the workspace step | Same-origin, session. The workspace must be one the user belongs to now, checked on the server: otherwise the answer is the workspace step again; it becomes the consent's reference id |
| `POST /oauth2/consent` | Accept or deny on the consent page | Same-origin, session. A person holds at most 50 live grants per workspace, codes not yet exchanged included, also under concurrent consents: one more consent gets 400 `access_denied` and no code telling them to revoke an agent under Settings → Connected agents. A client deleted since the workspace step gets 400 `invalid_client`. Consent is never skipped, for any client: every authorization request gets `prompt=consent` before its query is signed, so the consent page comes even when an earlier consent covers the same client, workspace and scopes. `prompt=none` gets `consent_required` at the redirect URI. Consent for a workspace the user has left is refused and stores nothing |
| `GET /oauth2/public-client`, `GET /oauth2/public-client-prelogin` | The client's name and redirect for the sign-in and consent pages | Same-origin. Public client metadata only |
| `POST /oauth2/token` | Authorization code exchange and refresh | Public, cross-origin without cookies, body capped at 8 KiB (400 `invalid_request`). PKCE required; refresh tokens rotate, and a replay after the reuse window revokes the family. Access tokens are issued only for the MCP resource, last 10 minutes, and carry the workspace. Refused with RFC 6749's 400 `invalid_grant`, and no reason, when the user is no longer a member of it |
| `POST /oauth2/register` | Dynamic client registration (RFC 7591), the fallback to client ID metadata documents | Public, unauthenticated, cross-origin without cookies, rate-limited per address (5 per 60 s). The body is capped at 8 KiB before parsing, and the stored metadata fields have their own limits (`src/server/oauth-request-limits.ts`); a refusal is RFC 7591's 400 `invalid_client_metadata` or `invalid_redirect_uri`. An hourly cron deletes unused clients; the bound is under "Growth bound" below |
| `POST /oauth2/revoke` | Token revocation by the client (RFC 7009) | Served. The client sends its id and the token; no session. Body capped at 8 KiB (400 `invalid_request`) |
| `GET /jwks` | The public half of the signing keys | Public, cross-origin without cookies |
| `/token` (the `jwt` plugin's session JWT) | — | **Not registered** (`disabledPaths`), so a session JWT cannot pass as an access token |
| `oauth2/introspect`, `oauth2/userinfo`, `oauth2/end-session`, `oauth2/end-session/confirm` | Introspection and OpenID Connect | **Not served.** No caller: `ConsoleRPC.authorize` verifies tokens in process, and no OpenID scope is offered |
| `oauth2/get-consents`, `oauth2/get-consent`, `oauth2/update-consent`, `oauth2/delete-consent` | Consent management | **Not served.** Connected agents in Settings lists and revokes grants through server functions, because a revoke must also revoke the refresh tokens and write an audit line |
| `oauth2/create-client`, `oauth2/get-client`, `oauth2/get-clients`, `oauth2/update-client`, `oauth2/delete-client`, `oauth2/client/rotate-secret`, `oauth2/client/rotate-keys`, `admin/oauth2/*` | Client administration | **Not served.** No caller in Eccos |

Client ID metadata documents are fetched with HTTPS only, the `global_fetch_strictly_public`
compatibility flag on the console Worker, `GET` only, no redirects, and a 5 s time cap. A
document gets the same limits as a registration: 8 KiB (Better Auth itself refuses one over
5 KB) and the same per-field limits (`src/auth/client-metadata-limits.ts`); one outside them fails
the authorization with `invalid_client`. Only `oauth2/authorize` brings in a document client it has
not seen: `oauth2/token` and `oauth2/revoke` refuse an unknown URL client id without fetching it.
The resolved client is kept as an `oauthClient` row marked with its discovery (`clientDiscoveryId`)
and rewritten each time the document is fetched again, which token and revocation calls also do.
The hourly cleanup deletes it under the same rules as a registered client, counting 24 hours from
its creation, so those refetches never keep it; its next authorization fetches the document again.

**Live grants and cleanup** (`src/auth/oauth-grants.ts` holds the one definition). A grant is one
`oauthConsent` row: a person's consent for one client in one workspace. It is live only while it
has an unrevoked refresh token that has not expired (30 days, renewed on each refresh), a stored
access token that has not expired, or an authorization code not yet exchanged that has not expired
(the configured code lifetime, 10 minutes; the exchange consumes it). Revoking a grant revokes its refresh tokens, so it is dead at
once. The cron, every hour on the hour, first deletes each consent whose grant has been dead for
24 hours, counted from the later of the consent and its last token's revocation or expiry (a
consent whose code was never exchanged counts from the consent). It then deletes each registered
or document client created more than 24 hours ago that has no owner, no consent and no live token.

**Growth bound.** Every input below is measurable on the running console.

- *Per address, anonymous.* A client row survives a cron run only if it was created, or
  consented to, in the last 25 hours (24 hours plus the hour between runs), or it holds a live
  grant. Writes come from `oauth2/register` (5 per 60 s) and `oauth2/authorize` (10 per 60 s), which
  is also the only way to reach a consent (a signed consent query expires after 10 minutes) or
  bring in a document client. So one address keeps at most (5 + 10) × 60 × 25 = 22,500 client
  rows at once, each at most 8 KiB of metadata: about
  185 MB (7,500 registered at about 60 MB, 15,000 document clients at about 120 MB, or about 75 MB
  under Better Auth's 5 KB document limit).
- *Per person, beyond that.* Only a live grant keeps a client longer, and a person holds at most
  50 per workspace, codes not yet exchanged included. The consent counts the person's other live
  grants after its own code is written, and a consent that finds 50 deletes its code and is
  refused instead of redirecting. The database runs one statement at a time, so of two consents at
  49 the one that counts second sees the other's code: neither can make 51 (both may be refused),
  so 50 × 8 KiB, about 400 KB of client rows per person per workspace, for as long
  as they keep refreshing. Per workspace, that is 50 × its members. Each refresh also leaves its
  rotated (revoked) refresh-token row, a few hundred bytes, until the client goes. The number of
  workspaces a person can create is not limited here.

Invariants: no OAuth endpoint issues or returns an API key, or creates or modifies
`organization_accounts`. A token's workspace is chosen by the signed-in user at consent from their
own memberships, never by the client. A grant never acts beyond its user's live role (§4).

## 10. Failure behavior

| Condition | Behavior |
|---|---|
| Missing / invalid session | Pages redirect to sign-in; server functions return `401`. `/connect` and `/api/connect-link/*` are public: the link token is their credential. `/claim` and `POST /api/claim` are public too: the claim token is their credential, and a `GET` never reveals or spends a claim |
| Bearer token refused by `ConsoleRPC.authorize` (invalid or expired token, revoked grant, not a member, no `active` account link) | `apps/mcp` answers the same `401` challenge for every reason; no tool runs |
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
- any runtime fallback that authorizes a request without a resolved session (or a live OAuth
  grant, §1) + membership +
  `organization_accounts` link

**API keys remain the only account credentials.** An OAuth grant is a delegated user credential
(§4), not an API key. Signup, organization creation, mapping provisioning, consent, and token
issuance must never issue one; keys are created only through explicit admin key management.

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
