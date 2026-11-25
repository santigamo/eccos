# Research: versions and sources

Everything here was fetched or queried on **2026-11-23**. Versions come from `npm view` run that
day; quotations come from the pages listed. "Not verified" means read in documentation but not
run, or not found in a primary source.

## Verified versions

| Package | Latest | Published (UTC) | Role in this design |
|---|---|---|---|
| `agents` | 0.34.0 | 2026-11-20 | `createMcpHandler` from `agents/mcp/server` |
| `@modelcontextprotocol/server` | 2.4.0 | 2026-10-23 | MCP SDK v2 server; exact peer of `agents` 0.34.0 |
| `@modelcontextprotocol/sdk` | 1.32.2 | 2026-10-23 | SDK v1, legacy; needed only by the deprecated `McpAgent`. Not used |
| `@cloudflare/workers-oauth-provider` | 1.2.4 | 2026-10-22 | `OAuthResourceServer` (1.0.0 was 2026-09-24) |
| `better-auth` | 1.7.27 | 2026-11-20 | The repository pins **1.7.14** (2026-10-26) |
| `@better-auth/mcp` | 1.7.27 | 2026-11-20 | Peer `better-auth ^1.7.27`; depends on `@better-auth/oauth-provider` |
| `@better-auth/oauth-provider` | 1.7.27 | 2026-11-20 | The OAuth 2.1 provider under `mcp()` |
| `@better-auth/cimd` | 1.7.27 | 2026-11-20 | Client ID Metadata Documents; ships a Node fetcher only |
| `hono` | 4.13.21 | 2026-11-23 | Router for `apps/mcp` |
| `wrangler` | 4.166.0 | 2026-11-20 | |
| `jose` | 6.2.18 | 2026-11-18 | Only if the JWKS fallback is ever used |

MCP specification: the current revision is **2026-07-28**; the previous one is 2025-11-25. A
draft exists whose only relevant change moves the CIMD reference to a newer IETF draft.

Pin exact versions. `agents` declares `@modelcontextprotocol/server` as an optional peer at an
exact version (2.4.0 for 0.34.0), and Cloudflare's install snippets lag behind it (they still
show 2.3.1). Follow the peer, not the snippet.

## Cloudflare

- `createMcpHandler`: "The handler is stateless: it builds a fresh server for every request, so
  you do not need a Durable Object, protocol session, or WebSocket."
  <https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/>
- `McpAgent`: "remains available only for existing legacy servers while they migrate. It is
  deprecated and feature-frozen. Migrate to `createMcpHandler` at your earliest convenience."
  Deprecated in `agents` 0.20.0 (2026-07-27).
  <https://developers.cloudflare.com/agents/model-context-protocol/apis/agent-api/>
- The handler does not verify tokens: "`authInfo` is passed to the server factory and request
  handlers. The handler does not derive it from request headers or verify access tokens." It reads
  what `OAuthResourceServer` sets on the execution context.
- Default `legacy: "stateless"` serves 2025-era clients without sessions; GET and DELETE answer
  `405`. `route` defaults to `/mcp`. A custom domain needs `allowedHostnames` and
  `allowedOriginHostnames`.
- Elicitation in the stateless handler is multi-round-trip only (`inputRequired`), with state
  sealed into `requestState`. Through the legacy lane, "Pushed elicitation, sampling, and roots
  requests fail immediately", so 2025-era clients cannot be elicited. Cloudflare's example shows
  form mode only: <https://github.com/cloudflare/agents/tree/main/examples/mcp-elicitation-mrtr>.
  `@modelcontextprotocol/server` 2.4.0 exports `inputRequired.elicitUrl` for URL mode (found by
  unpacking the npm tarball). The design uses it for elevation approval (design § 3.3).
- Transport: Streamable HTTP on one endpoint. Cloudflare's own MCP servers answer `410` on
  `/sse` since 2026-10-22.
  <https://developers.cloudflare.com/changelog/post/2026-10-22-cloudflare-mcp-servers-retire-sse/>
