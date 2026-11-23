# Tasks

Each numbered item is one pull request, sized for review on its own. Tests come first
(`strict_tdd`). Nothing here is started by this change.

## Phase 0: groundwork

- [x] 0.1 Bump `better-auth` from 1.7.14 to 1.7.27 (exact pin) in `apps/dashboard` and
      `packages/auth-baseline`. Re-read what the code comments say to re-read on a bump: the
      order of the verified check and the auto-sign-in in email verification, the
      `runInBackgroundOrAwait` mail behaviour, `validateSchema`. Run the auth test suites.
      Done in PR #101.
- [ ] 0.2 Merge PR #78 (TOTP and step-up enforcement), and make `PRODUCTION-READINESS.md` say one
      thing about it.
- [x] 0.3 Spike, on a branch that is not merged, answering with evidence:
  - the generated D1 migration for the OAuth and JWKS tables applies cleanly, and JWT key storage
    works on D1;
  - the in-process call that verifies a raw access token with the auth instance (else `jose`
    against keys read in process);
  - a named `WorkerEntrypoint` export survives the TanStack Start build and is reachable over a
    service binding;
  - `OAuthResourceServer` and `createMcpHandler` compose inside Hono, and the actor reaches tools;
  - a Workers fetcher for `cimd()` under `global_fetch_strictly_public`;
  - `postLogin.consentReferenceId` with the organization, and the claim in the token;
  - resuming an authorization after email verification;
  - `inputRequired.elicitUrl` through `createMcpHandler`: the round trip, `requestState`, and
    which of Claude, ChatGPT and Cursor declare `elicitation.url` and how each presents it;
  - how each client shows a tool result with `isError: true` and structured content, since that
    is the approval path for most of them;
  - step-up inside the consent visit (re-authentication and TOTP without losing the signed
    authorization query);
  - whether sends over `GatewayRPC` pass `SEND_RATE_LIMITER`;
  - Claude, ChatGPT and Cursor each complete the flow against the spike.

  Answers in design § 8. The hosted-client items need a deployment and accounts and moved to 0.5.
- [x] 0.4 Record the answers in this change's design.md and adjust the tasks below.
- [ ] 0.5 Hosted clients against a test deployment of the console and `apps/mcp` (design § 8.3),
      with the owner's accounts: Claude (web connector and Claude Code), ChatGPT (a plan that
      offers custom MCP servers) and Cursor each complete sign-in, workspace step, consent and a
      tool call; record whether each declares `elicitation.url`, what the model and the UI show
      for the approval result, which well-known paths each requests first, and whether
      ChatGPT's client metadata document fetches from production (else it uses DCR). Runs before
      1.10's end-to-end scenario; nothing in 1.1 to 1.9 waits on it, because the structured
      approval result works on every client.

## Phase 1: connect and set up

- [x] 1.1 Amend `docs/auth-tenancy-contract.md` and `docs/threat-model.md` as listed in
      design § 5.5. Documentation only, reviewed before the code that relies on it.
- [ ] 1.2 Authorization server in the console: `jwt()` with the bare origin as issuer and
      `disabledPaths: ["/token"]`, `mcp()`, `cimd()` with the Workers fetcher, in `createAuth`
      and in `scripts/auth-schema.config.ts` (which needs `baseURL`); the committed migration;
      the root RFC 8414 route and its place before the page gate; `global_fetch_strictly_public`
      on the console Worker; sign-in and sign-up through `oauthProviderClient`, following the
      returned `url`, and sign-up's verification `callbackURL` set to the pending authorization;
      cross-origin answers without cookies for the token, registration,
      JWKS and metadata endpoints; the refused client-administration endpoints. Tests: metadata
      contents and issuer, a session JWT is refused, blocked endpoints, CIMD refusals (HTTP,
      private literals, redirects), resuming after sign-in, TOTP and email verification.
- [ ] 1.3 Workspace step and consent page: pick or create the workspace, bind it to the grant,
      show client name, redirect host, workspace and scopes, each scope untickable; English copy,
      following `docs/DASHBOARD-DESIGN.md`. Tests: the claim callback refuses a non-member.
