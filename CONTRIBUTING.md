# Contributing to Eccos

Thanks for your interest in Eccos! This is a small, deliberately-thin WhatsApp gateway —
contributions that keep it small, auditable, and correct are very welcome.

## Getting started

```bash
bun install
cp .env.example .env   # fill in your Meta credentials for local runs
bun run dev            # http://localhost:3000/health
```

You need [Bun](https://bun.sh) `>= 1.3`. The Cloudflare Workers target additionally uses
[Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency).

## Repository layout

Eccos is a **Bun workspace** (`packages/*` + `apps/*`) — a shared pure core + per-target apps:

- `packages/core/` (`@eccos/core`) — pure, dependency-light core shared by every target: Meta
  webhook parser, WebCrypto HMAC signature, send + templates clients, Zod config schema. Imported
  via bare specifier (`@eccos/core/parser`, …). **Keep this free of HTTP/DB concerns.**
- `apps/gateway/` — the **Cloudflare Workers** target: Hono app, a Durable Object (`EccosGateway`)
  for SQLite storage and Alarms-based forwarding, plus the `/connect` (Embedded Signup) and
  `/dashboard` routes. New v1 features land here first.
- `apps/dashboard/` (`@eccos/dashboard`) — the **operator console**: a TanStack Start (React) app
  on Cloudflare Workers that talks to the gateway over an **RPC service binding** (never public
  HTTP) and re-verifies a Cloudflare Access JWT when placed behind Access. See its own
  [`apps/dashboard/README.md`](./apps/dashboard/README.md).
- `src/` — the **Bun** self-host target (kept aside, retaken post-v1): Hono app, `bun:sqlite`
  storage, in-process delivery loop. Built by the `Dockerfile`.

## Running the checks

Every PR must pass these (CI runs the same):

```bash
bun run typecheck      # tsc --noEmit
bun run test           # Bun unit tests (parser, signature, connect, config)
bun run test:workers   # vitest-pool-workers integration tests for apps/gateway/
```

> **Use the scripts above — not a bare `bun test`.** `bun run test` is scoped to the Bun unit
> suites (`packages/core/tests/*.test.ts` + `apps/gateway/tests/*.test.ts`). The Workers integration
> tests live in `apps/gateway/tests/worker/*.spec.ts` and only run under `vitest-pool-workers`
> (`bun run test:workers`). A bare `bun test` globs both and will error with `Cannot find package
> 'cloudflare:test'` / `'cloudflare:workers'` on the worker specs — that's a runner mismatch, not a
> real failure.

## Conventions

- **Language:** code, identifiers, comments, and user-facing strings are in **English**.
- **The `WhatsAppCallbackEvent` shape is a public contract.** Changing it is a breaking
  change for every downstream subscriber. If you touch the parser, add/extend tests in
  `packages/core/tests/parser.test.ts`.
- The webhook handler must always return `200` quickly so Meta does not disable the
  subscription.
- **Never commit secrets.** `.env`, real tokens, App Secrets, and API keys stay out of the
  repo (`.env` and `data/` are gitignored). Use placeholders in `.env.example`.
- Match the style of the surrounding code; keep the core readable in one sitting.

## Pull requests

1. Fork and branch from `main`.
2. Make your change with tests and a green `typecheck` + both test suites.
3. Open a PR describing **what** changed and **why**. Link any related issue.

By contributing you agree that your contributions are licensed under the [MIT License](./LICENSE).
