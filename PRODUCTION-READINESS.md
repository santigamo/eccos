# Production Readiness

> Baseline snapshot: **2026-08-28**, `main@9987f06` plus the post-deploy evidence follow-up.
> The commercial gate below is a living addendum updated **2026-08-28**.
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
| `apps/gateway` (`eccos` Worker + `EccosGateway` DO) | The v1 data plane on Cloudflare Workers | **Candidate** — deployed and live-smoke-verified on 2026-08-28; still gated for customer traffic |
| `apps/dashboard` (`@eccos/dashboard`) | Operator console Worker, RPC-only to the gateway | **Candidate — must not be exposed publicly until Cloudflare Access is enabled** (`eccos-45t`) |
| `packages/core` (`@eccos/core`) | Pure shared core (parser/send/signature/templates) | Internal workspace package — not published (Gate 4 N/A) |
| `packages/gateway-contract` (`@eccos/gateway-contract`) | RPC contract (`GatewayApi`) | Internal workspace package — not published (Gate 4 N/A) |
| `src/` (Bun self-host target) | Dockerised Bun/Hono self-host, retaken post-v1 | Secondary target; kept at parity for data lifecycle |

## Gate status

Legend: ✅ PASS · 🟡 PARTIAL (deliverable landed, residual follow-up) · ⛔ BLOCKED · ➖ N/A · 🕓 WAIVED

| # | Gate | Status | Notes |
|---|------|--------|-------|
| 1 | Change control / CI | ✅ | Dashboard covered in CI (`eccos-a5r`), least-privilege `permissions`, **Biome lint blocking and green** (`eccos-bwr`). No automated prod-deploy gate (manual by design). |
| 2 | Setup & auth surfaces | 🟡 | `/connect` is account-bound and fail-closed (`eccos-13d`). Dashboard edge auth (Cloudflare Access) is code-ready but **not yet enabled at the account level** — 🕓 waived, tracked `eccos-45t`. |
| 3 | Operational readiness | 🟡 | `/ready` deep check + structured JSON logging w/ correlation IDs + `docs/operations.md` (`eccos-ggy`). Residual: alerting/monitoring not wired. |
| 4 | Packaging contract | ➖ | **N/A.** `@eccos/core` and `@eccos/gateway-contract` are internal `workspace:*` packages with no publish intent for v1 (`eccos-1js`, decided). Re-open if they become public SDKs. |
| 5 | Data lifecycle | 🟡 | Configurable split content/delivery retention on Workers, `RETENTION_DAYS` on the Bun target, Bun-target pruning parity, `docs/data-lifecycle.md` (`eccos-rv2`). Residual: scripted backup/export + a real restore drill. |
| 6 | Integration resilience | 🟡 | Retry jitter added; DLQ/manual-replay documented (`eccos-8fu`, `docs/operations.md`). Residual: real DLQ (Queues). |
| 7 | Privacy & security | 🟡 | `docs/threat-model.md` + `docs/privacy.md` + `SECURITY.md` data-handling/logging section (`eccos-501`). Logs exclude bodies/tokens by **convention** (typed `LogMeta`), not enforced by a lint. |
| 8 | Product UI | 🟡 | Dashboard data-layer + render smoke tests (45 dashboard tests) + `docs/ui-qa-checklist.md` (`eccos-1nx`). Residual: automated visual regression (Playwright). |
| 9 | Deployment contract | 🟡 | `docs/deployment.md` (secrets matrix, deploy, rollback) + `scripts/smoke.sh <url>`. Gateway deploy and live smoke were recorded on 2026-08-28; dashboard deployment and a restore drill remain. |

## Evidence (this snapshot)

All local gates below were run on the working tree (post-remediation, 2026-08-28):

| Check | Command | Result |
|-------|---------|--------|
| Types | `bun run typecheck` | ✅ exit 0 (worker types regenerated with the account-scoped bindings) |
| Unit (Bun) | `bun run test` | ✅ 53 pass / 5 files (incl. the account-bound `/connect/exchange` case) |
| Workers | `bun run test:workers` | ✅ 120 pass / 16 files, **0 unhandled exceptions**. Provisioning saga proven: `active` is unreachable unless Meta `subscribed_apps` **and** the gateway DO `saveConfig` both succeed (gateway-stage-failure, attempts-exhaustion, lease/re-claim, revision-guard, cron-driven reconciliation, and fail-closed data-plane tests). Direct `registerWabas` no longer silently defaults to `active` — an explicit `provisioningStatus` is required. |
| Dashboard types | `apps/dashboard: bun run typecheck` | ✅ exit 0 |
| Dashboard tests | `apps/dashboard: bun run test` | ✅ 45 pass / 5 files |
| Dashboard build | `apps/dashboard: bun run build` | ✅ built |
| Lint | `bun run lint` (Biome) | ✅ 0 findings — **blocking** in CI (`eccos-bwr`) |
| Gateway deploy | `bun run deploy` | ✅ `eccos.santi-gamo.workers.dev`, version `75476993-51e1-4009-8e0d-a54454931764` |
| Gateway live smoke | `./scripts/smoke.sh https://eccos.santi-gamo.workers.dev` | ✅ `/health`, `/ready`, webhook challenge/signature/JSON checks |

Environment note (not a product defect): a run of the dashboard suite on 2026-08-27 surfaced
`TypeError: jsxDEV_… is not a function` in the ReUI data-grid. Root cause was a poisoned
local Bun runtime-transpiler cache (oven-sh/bun#32151 — cache key omits the JSX dev/prod
mode). Purging `~/Library/Caches/bun/@t@` restored a full green run; no code change needed.