- [ ] 1.4 Connected agents in Settings: list grants on the workspace, revoke, audit lines.
      Revoke deletes the consent row and revokes the grant's refresh tokens. Tests: refresh after
      revoke is refused.
- [ ] 1.4a Elevation in the console (after PR #78): the table and migration, the approval page,
      "allow sensitive actions for 24 hours" on the consent page, End elevated access. Tests:
      only the grant's user with TOTP and a recent sign-in can approve; expiry; one pending
      request per grant; revoke ends it.
- [x] 1.4b Secret claims in the gateway: the control-plane table, `createSecretClaim` and
      `redeemSecretClaim` on `GatewayRPC`, mint-on-redeem for API keys (one control-plane call)
      and the subscriber secret (a spend, then a write to the WABA's object), pending claims from
      `listSecretClaims`. Worker tests: single use, expiry leaves nothing, concurrency. The
      hardening follow-up adds cancellation by a newer secret or claim, a bound of 20 pending
      claims per account, and `write_failed`.
- [ ] 1.4c Claim page and `POST /api/claim` in the console: POST-only redemption, token in body
      or fragment, wrong-token limit, creator re-check. Tests: a GET spends nothing.
- [ ] 1.5 `packages/console-contract`, `ConsoleRPC.authorize` and `requestElevation`. `authorize`
      verifies with `auth.api.getJwks()` and `jose`. Tests: every refusal in the spec's
      "re-derived on every request" requirement, against a real D1 and a control-plane stub; a
      CI check that the built `dist/server` still exports `ConsoleRPC`.
  - [x] `packages/console-contract` (the `ConsoleApi` types, including the billing methods
        that 1.7 needs) landed first, on its own, so the console and `apps/mcp` build against
        one contract.
- [x] 1.6 `apps/mcp` skeleton: Hono, `OAuthResourceServer`, `createMcpHandler`, bindings,
      rate limit, audit helper, the step-up guard with both carriers (URL-mode elicitation and
      the structured result, its JSON also in the text block), `workspace_get` only. The server
      is built on the first request, since `OAuthResourceServer` validates its metadata when
      constructed. Worker tests: challenge, metadata, origin
      check, scope challenge, both approval carriers, no authorization caching.
- [x] 1.7 Tools: billing (`ConsoleRPC.getBilling`, `startCheckout`, `openBillingPortal`),
      connection link and status, numbers and status.
- [x] 1.8 Tools: webhook and API keys, with claim delivery and the inline opt-in. Built against
      the stub console; claims are redeemed by the console's 1.4c page, which ships separately.
- [x] 1.9 Tools: templates and test send.
- [ ] 1.10 Two-account negative tests for every tool; the end-to-end scenario on a test
      deployment; deploy script and `docs/deployment.md` section for `apps/mcp`;
      `PRODUCTION-READINESS.md` artifact row.
- [ ] 1.11 Customer documentation: how to connect an agent, what each scope allows, approving
      sensitive actions, claiming a secret, what passes through the agent, how to revoke.

## Phase 2: observe and operate

- [ ] 2.1 Message, delivery and retry tools.
- [ ] 2.2 Conversation tools and `message_send_text`; consent copy and `docs/privacy.md` for
      message content reaching the customer's model provider.
- [ ] 2.3 Broadcast and scheduled read and cancel tools.

## Phase 3: phone-number management

- [ ] 3.1 Spike on a test WABA: the stored Embedded Signup token against the number write calls.
- [ ] 3.2 `packages/core`: Graph calls for phone fields, add, request and verify code, register,
      PIN, display name, business profile, with tests.
- [ ] 3.3 Control plane and `GatewayRPC`: an unverified number's lifecycle, the request-code
      guard, PIN handling.
- [ ] 3.4 MCP tools, and the same actions in the console.

## Phase 4: campaigns and team

- [ ] 4.1 `GatewayRPC` methods to create broadcasts and scheduled sends, reusing the `/v1`
      implementation.
- [ ] 4.2 Tools for them and for template sends.
- [ ] 4.3 `ConsoleRPC` member methods and tools.
- [ ] 4.4 Export, once a delivery channel outside the model's context is designed.

## Phase 5: obtaining numbers

- [ ] 5.1 The customer's own carrier account (design, decision 1). Eccos holding numbers stays
      on hold until the four answers listed there exist.
