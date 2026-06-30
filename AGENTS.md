# Eccos — Agent Guide

Eccos is a self-hostable, open-source WhatsApp gateway on the official Meta Cloud API.
Stack: **Bun + Hono + SQLite (`bun:sqlite`)**, TypeScript, Zod — plus a Cloudflare Workers
target (`apps/gateway/`: Durable Object storage + Alarms forwarding, `/connect`, `/dashboard`).
The repo is a **Bun workspace**: shared `@eccos/core` package + per-target apps.

## Build & Test

```bash
bun install            # install dependencies
bun run dev            # Bun target, watch mode (http://localhost:3000)
bun run typecheck      # regenerates the Workers types, then tsc --noEmit
bun run test           # Bun unit tests (parser, signature, connect, config)
bun run test:workers   # vitest-pool-workers tests for the Cloudflare Workers target
bun run deploy         # wrangler deploy (Workers target)
```

> Use `bun run test` + `bun run test:workers`, **not** a bare `bun test` — the latter globs the
> Workers `apps/gateway/tests/worker/*.spec.ts` files and errors on the `cloudflare:test` virtual module.

## Layout

Bun workspace (`packages/*` + `apps/*`); the Bun self-host target lives at `src/` (kept aside).

- `packages/core/` (`@eccos/core`) — shared pure core (parser, types, send, templates, WebCrypto
  signature, config-schema). Runtime-agnostic; imported by every target via bare specifier
  (`@eccos/core/parser`, …). Keep it free of HTTP/DB concerns.
- `apps/gateway/` — the **Cloudflare Workers** target: Hono app (`src/worker.ts`) + the
  `EccosGateway` Durable Object (`src/gateway.ts`, SQLite storage + Alarms forwarding), plus
  `/connect` (Embedded Signup) and `/dashboard`. Owns `wrangler.jsonc` + `vitest.config.ts`. New
  v1 features live here. Tests in `apps/gateway/tests/` (`*.test.ts` Bun + `tests/worker/*.spec.ts`
  vitest-pool-workers).
- `src/` — the **Bun** self-host target (kept aside, retaken post-v1): Hono app, `bun:sqlite`
  storage, in-process delivery loop, `loadConfig(process.env)` adding `PORT` / `DATABASE_PATH`.
  Dockerised (`Dockerfile` runs `bun run src/index.ts`).

## Rules

- Code, identifiers, comments, and user-facing strings are in **English**.
- **Single tenant in v1.** One WABA/phone via env. Do not add multi-tenant tables/flows
  without an explicit roadmap decision.
- Keep `packages/core/` free of HTTP/DB concerns — pure Cloud API + parsing. Routes own I/O.
- The `WhatsAppCallbackEvent` shape is the public forwarding contract; changing it is a
  breaking change for any downstream subscriber. Add tests in `packages/core/tests/parser.test.ts`
  for any parser change.
- Webhook handler must always return 200 quickly so Meta does not disable the subscription.
- This repo is **public/OSS** — never commit real tokens, secrets, or `.env`.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
