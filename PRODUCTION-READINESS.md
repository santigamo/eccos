# Production Readiness

> Snapshot: **2026-07-01**, `main@b1b20fc` plus the round-2 lint/hardening follow-up (committed).
> Owner: Santi (@santigamo). This file is the single source of truth for Eccos's
> production-readiness posture: profile, per-artifact claims, gate status, waivers,
> evidence, and remaining gaps. Update it whenever a gate's status changes.

## Profile

**Primary classification:** `app/service` (an operational service, not a library).

**Modifiers:** `open-source`, `agent-developed`, `stateful`, `integration-heavy`,
`privacy-sensitive`, `product-ui`, `multi-artifact`.

- `regulated` — **not claimed.** No regulatory regime (HIPAA/PCI/etc.) is in scope for v1;
  Meta Cloud API policy compliance is the operator's responsibility.
- `Packaging Contract` — **N/A for v1** (see Gate 4). The workspace packages are internal,
  not published SDKs.

## Artifacts

| Artifact | What it is | Production claim |
|----------|-----------|------------------|
| `apps/gateway` (`eccos` Worker + `EccosGateway` DO) | The v1 data plane on Cloudflare Workers | **Candidate** — gated; deploy is manual, unverified in prod |
| `apps/dashboard` (`@eccos/dashboard`) | Operator console Worker, RPC-only to the gateway | **Candidate — must not be exposed publicly until Cloudflare Access is enabled** (`eccos-45t`) |
| `packages/core` (`@eccos/core`) | Pure shared core (parser/send/signature/templates) | Internal workspace package — not published (Gate 4 N/A) |
| `packages/gateway-contract` (`@eccos/gateway-contract`) | RPC contract (`GatewayApi`) | Internal workspace package — not published (Gate 4 N/A) |
| `src/` (Bun self-host target) | Dockerised Bun/Hono self-host, retaken post-v1 | Secondary target; kept at parity for data lifecycle |

## Gate status

Legend: ✅ PASS · 🟡 PARTIAL (deliverable landed, residual follow-up) · ⛔ BLOCKED · ➖ N/A · 🕓 WAIVED

| # | Gate | Status | Notes |
|---|------|--------|-------|
| 1 | Change control / CI | ✅ | Dashboard covered in CI (`eccos-a5r`), least-privilege `permissions`, **Biome lint blocking and green** (`eccos-bwr`). No automated prod-deploy gate (manual by design). |
| 2 | Setup & auth surfaces | 🟡 | `/connect` is now fail-closed (`eccos-13d`). Dashboard edge auth (Cloudflare Access) is code-ready but **not yet enabled at the account level** — 🕓 waived, tracked `eccos-45t`. |
| 3 | Operational readiness | 🟡 | `/ready` deep check + structured JSON logging w/ correlation IDs + `docs/operations.md` (`eccos-ggy`). Residual: alerting/monitoring not wired. |
| 4 | Packaging contract | ➖ | **N/A.** `@eccos/core` and `@eccos/gateway-contract` are internal `workspace:*` packages with no publish intent for v1 (`eccos-1js`, decided). Re-open if they become public SDKs. |
| 5 | Data lifecycle | 🟡 | Configurable `RETENTION_DAYS` on both targets, Bun-target pruning parity, `docs/data-lifecycle.md` (`eccos-rv2`). Residual: scripted backup/export + a real restore drill. |
| 6 | Integration resilience | 🟡 | Retry jitter added; DLQ/manual-replay documented (`eccos-8fu`, `docs/operations.md`). Residual: real DLQ (Queues) and singleton-DO sharding (`eccos-6lv`/`eccos-v80`). |
| 7 | Privacy & security | 🟡 | `docs/threat-model.md` + `docs/privacy.md` + `SECURITY.md` data-handling/logging section (`eccos-501`). Logs exclude bodies/tokens by **convention** (typed `LogMeta`), not enforced by a lint. |
| 8 | Product UI | 🟡 | Dashboard data-layer + render smoke tests (35 dashboard tests) + `docs/ui-qa-checklist.md` (`eccos-1nx`). Residual: automated visual regression (Playwright). |
| 9 | Deployment contract | 🟡 | `docs/deployment.md` (secrets matrix, deploy, rollback) + `scripts/smoke.sh <url>`. Residual: **no prod deploy or live smoke has been executed/recorded** (`eccos-ouw`). |

## Evidence (this snapshot)

All gates below were run locally on the working tree (post-remediation):

| Check | Command | Result |
|-------|---------|--------|
| Types | `bun run typecheck` | ✅ exit 0 (worker types regenerated w/ `RETENTION_DAYS`) |
| Unit (Bun) | `bun run test` | ✅ 42 pass / 4 files |
| Workers | `bun run test:workers` | ✅ 41 pass / 8 files |
| Dashboard types | `apps/dashboard: bun run typecheck` | ✅ exit 0 |
| Dashboard tests | `apps/dashboard: bun run test` | ✅ 35 pass / 3 files |
| Dashboard build | `apps/dashboard: bunx vite build` | ✅ built |
| Lint | `bun run lint` (Biome) | ✅ 0 findings — **blocking** in CI (`eccos-bwr`) |

**Not run:** no `wrangler deploy`, no live post-deploy smoke, no restore drill. Those remain
unproven and are called out in Gate 9 / Gate 5.

## Waivers

- **W-1 — Dashboard edge auth (Gate 2).** Cloudflare Access is not enabled at the account
  level. Defense-in-depth JWT re-verification exists in code (`apps/dashboard/src/access.ts`)
  but is a no-op until `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` are set. **Condition:** do not
  expose the dashboard on a public URL until `eccos-45t` is done.

## Remaining gaps (open beads)

| Bead | Gap |
|------|-----|
| `eccos-45t` | Enable Cloudflare Access in front of the dashboard (account-level) |
| `eccos-ouw` | Execute + record a real prod deploy and post-deploy smoke |
| `eccos-6lv` / `eccos-v80` | Shard the singleton DO / multi-tenant (scale + real DLQ) |
| `eccos-3zm` | Persist callback URL at `/connect` for zero-config resubscribe |
| `eccos-jf7` / `eccos-s3i` | Replace temporary subscriber; validate permanent System User token |

## `PRODUCTION-READY` claim

**Not yet.** The service is a strong **candidate**: all local gates pass and every finding
from the readiness review has been addressed in code or documentation. Before claiming
`PRODUCTION-READY`, close at minimum: **W-1** (`eccos-45t`, dashboard auth) and **Gate 9**
(`eccos-ouw`, a recorded prod deploy + smoke).
