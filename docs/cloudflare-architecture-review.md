# Cloudflare Architecture Review

Source caveat: the review brief marks 9 claims as triple-verified; the remaining claims come from primary Cloudflare documentation and Cloudflare engineering blog posts.

## Verdict

Eccos is accurately described as maximally serverless and zero external infrastructure on Cloudflare: the Workers target runs HTTP in a Worker, keeps state in a SQLite-backed Durable Object, and uses Durable Object Alarms for scheduled forwarding retries.

Eccos is not maximally idiomatic in two places:

- The Workers target currently sends all stateful work to one global Durable Object instance via `idFromName("singleton")`. That is acceptable for v0 single-tenant simplicity, but Cloudflare documents a single global Durable Object as a bottleneck and recommends partitioning by resource.
- The outbound forwarding retry loop is a hand-rolled queue on Durable Object SQLite and Alarms. That is a legitimate lowest-layer / fewest-moving-parts choice, but it trades away native Queues features such as automatic retry policy, autoscaling consumers, and a dead-letter queue.

## What The Review Validates

- Durable Objects are a sound state-owner primitive for Eccos because they provide strongly consistent transactional storage and global uniqueness for a given object ID: https://developers.cloudflare.com/workers/platform/storage-options/
- A one-Durable-Object-per-WABA/phone model is the right multi-tenant data-plane shape because Cloudflare's reference architecture uses Durable Objects per data-plane resource: https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/
- Durable Object Alarms are valid for per-entity scheduled work, including retry loops, as long as the handler is idempotent and re-schedules itself when more work remains: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- D1, Hyperdrive, Queues, R2, and Workers-native Rate Limiting are all Cloudflare-native options that let Eccos keep the zero-external-infrastructure story: https://developers.cloudflare.com/workers/platform/storage-options/ and https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cloudflare's own Queues and Workflows are built on Durable Objects, Alarms, and SQLite, which means Eccos is using the same lower-level primitives rather than an alien architecture: https://blog.cloudflare.com/how-we-built-cloudflare-queues/ and https://blog.cloudflare.com/building-workflows-durable-execution-on-workers/

## Non-Idiomatic Points

### Singleton Durable Object

The current `EccosGateway` singleton is a deliberate v0 simplification for one WABA / one phone number. It should not be presented as the scaling endpoint: Cloudflare calls a single global Durable Object a documented anti-pattern, and the platform limit guidance puts a single object around 500-1,000 requests per second for simple operations.

Citations:

- https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- https://developers.cloudflare.com/durable-objects/platform/limits/

### Hand-Rolled Forwarding Queue

The current delivery table plus `alarm()` retry loop is defensible because it minimizes moving parts and keeps all state in the same object. The trade-off is that Cloudflare Queues already provides guaranteed at-least-once delivery, batching, retries, configurable `max_retries`, dead-letter queues, and autoscaling consumer concurrency.

Citations:

- https://developers.cloudflare.com/workers/platform/storage-options/
- https://developers.cloudflare.com/queues/configuration/batching-retries/
- https://developers.cloudflare.com/queues/configuration/dead-letter-queues/

## Gaps

- Rate limiting: **Resolved (2026-06-30, `eccos-36z`).** On top of the static `ECCOS_API_KEY` bearer auth, `POST /v1/messages` now passes through the native Cloudflare Rate Limiting binding (`SEND_RATE_LIMITER`, 60/min, defensive 429) — native abuse/spike protection with no external infra: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Dead-letter queue: failed subscriber forwarding attempts are retried and eventually pruned after retention, but exhausted deliveries are not separated into a DLQ for inspection or replay. Queues would provide this natively: https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
- Dashboard auth: the `/dashboard` surface is currently a self-hosted HTTP app concern. Cloudflare Zero Trust Access is a candidate for putting stronger auth in front of the dashboard without adding application-local user management.

## Roadmap Storage Guidance

Keep the storage path serverless-first:

1. Use per-tenant Durable Object SQLite as the primary state owner for WABA/phone data.
2. Add D1 only when Eccos needs cross-tenant relational SQL or read-heavy shared views, while keeping its 10 GB database cap in mind: https://developers.cloudflare.com/workers/platform/storage-options/
3. Use Hyperdrive only if Eccos must reach an existing external Postgres/MySQL database; it is the idiomatic Cloudflare bridge for pooling and caching external SQL connections: https://developers.cloudflare.com/workers/platform/storage-options/

This replaces the older "Postgres storage option (Drizzle)" framing with a Cloudflare-native progression: Durable Object SQLite -> D1 -> Hyperdrive.

## Prioritized Recommendations

_Status as of 2026-06-30 (✅ done · ⏳ open/deferred). Rationale for each item is in the sections above._

| Priority | Recommendation | Status | Citation |
|---|---|---|---|
| P0 | Add Cloudflare Rate Limiting binding to `POST /v1/messages` | ✅ **Done** — `SEND_RATE_LIMITER` binding + defensive 429 guard (`eccos-36z`) | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ |
| P0 | Document and guarantee `alarm()` idempotency in `EccosGateway` | ✅ **Done** — invariant documented + regression test (`eccos-qb9`) | https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ |
| P1 | Shard `EccosGateway` per WABA/phone | ⏳ **Open** — `eccos-6lv`, blocked by multi-tenant (`eccos-v80`) | https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ |
| P1 | Reframe the storage roadmap as DO SQLite -> D1 -> Hyperdrive | ✅ **Done** — README roadmap updated | https://developers.cloudflare.com/workers/platform/storage-options/ |
| P2 | Evaluate Cloudflare Queues + DLQ for outbound forwarding | ⏳ **Deferred** — decision recorded (`eccos-t2w`): keep DO+Alarms for v0 | https://developers.cloudflare.com/queues/configuration/batching-retries/ |
| P3 | Add R2 for outbound media, Access for dashboard auth, and Secrets Store for shared secret management | ⏳ **Future** — post-v1 roadmap | https://developers.cloudflare.com/workers/platform/storage-options/ |

