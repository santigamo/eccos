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

- Rate limiting: `POST /v1/messages` is currently protected by static `ECCOS_API_KEY` bearer auth, but there is no native abuse or spike protection yet. Cloudflare's Rate Limiting binding can be configured in `wrangler` and enforced inside the Worker with `limit()`: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Dead-letter queue: failed subscriber forwarding attempts are retried and eventually pruned after retention, but exhausted deliveries are not separated into a DLQ for inspection or replay. Queues would provide this natively: https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
- Dashboard auth: the `/dashboard` surface is currently a self-hosted HTTP app concern. Cloudflare Zero Trust Access is a candidate for putting stronger auth in front of the dashboard without adding application-local user management.

## Roadmap Storage Guidance

Keep the storage path serverless-first:

1. Use per-tenant Durable Object SQLite as the primary state owner for WABA/phone data.
2. Add D1 only when Eccos needs cross-tenant relational SQL or read-heavy shared views, while keeping its 10 GB database cap in mind: https://developers.cloudflare.com/workers/platform/storage-options/
3. Use Hyperdrive only if Eccos must reach an existing external Postgres/MySQL database; it is the idiomatic Cloudflare bridge for pooling and caching external SQL connections: https://developers.cloudflare.com/workers/platform/storage-options/

This replaces the older "Postgres storage option (Drizzle)" framing with a Cloudflare-native progression: Durable Object SQLite -> D1 -> Hyperdrive.

## Prioritized Recommendations

| Priority | Recommendation | Rationale | Citation |
|---|---|---|---|
| P0 | Add Cloudflare Rate Limiting binding to `POST /v1/messages` | Static API-key auth does not protect against valid-key abuse or traffic spikes. | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ |
| P0 | Document and guarantee `alarm()` idempotency in `EccosGateway` | Durable Object alarms can fire more than once, so forwarding retries must be safe to repeat. | https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ |
| P1 | Shard `EccosGateway` per WABA/phone | A singleton Durable Object is a documented bottleneck; one object per WABA/phone is the multi-tenant scale path. | https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ |
| P1 | Reframe the storage roadmap as DO SQLite -> D1 -> Hyperdrive | D1 is the native serverless SQL step; Hyperdrive is the Cloudflare-native route to external SQL if ever required. | https://developers.cloudflare.com/workers/platform/storage-options/ |
| P2 | Evaluate Cloudflare Queues + DLQ for outbound forwarding | Queues add native retries, batching, autoscaling consumers, and DLQ handling, at the cost of another binding. | https://developers.cloudflare.com/queues/configuration/batching-retries/ |
| P3 | Add R2 for outbound media, Access for dashboard auth, and Secrets Store for shared secret management | These are native Cloudflare services that improve scale, security, and operations without external infrastructure. | https://developers.cloudflare.com/workers/platform/storage-options/ |

