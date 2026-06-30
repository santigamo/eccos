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

Eccos has **two deployment targets** that share one pure core:

- `src/core/` — pure, dependency-light core shared by both targets: Meta webhook parser,
  WebCrypto HMAC signature, send + templates clients, Zod config schema. **Keep this free of
  HTTP/DB concerns.**
- `src/` — the **Bun** target: Hono app, `bun:sqlite` storage, in-process delivery loop.
- `worker/` — the **Cloudflare Workers** target: Hono app, a Durable Object (`EccosGateway`)
  for SQLite storage and Alarms-based forwarding, plus the `/connect` (Embedded Signup) and
  `/dashboard` routes. New v1 features land here first; Bun feature parity is post-v1 backlog.

## Running the checks

Every PR must pass these (CI runs the same):

```bash
bun run typecheck      # tsc --noEmit
bun run test           # Bun unit tests (parser, signature, connect, config)
bun run test:workers   # vitest-pool-workers integration tests for worker/
```

> **Use the scripts above — not a bare `bun test`.** `bun run test` is scoped to the core unit
> suites (`tests/*.test.ts`). The Workers integration tests live in `tests/worker/*.spec.ts` and
> only run under `vitest-pool-workers` (`bun run test:workers`). A bare `bun test` globs both and
> will error with `Cannot find package 'cloudflare:test'` / `'cloudflare:workers'` on the worker
> specs — that's a runner mismatch, not a real failure.

## Conventions

- **Language:** code, identifiers, comments, and user-facing strings are in **English**.
- **The `WhatsAppCallbackEvent` shape is a public contract.** Changing it is a breaking
  change for every downstream subscriber. If you touch the parser, add/extend tests in
  `tests/parser.test.ts`.
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