- `OAuthResourceServer`: "The host publishes RFC 9728 metadata at
  `/.well-known/oauth-protected-resource<path>`, answers unauthenticated requests with a Bearer
  challenge that names it and the `requiredScopes` to ask for, calls your validator with its own
  canonical resource and the presented token, refuses a result whose `audience` is not that
  resource, and answers `503` when the validator throws." Scope policy is the handler's:
  `insufficientScope(ctx.auth, [...])` builds the `403` challenge. An `OAuthError` must be
  thrown in the same Worker, not across RPC, which is why `ConsoleRPC.authorize` returns a result
  instead of throwing.
  <https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/resource-servers.md>
- An issuer that is not this package is documented as "Another issuer, at your own risk":
  "`validateToken` is just a function."
- Workers OAuth Provider 1.x announcement (split API, MCP 2026-07-28, CIMD):
  <https://developers.cloudflare.com/changelog/post/2026-10-01-workers-oauth-provider-1x/>
- Guides: <https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/>,
  <https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/>,
  <https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/>.
  Changelog: <https://github.com/cloudflare/agents/blob/main/packages/agents/CHANGELOG.md>.

Not verified: mounting `OAuthResourceServer` and `createMcpHandler` inside a Hono app is
consistent with both APIs (each is a `fetch(request, env, ctx)`) but is not a documented recipe.
Calling a service binding from a tool is ordinary Workers RPC, also not shown in the MCP docs.

## MCP specification, revision 2026-07-28

<https://modelcontextprotocol.io/specification/2026-07-28>

- Stateless: no `initialize` handshake and no `Mcp-Session-Id`. Every request carries its
  protocol version; `server/discover` is mandatory. Servers that need state across calls use
  explicit handles passed as tool arguments.
- Streamable HTTP: one endpoint, POST per message, `MCP-Protocol-Version` and `Mcp-Method`
  headers, and servers must validate `Origin`.
- Authorization (optional, OAuth 2.1 based): servers **must** implement Protected Resource
  Metadata (RFC 9728) and validate that a token was issued for them as audience (RFC 8707);
  "MCP servers MUST NOT accept or transit any other tokens." Clients must use PKCE with `S256`
  and send `resource`. Authorization servers must publish RFC 8414 or OIDC metadata and should
  return `iss` (RFC 9207).
