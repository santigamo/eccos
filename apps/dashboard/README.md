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

Server functions in `src/server/gateway.ts` resolve the tenant server-side (Better Auth session →
organization membership → organization→account link → owned WABA) and pass that account context on
every call. The WABA picker selection is kept in the `wabaId` query parameter and is checked against
the account registry on every server function. The gateway's operator API is never exposed over the
network; the binding is declared in [`wrangler.jsonc`](./wrangler.jsonc)
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

### Customer auth (Better Auth + D1)

The identity plane (sign-up/sign-in, sessions, organizations) is [Better Auth](https://better-auth.com)
on a dedicated auth D1 database (binding `DB`) — see
[`docs/auth-tenancy-contract.md`](../../docs/auth-tenancy-contract.md) for the tenancy contract.
Local setup:

```bash
cd apps/dashboard
bun run db:migrate:local          # apply auth schema to the local D1
cp .dev.vars.example .dev.vars    # dev-only BETTER_AUTH_SECRET / BETTER_AUTH_URL
```

The auth handler is mounted at `/api/auth/*` in `src/server.ts`; the auth instance is built
per request in `src/auth/` (no module-global state). The schema lives in
`migrations/0001_better_auth_schema.sql`, generated with `bun run db:generate`
(Better Auth CLI, config in `scripts/auth-schema.config.ts`) and applied explicitly by deploy —
never at Worker startup.

The empty `DO_JURISDICTION` override is needed because local workerd does not implement
Cloudflare Durable Object jurisdiction restrictions. `.dev.vars` is local-only and ignored by Git.

The dashboard is **account-scoped**: the account comes from the signed-in user's organization
(organization → account link in the control plane). **Connect WhatsApp** starts Embedded Signup
through the gateway (admin permission required), and the console shows data once a WABA is
registered (see `docs/multi-tenancy.md`).

Then open the URL Vite prints. Without the gateway running, the pages still load and show the
"unreachable" state. Other scripts: `bunx vite build` (production build), `bun run typecheck`
(`tsc --noEmit`), `bun run test` (auth, host-allowlist, and data-layer tests in `tests/`).

Set `GATEWAY_PUBLIC_URL` in the gateway Worker to its public HTTPS origin before using the
dashboard's **Connect WhatsApp** action. The rest of the console uses only the private RPC binding;
the URL is needed so Meta can return the browser to the gateway's OAuth callback, which then hands
the operator back to `/numbers` in the console.

## Deploying

Deploy one customer dashboard Worker. The WABA each RPC call targets is resolved from the
organization's account registry — operators can switch between the account's owned WABAs with the
header picker (or a `?wabaId=<owned-WABA>` URL).

Set the production secrets (`BETTER_AUTH_SECRET`, optional `MAIL_FROM`) and apply the remote D1
schema, then deploy:

```bash
# from the repo root
./scripts/deploy-dashboard.sh
```

`bun run deploy` from `apps/dashboard` invokes the same validated helper.

## Customer auth & host policy (Better Auth)

Customer authentication is **Better Auth only** on the dedicated auth D1
(`DB` binding) — Cloudflare Access is not part of the customer surface. The
contract lives in [`docs/auth-tenancy-contract.md`](../../docs/auth-tenancy-contract.md).

- **Canonical host:** only `https://app.eccos.chat` is the customer origin. The
  server entry (`src/server.ts`) enforces this allowlist **before routing**, so
  raw `*.workers.dev` and preview origins fail closed with `403` and are not
  alternate customer paths. `workers_dev` is disabled in `wrangler.jsonc`.
- **Session enforcement:** every page load, loader, and server function resolves
  the Better Auth session server-side; data operations additionally require an
  organization permission (`view`/`operate`/`configure`/`administer`/`erase`).
- **Account resolution:** the organization→account link lives in the gateway
  control plane (`organization_accounts`); the browser-supplied ids are never
  authorization evidence.

Production secrets (Worker secrets, set with `wrangler secret put`):

- `BETTER_AUTH_SECRET` — auth secret (>= 32 chars)
- `RESEND_API_KEY` — transactional email (see `docs/auth-email-delivery.md`)

Apply the auth schema before serving traffic: `bun run db:migrate:local` for
local development; `wrangler d1 migrations apply eccos-auth --remote` for
production (eccos-0x0.9 covers the full cutover checklist).