**Not run:** dashboard deployment (it requires the production `GATEWAY_ACCOUNT_ID`) and a restore
drill. The gateway deploy and live post-deploy smoke are now recorded above.

## Waivers

- **W-1 — Dashboard edge auth (Gate 2).** Cloudflare Access is not enabled at the account
  level. Defense-in-depth JWT re-verification exists in code (`apps/dashboard/src/access.ts`)
  but is a no-op until `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` are set. **Condition:** do not
  expose the dashboard on a public URL until `eccos-45t` is done.

## Remaining gaps (open beads)

| Bead | Gap |
|------|-----|
| `eccos-45t` | Enable Cloudflare Access in front of the dashboard (account-level) |
| `eccos-v80` | Production-shaped two-number acceptance, migration/rollback evidence, and the remaining technical half of the first-paid-customer gate (see [First paid Eccos Cloud customer gate](#first-paid-eccos-cloud-customer-gate)) |
| `eccos-mmq` | End-to-end isolation matrix plus migration/rollback evidence |
| `eccos-n0o` | Meta Tech Provider/App Review/Access approval for third-party onboarding |
| `eccos-8yy` | DPA and processor onboarding package |
| `eccos-45t` | Cloudflare Access in front of the dashboard |
| `eccos-ouw` | Recorded production deploy and post-deploy smoke |
| `eccos-jf7` / `eccos-s3i` | Replace temporary subscriber; validate permanent System User token |

## First paid Eccos Cloud customer gate

**Canonical.** Eccos may be self-hosted and dogfooded (Physeo) at any time, but **Eccos Cloud
must not charge a third party — or start a paid third-party trial — until multi-tenant
product isolation is complete.** This section is the single source of truth for that
commercial gate. It is distinct from, and narrower than, the technical `PRODUCTION-READY`
claim below and from any later business/billing work.

### Scope

- **Blocked until the gate clears:** charging any third-party Eccos Cloud customer, and
  starting any paid third-party trial. No onboarding of external paying tenants.
- **Not blocked (can proceed now):** self-hosting, the Physeo dogfood, the Eccos Cloud
  *pricing model* (the per-number plan is a business decision, not a gate), and building
  the multi-tenant infrastructure itself.
- The **physical WABA sharding** already in place (one Durable Object per WABA,
  `eccos-6lv` / `eccos-vml`, closed) is **data-plane sharding, not commercial
  multi-tenancy**. It separates state per WABA but is **not sufficient** to take money from
  third parties. The active blocker is **`eccos-v80`** — not the already-closed `eccos-6lv`.

### Technical acceptance criteria (all required, tracked under `eccos-v80`)

- Account-scoped authentication (a tenant identity, not a single global API key).
- A durable **account → WABA → phone** registry mapping each tenant to its numbers.
- Per-tenant credentials — no cross-tenant leakage of Meta/API secrets.
- Account-bound `/connect` (Embedded Signup) — onboarding ties a WABA to its owning account.
- At least **two numbers** configured and exercised in production-shaped isolation.
- **Send / read / retry / export / erasure** all scoped to the owning tenant.
- **Negative isolation tests**: prove tenant A cannot read, send, retry, export, or erase
  tenant B's data (and vice-versa), including concurrent access.

The account registry, hashed/revocable account keys, account-bound `/connect`, scoped HTTP/RPC
surface, two-account Worker isolation tests, provisioning saga/reconciliation, and the gateway
deploy/smoke are implemented and validated locally or in the deployed gateway. They are not yet
complete release evidence: the production-shaped two-number exercise, migration/rollback proof,
adversarial review, and the external/legal/operations criteria below remain open. The
production-shaped two-number exercise is blocked until Meta Tech Provider approval (`eccos-n0o`)
is available.

### External / legal / ops criteria (required where applicable)

- Meta **Tech Provider** enablement, **App Review**, and **Access** approval as applicable
  (`eccos-n0o`).
- GDPR **DPA**/processing agreement covering the cloud operator role (`eccos-8yy`).
- **Cloudflare Access** in front of the operator dashboard (see W-1 / `eccos-45t`).
- A recorded **deployment + smoke** (see Gate 9 / `eccos-ouw`).
- A validated **permanent System User token** (see `eccos-jf7` / `eccos-s3i`).
- A healthy production gateway and real subscriber, with the current incident resolved
  (`eccos-u9x` / `eccos-jf7`).

The complete release gate is tracked in `eccos-dci`; it remains blocked until every required
dependency above is closed.

### Necessary ≠ sufficient

Closing this gate is the **necessary** prerequisite to charging, but it is **not sufficient**
by itself: billing, invoicing/payment collection, support load, and the commercial decision
to actually open the product to third parties are separate work that lives outside this
gate and may be done after it. Nothing in this section authorises charging; it only defines
the technical/legal/ops bar that must be met first.

## `PRODUCTION-READY` claim

**Not yet.** The service is a strong **candidate**: all local gates pass and every finding
from the readiness review has been addressed in code or documentation. Before claiming
`PRODUCTION-READY`, close at minimum: **W-1** (`eccos-45t`, dashboard auth) and **Gate 9**
(`eccos-ouw`, a recorded prod deploy + smoke). `PRODUCTION-READY` is a *technical* posture;
it does **not** by itself permit charging third parties — the first paid customer gate above
(or a superseding decision) does.
