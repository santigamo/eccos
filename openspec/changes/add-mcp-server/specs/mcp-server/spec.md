# Capability: mcp-server

Requirements for the remote MCP server and its authorization. Each requirement carries its
acceptance criteria as scenarios. Design rationale is in [../../design.md](../../design.md).

## ADDED Requirements

### Requirement: Stateless MCP endpoint

`apps/mcp` SHALL serve MCP over Streamable HTTP at a single endpoint, `/mcp`, on its own
hostname, implementing specification revision 2026-07-28 and accepting 2025-era clients without
sessions. It SHALL hold no storage binding and no secret.

#### Scenario: A current client discovers the server
- **WHEN** a client with a valid token sends `server/discover`
- **THEN** the server answers with its supported protocol versions and capabilities, and no session id

#### Scenario: The retired transport is absent
- **WHEN** any client requests `/sse`
- **THEN** the server answers `404` or `410`

#### Scenario: A foreign origin is refused
- **WHEN** a browser request carries an `Origin` the server does not allow
- **THEN** the server answers `403` before any tool runs

### Requirement: Protected resource metadata and challenges

The server SHALL publish OAuth Protected Resource Metadata (RFC 9728) naming the console's
Better Auth issuer as its only authorization server, and SHALL answer a request without a usable
token with `401` and a `WWW-Authenticate` challenge carrying `resource_metadata` and the
default scopes.

#### Scenario: Unauthenticated request
- **WHEN** a client posts to `/mcp` with no `Authorization` header
- **THEN** it receives `401` with a challenge that points at `/.well-known/oauth-protected-resource/mcp`
- **AND** `ConsoleRPC.authorize` was not called

#### Scenario: Metadata names the issuer
- **WHEN** a client fetches the protected resource metadata
- **THEN** `resource` is the canonical MCP URL and `authorization_servers` is exactly the console issuer

### Requirement: The console is the authorization server

The console's Better Auth instance SHALL issue OAuth 2.1 access tokens for the MCP resource:
authorization code with PKCE `S256`, resource indicators, authorization server metadata (RFC
8414) at the root well-known path of an issuer that is the bare console origin, Client ID
Metadata Documents, and Dynamic Client Registration as a fallback. Access tokens SHALL be JWTs whose audience is the MCP resource.

#### Scenario: Metadata advertises what clients need
- **WHEN** a client fetches `/.well-known/oauth-authorization-server` on the console
- **THEN** its `issuer` is the console origin, exactly as named in the protected resource metadata
- **AND** the document lists the authorize, token and registration endpoints, `S256`, `client_id_metadata_document_supported: true` and `none` as a token endpoint auth method
- **AND** the request succeeds without a session and from another origin

#### Scenario: A session JWT is not an access token
- **WHEN** a signed-in user's session JWT is presented to `/mcp`
- **THEN** it is refused with `401`
- **AND** the console's `/api/auth/token` route does not exist

#### Scenario: Client administration is not served
- **WHEN** any caller requests `/api/auth/oauth2/create-client`, `/api/auth/oauth2/get-clients` or `/api/auth/admin/oauth2/*`
- **THEN** the console answers as it does for an endpoint that was never registered

### Requirement: A grant is bound to one workspace

Every grant SHALL be bound at consent to exactly one organization the consenting user belongs to.
No tool SHALL accept an organization id or an account id.

#### Scenario: A user with several workspaces
- **WHEN** a user who belongs to two organizations authorizes a client
- **THEN** they must pick one before consent, and the issued token acts only in that one

#### Scenario: A new user with no workspace
- **WHEN** a user with no organization authorizes a client
- **THEN** the flow asks for a workspace name, creates the organization and its account through the existing provisioning path, issues no API key, and continues to consent

#### Scenario: No tenant parameter exists
- **WHEN** the tool list is inspected
- **THEN** no tool's input schema contains an organization or account identifier

### Requirement: Authorization is re-derived on every request

For each MCP request the server SHALL obtain the actor from `ConsoleRPC.authorize`, which SHALL
verify the token for this resource, confirm the grant still exists, read the user's current
membership and role, and resolve an `active` organization-to-account link. Nothing about
authorization SHALL be cached across requests in `apps/mcp`.

#### Scenario: A removed member
- **WHEN** a user is removed from the organization while their agent holds an unexpired access token
- **THEN** the agent's next request is refused with `401`

#### Scenario: A demoted member
- **WHEN** an admin is changed to viewer while their agent holds a token with `eccos:administer` and a live elevation
- **THEN** the next call to an administer tool is refused, and read tools still work

