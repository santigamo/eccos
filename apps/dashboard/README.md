# @eccos/dashboard — operator console

A small **operator console** for an Eccos gateway: a [TanStack Start](https://tanstack.com/start)
(React) app that runs as its own Cloudflare Worker. It renders gateway status, delivery/inbound/
outbound logs and templates, and exposes a few operator actions (retry a delivery, rotate the
subscriber-forwarding target, re-run the Meta webhook subscription).

The console's visual language — what it inherits from the eccos.chat landing, the
interaction-contrast rules, and the data rules (evidence links, facts strip, empty
states) — is documented in [docs/DASHBOARD-DESIGN.md](../../docs/DASHBOARD-DESIGN.md).
Read it before styling anything here.

## How it reaches the gateway (RPC-only)

The console has **no public HTTP surface into the gateway**. It talks to the gateway Worker
(wrangler name `eccos`) over a **service binding** to its RPC entrypoint `GatewayRPC`:

```
 browser ──▶ dashboard Worker ──(RPC service binding: env.GATEWAY.getStatus(wabaId, accountId))──▶ gateway Worker
```

Server functions in `src/server/gateway.ts` call `env.GATEWAY.<method>(wabaId, accountId)`; the
dashboard derives its account from the Access application's team domain and audience, resolves an
owned WABA from the gateway's registry and passes that account context on every call. The first
authorized visit shows a setup screen that atomically creates the account; no account ID is entered
or deployed manually. The account-scoped console shows a WABA picker in the header; its selection
is kept in the `wabaId` query parameter and is checked against the account registry on every server
function. The gateway's operator API is never exposed over the network. The binding is declared in
[`wrangler.jsonc`](./wrangler.jsonc)
(`services[].entrypoint = "GatewayRPC"`) and its type is tightened in [`src/env.d.ts`](./src/env.d.ts).
If the gateway isn't reachable, each page renders a graceful "unreachable" state instead of crashing.

## Local development

The console and the gateway are two separate Workers, so run **both** locally — the console's
`GATEWAY` service binding resolves to the gateway `wrangler dev` instance:

```bash
# terminal 1 — the gateway Worker (provides the GATEWAY binding target)
cd apps/gateway && bunx wrangler dev --var DO_JURISDICTION: --var GATEWAY_PUBLIC_URL:http://localhost:8787

# terminal 2 — the dashboard (TanStack Start via Vite, in workerd)
cd apps/dashboard && bunx vite dev
```

The empty `DO_JURISDICTION` override is needed because local workerd does not implement
Cloudflare Durable Object jurisdiction restrictions. `.dev.vars` is local-only and ignored by Git.

The dashboard is **account-scoped**: local development uses a local installation identity, while a
Cloudflare Access deployment uses the Access application's team domain and audience. On the first
local visit, the setup screen creates the account; after that, **Connect WhatsApp** starts Embedded
Signup through the gateway, and the console shows data once a WABA is registered (see
`docs/multi-tenancy.md`).

Then open the URL Vite prints. Without the gateway running, the pages still load and show the
"unreachable" state. Other scripts: `bunx vite build` (production build), `bun run typecheck`
(`tsc --noEmit`), `bun run test` (the isolated Access unit check + data-layer tests in `tests/`).

Set `GATEWAY_PUBLIC_URL` in the gateway Worker to its public HTTPS origin before using the
dashboard's **Connect WhatsApp** action. The rest of the console uses only the private RPC binding;
the URL is needed so Meta can return the browser to the gateway's OAuth callback.

## Deploying (account-scoped by default)

Deploy one dashboard Worker and one Cloudflare Access application per account. The Access
application identity is the trusted installation scope; its team domain and audience are resolved
server-side and mapped to one generated account in the gateway control plane. The WABA each RPC
call targets is resolved from that account's registry — operators can switch between the account's
owned WABAs with the header picker (or a `?wabaId=<owned-WABA>` URL).

Configure the two Access vars in [`wrangler.jsonc`](./wrangler.jsonc) or with Wrangler for the
production deployment, then deploy normally:

```bash
# from the repo root
./scripts/deploy-dashboard.sh
```

`bun run deploy` from `apps/dashboard` invokes the same validated helper.

## Securing with Cloudflare Access

The dashboard must not be publicly reachable without Cloudflare Access. Do **not** expose the bare
`*.workers.dev` URL; put it on a custom domain behind
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/). As
defense-in-depth, the Worker *also* re-verifies the Access JWT on every request, so it can't be
bypassed by hitting the raw origin directly.

The account-level setup is done in the **Cloudflare dashboard** (Zero Trust), not in code — only
the two `vars` below live in the repo:

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. Set the application domain to the dashboard's hostname (your custom domain behind Access).
3. Add a **policy** (e.g. *Allow* → emails / an email domain / your team) so only you can enter.
4. On the application's overview, copy its **Application Audience (AUD) tag** (a long hex string).
5. In [`wrangler.jsonc`](./wrangler.jsonc) `vars`, set:
   - `ACCESS_AUD` → the AUD tag from step 4.
   - `ACCESS_TEAM_DOMAIN` → your Zero Trust team domain, e.g. `myteam.cloudflareaccess.com`.
6. Redeploy: `bun run deploy` (`wrangler deploy`).

### How the gate works (and when it's off)

The Worker-side gate lives in [`src/access.ts`](./src/access.ts) (`enforceAccess`) and is wired
into a **custom TanStack Start server entry** ([`src/server.ts`](./src/server.ts)) that wraps the
default fetch handler, so verification runs before **every** request — SSR page loads, server
routes, and server-function calls.

- **Local-only when Access is unset.** Both empty `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` allow only
  localhost development. Partial configuration, public hostnames, and `workers.dev` requests
  without Access fail closed with `403`, so a production dashboard cannot silently become public.
- **When enforcing**, it reads the JWT from the `Cf-Access-Jwt-Assertion` header (falling back to
  the `CF_Authorization` cookie), then verifies it with [`jose`](https://github.com/panva/jose)
  against the team's JWKS (`https://<team-domain>/cdn-cgi/access/certs`), checking the RS256
  signature plus the `iss` (`https://<team-domain>`), `aud` (the AUD tag) and `exp`/`nbf` claims.
- **Fails closed:** a missing token or any verification failure returns `403 Forbidden`; only a
  valid Access JWT is allowed through.

> The first-run setup is intentionally unavailable on public hosts without Access. Set up the
> Access application and configure both Access vars before deploying the production dashboard.