- Client registration: pre-registered, then CIMD (should), then DCR (may, **deprecated**: "New
  implementations should use Client ID Metadata Documents instead"), then asking the user.
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration>
- URL-mode elicitation exists in this revision (introduced in 2025-11-25, "may change in future
  protocol revisions"). The server returns an `InputRequiredResult` carrying
  `elicitation/create` with `mode: "url"`, `url` and `message`; the client must show the target
  host and get consent before opening it, then retries the original request. "`action: "accept"`
  indicates that the user has consented to the interaction. It does not mean that the interaction
  is complete ... the server determines from the echoed `requestState` (or its own stored state)
  whether the out-of-band interaction has completed, and either returns the final result or
  responds with another `InputRequiredResult`." Clients declare it as `elicitation: { url: {} }`
  and "Servers MUST NOT send elicitation requests with modes that are not supported by the
  client." Servers "MUST use URL mode" for sensitive information. One caveat bears on this
  design: "URL mode elicitation is *not* for authorizing the MCP client's access to the MCP
  server (that's handled by MCP authorization)" and servers "MUST NOT rely on URL mode
  elicitation to authorize users for themselves".
  <https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation>
- Insufficient scope at runtime: `403` with `error="insufficient_scope"`, the scopes needed and
  `resource_metadata`; clients re-authorize for the union.

What clients require, from their own documentation:

- Claude supports CIMD and DCR, and picks CIMD only when the server advertises
  `client_id_metadata_document_supported` and `none` as a token endpoint auth method.
  <https://claude.com/docs/connectors/building/authentication>
- ChatGPT supports CIMD, DCR and predefined clients, and prefers CIMD.
  <https://developers.openai.com/plugins/build/auth>
- Cursor documents DCR as a public client and static client ids. <https://cursor.com/docs/mcp>
- Not verified from primary documentation: CIMD in Cursor and in VS Code.

## Better Auth

- 1.7.0 (2026-08-18) removed `oidcProvider` and moved the MCP plugin out of the core package:
  "Install `@better-auth/mcp` and `@better-auth/cimd`, add the now-required `jwt()` plugin ...
  Rename `withMcpAuth` to `requireMcpAuth`." <https://github.com/better-auth/better-auth/releases/tag/v1.7.0>
- "`mcp()` configures the OAuth provider with MCP resource binding and serves the RFC 9728
  protected resource metadata ... MCP deprecates Dynamic Client Registration (DCR), so Better Auth
  never enables DCR implicitly." <https://better-auth.com/docs/plugins/mcp>
- "The JWT plugin is required ... Disable the JWT plugin's `/token` route and its `set-auth-jwt`
  header. Session JWTs share the access tokens' signing key, so a resource server that checks only
  issuer and audience could accept one."
- Endpoints under the auth base path: `/oauth2/authorize`, `/oauth2/token`, `/oauth2/register`
  (only with DCR enabled), `/oauth2/consent`, `/oauth2/continue`, `/oauth2/introspect`,
  `/oauth2/revoke`, `/jwks`. The RFC 8414 document is served at a root well-known path that the
  application must route itself. <https://better-auth.com/docs/plugins/oauth-provider/reference>
- Tokens: access tokens are JWTs (RFC 9068, `typ: at+jwt`, `azp`) when the request names a
  resource; `aud` is the requested resource. Defaults: access 1 hour, refresh 30 days sliding and
  rotating, with family revocation on replay. `customAccessTokenClaims` receives `user`,
  `scopes` and `referenceId`, and may throw to refuse issuance.
- Binding a grant to an organization: `postLogin.consentReferenceId`, with a documented example
  that returns `session.activeOrganizationId`; consent and refresh tokens store the reference.
  <https://better-auth.com/docs/plugins/oauth-provider/sign-in-flow>
- Sign-up inside the flow: `prompt=create` and `signup.page`; the flow continues after a sign-in
  that creates a session.
- Resource server verification without a database: `createMcpProtectedRequestHandler` with
  `issuer`, `audience`, `jwksUrl`; keys cached five minutes; "A JWT keeps passing the local
  check until it expires." This is the fallback path in design § 2.4.
- Workers and D1: build-per-request needs `resourceSeedScope: "process"`; `@better-auth/cimd`
  exports only a Node fetcher and its docs require a DNS-pinning transport elsewhere.
- Advisories: nothing open against `@better-auth/oauth-provider` or `@better-auth/mcp` at
  1.7.27. The batch of 2026-11-03 (fixed in 1.7.16) includes an organization-role issue
  (GHSA-c85h-5mrr-mgx4) and applies to the repository's 1.7.14 pin.
  <https://github.com/better-auth/better-auth/security/advisories>

Not verified, each a spike in tasks.md: the generated D1 migration for the OAuth and JWKS tables;
JWT key storage on D1; the in-process call that verifies a raw access token with the auth
instance; resuming an authorization after email verification; the Workers CIMD fetcher;
`inputRequired.elicitUrl` running through `createMcpHandler`; which clients declare
`elicitation.url`; whether using URL mode for elevation sits within the spec's caveat above.

## Repository facts this design relies on

Read at `3855943` on 2026-11-23.

- `GatewayApi` in `packages/gateway-contract/src/index.ts` has every method named in the phase 1
  and 2 tables.
- Console actions and their permissions come from `apps/dashboard/src/server/gateway.ts`:
  connect, API keys and billing need `administer`; templates need `configure`; sends and cancels
  need `operate`.
- No code in `apps/gateway` or `packages/core` calls `request_code`, `verify_code`, `register`
  or `whatsapp_business_profile`.
- PR #78 ("enforce TOTP and recent sign-in on sensitive actions") is open. `PRODUCTION-READINESS.md`
  describes that enforcement both as landed and as not enforced yet; the code agrees with the
  second.
- No sign-up allowlist exists in `apps/dashboard/src`.
