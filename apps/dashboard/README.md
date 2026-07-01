# @eccos/dashboard — operator console

A small **operator console** for an Eccos gateway: a [TanStack Start](https://tanstack.com/start)
(React) app that runs as its own Cloudflare Worker. It renders gateway status, delivery/inbound/
outbound logs and templates, and exposes a few operator actions (retry a delivery, rotate the
subscriber-forwarding target, re-run the Meta webhook subscription).

## How it reaches the gateway (RPC-only)

The console has **no public HTTP surface into the gateway**. It talks to the gateway Worker
(wrangler name `eccos`) over a **service binding** to its RPC entrypoint `GatewayRPC`:

```
browser ──▶ dashboard Worker ──(RPC service binding: env.GATEWAY.getStatus())──▶ gateway Worker
```

Server functions in `src/server/gateway.ts` call `env.GATEWAY.<method>()` directly; the gateway's
operator API is never exposed over the network. The binding is declared in
[`wrangler.jsonc`](./wrangler.jsonc) (`services[].entrypoint = "GatewayRPC"`) and its type is
tightened in [`src/env.d.ts`](./src/env.d.ts). If the gateway isn't reachable, each page renders a
graceful "unreachable" state instead of crashing.

## Local development

The console and the gateway are two separate Workers, so run **both** locally — the console's
`GATEWAY` service binding resolves to the gateway `wrangler dev` instance:

```bash
# terminal 1 — the gateway Worker (provides the GATEWAY binding target)
cd apps/gateway && bunx wrangler dev

# terminal 2 — the dashboard (TanStack Start via Vite, in workerd)
cd apps/dashboard && bunx vite dev
```

Then open the URL Vite prints. Without the gateway running, the pages still load and show the
"unreachable" state. Other scripts: `bunx vite build` (production build), `bun run typecheck`
(`tsc --noEmit`), `bun run test` (the isolated Access unit check in `tests/`).

## Securing with Cloudflare Access

The dashboard ships with **no edge authentication**. Do **not** leave it publicly reachable
(avoid the bare `*.workers.dev` URL; put it on a custom domain) until it sits behind
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

- **Disabled by default.** The gate only enforces when **both** `ACCESS_TEAM_DOMAIN` and
  `ACCESS_AUD` are non-empty. Empty (the default) = no gate — so `vite dev` and a fresh deploy
  that isn't behind Access yet keep working.
- **When enforcing**, it reads the JWT from the `Cf-Access-Jwt-Assertion` header (falling back to
  the `CF_Authorization` cookie), then verifies it with [`jose`](https://github.com/panva/jose)
  against the team's JWKS (`https://<team-domain>/cdn-cgi/access/certs`), checking the RS256
  signature plus the `iss` (`https://<team-domain>`), `aud` (the AUD tag) and `exp`/`nbf` claims.
- **Fails closed:** a missing token or any verification failure returns `403 Forbidden`; only a
  valid Access JWT is allowed through.

> Because the gate is a no-op until both vars are set, a bare deploy is **unauthenticated**. Set
> up the Access application first, then set the vars.