#### Scenario: A revoked grant
- **WHEN** the user revokes the client under Connected agents
- **THEN** the next request with that client's access token is refused, without waiting for expiry
- **AND** its refresh token no longer yields a new access token

#### Scenario: A disabled or pending account link
- **WHEN** the organization's account link is not `active`
- **THEN** every request is refused

#### Scenario: Refusals are indistinguishable
- **WHEN** a token is refused for any of the reasons above
- **THEN** the client sees the same `401` challenge in each case

### Requirement: Effective permissions are the intersection of role and scope

A tool SHALL run only when both the user's current role and the token's scopes allow its action,
following the role matrix in `docs/auth-tenancy-contract.md` §4. A token lacking a tool's scope
SHALL receive the scope challenge so the client can ask for it.

#### Scenario: Scope beyond the role
- **WHEN** a viewer's token carries `eccos:administer`
- **THEN** `api_key_create` is refused and `numbers_list` succeeds

#### Scenario: Role beyond the scope
- **WHEN** an owner unticked everything but `eccos:view` at consent and the agent calls `webhook_set`
- **THEN** the server answers `403` with `insufficient_scope` naming `eccos:configure`

#### Scenario: Erasure is not reachable
- **WHEN** the tool list is inspected for any role and scope
- **THEN** no tool performs GDPR erasure, organization deletion, ownership transfer or a role change

### Requirement: Grants are long-lived and sensitive tools require elevation

A grant SHALL NOT lose scopes over time. Tools that correspond to the console actions marked
"MFA / step-up" in `docs/auth-tenancy-contract.md` §4 (step-up tools) SHALL run only while the
grant holds a live elevation: an approval given by the grant's own user, currently owner or admin,
from a session with TOTP and a sign-in within 15 minutes, valid for 24 hours. Elevation SHALL NOT
be carried in the token. Step-up tools SHALL NOT ship before the console itself enforces step-up.

#### Scenario: Elevation given at consent
- **WHEN** an admin approves a client and accepts "allow sensitive actions for 24 hours", passing step-up in that visit
- **THEN** the agent's first call to `api_key_create` runs with no further approval

#### Scenario: Consent without elevation
- **WHEN** an admin approves a client and does not pass step-up
- **THEN** the grant is issued, every tool that is not a step-up tool works, and no elevation exists

#### Scenario: Elevation on demand, client without URL elicitation
- **WHEN** an agent without a live elevation calls `webhook_set` and its client does not declare `elicitation.url`
- **THEN** the result has `isError: true` and structured content with `status: "approval_required"`, `reason: "elevation_required"`, an `approvalUrl` on the console, `expiresAt`, and a retry hint naming the same tool and arguments
- **AND** the text content carries the same JSON, `approvalUrl` included, and the structured content validates against the tool's output schema
- **AND** nothing was changed

#### Scenario: Elevation on demand, client with URL elicitation
- **WHEN** the same call comes from a client that declares `elicitation.url`
- **THEN** the server answers `input_required` with a URL-mode elicitation for the same approval URL
- **AND** when the client retries after the person approved, the tool runs and returns its normal result

#### Scenario: Retry before approval
- **WHEN** the client retries and the person has not approved yet
- **THEN** the server answers with the structured `approval_required` result, not a second prompt

#### Scenario: Only the right person can approve
- **WHEN** the approval URL is opened by anyone other than the grant's user, or by that user after they stopped being owner or admin, or without TOTP and a recent sign-in
- **THEN** no elevation is created

#### Scenario: Elevation lapses silently
- **WHEN** 24 hours have passed since approval
- **THEN** `templates_list`, `template_create` and `template_send_test` keep working with the same tokens, with no re-authorization
- **AND** the next step-up tool call asks for approval again

#### Scenario: Elevation ends with the grant
- **WHEN** the user revokes the client, or ends elevated access under Connected agents
- **THEN** the elevation no longer exists

#### Scenario: One pending request per grant
- **WHEN** an agent calls step-up tools five times while an approval request is pending
- **THEN** all five results carry the same approval URL

### Requirement: Minted secrets are delivered by a one-time claim

A tool that mints a secret (`api_key_create`; `webhook_set` when asked to generate the signing
secret) SHALL by default return a claim instead of the secret. The secret SHALL NOT exist until
the claim is redeemed. A claim SHALL be single use, expire after 10 minutes, be redeemable only by
POST with the token in the body, and return the secret as plain text.

#### Scenario: The agent writes the key without seeing it
- **WHEN** an elevated agent calls `api_key_create`
- **THEN** the result contains `status: "claim_ready"`, a `claimUrl`, a ready-to-run `command`, `expiresAt`, and a message saying the key was not shown and how to claim it
- **AND** the result contains no API key, and `api_keys_list` shows a pending claim and no new key

#### Scenario: Redeeming
- **WHEN** the command is run within 10 minutes
- **THEN** the response is `200`, `text/plain`, `Cache-Control: no-store`, and its body is the key
- **AND** the key now appears in `api_keys_list` and authenticates against `/v1`

#### Scenario: Second redemption
- **WHEN** the same token is posted again
- **THEN** the response is `410` and no second key exists

#### Scenario: Expired unclaimed
- **WHEN** 10 minutes pass without a redemption
- **THEN** posting the token answers `410`, no key was ever issued, and nothing needs revoking

#### Scenario: A GET reveals and spends nothing
- **WHEN** a link preview or scanner sends `GET` to the claim page or the claim API
- **THEN** it receives no secret and the claim is still redeemable

#### Scenario: A person claims in a browser
- **WHEN** a person opens `claimUrl` and presses Reveal
- **THEN** the page shows the secret once, and the token never appeared in a request path or query

#### Scenario: The creator lost the right
- **WHEN** the grant is revoked, or its user is demoted below admin, before redemption
- **THEN** the claim answers `410` and nothing is issued

#### Scenario: Generated webhook secret
- **WHEN** an agent calls `webhook_set` with a URL and `secret: "generate"`
- **THEN** the URL is stored at once, the result carries a claim, and the previous secret stays in force until the claim is redeemed

#### Scenario: Inline by request
- **WHEN** an agent calls `api_key_create` with `delivery: "inline"`
- **THEN** the key is issued and returned in the result once
- **AND** the consent page for `eccos:administer` states that an agent may ask for this

### Requirement: Embedded Signup hand-off

The server SHALL let an agent obtain the workspace's connection link and follow its outcome,
using the existing connection-link mechanism unchanged.

#### Scenario: Link issued
- **WHEN** an elevated agent with `eccos:administer` calls `connect_link_create`
- **THEN** it receives a URL on the console origin and its expiry, and the link is bound to the account and the consenting user

#### Scenario: A live link already exists
- **WHEN** `connect_link_create` is called while a live link exists and `replace` is not set
- **THEN** the tool reports the existing link's state and that its URL cannot be read again

#### Scenario: Subscription required
- **WHEN** the account's connect policy is `closed`
- **THEN** `workspace_get` reports that a subscription is needed and `billing_checkout_link` returns the checkout URL

#### Scenario: Outcome
- **WHEN** a person completes Embedded Signup through the link
- **THEN** `connect_status` reports `connected` with the number, and `numbers_list` shows the WABA's provisioning status

### Requirement: Phase 1 tools cover setup end to end

The server SHALL expose the phase 1 tools listed in design § 4, each with an input schema, an
output schema and structured content, backed by existing `GatewayApi` methods, the secret-claim methods
and the `ConsoleApi` methods this change adds.

#### Scenario: From nothing to a tested number
- **GIVEN** a new customer and an agent, in a test deployment with two accounts
- **WHEN** the agent connects, the person authorizes, subscribes and completes Embedded Signup through the links the agent returned
- **THEN** using only MCP tools and the claim command the agent sets the webhook, issues an API key, creates a template and, once Meta approves it, sends a test message that is delivered
- **AND** the person approved sensitive actions once, at consent

#### Scenario: Secrets are never logged
- **WHEN** a claim is created or redeemed, a key is returned inline, or `connect_link_create` succeeds
- **THEN** no log line or audit line contains the token, the link or the secret

### Requirement: Tenant isolation

Every tool SHALL be covered by a negative test with two accounts.

#### Scenario: A foreign WABA
- **WHEN** an agent for account A passes a `wabaId` owned by account B to any tool
- **THEN** the call is refused and nothing about account B is revealed

### Requirement: Audit and rate limiting

Every mutating tool SHALL write one audit line in the existing format with the user as actor,
`via: "mcp"` and the client id, containing identifiers and outcome only. `/mcp` SHALL be rate
limited per user and client.

#### Scenario: A mutation is attributable
- **WHEN** an elevated agent revokes an API key
- **THEN** one audit line records the user, organization, account, key id, client id and outcome

#### Scenario: A runaway agent
- **WHEN** one client exceeds the limit
- **THEN** it receives `429` and other users and clients are unaffected

### Requirement: Existing surfaces are unchanged

This change SHALL NOT alter the public `/v1` API, account API keys, the forwarding contract, the
console's origin policy for pages and cookies, or any existing console behavior.

#### Scenario: Regression
- **WHEN** `bun run test`, `bun run test:workers` and the dashboard tests run after each phase
- **THEN** they pass without changes to existing tests
