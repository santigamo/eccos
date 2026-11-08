# Webhook pipeline observability

Meta webhook → parse → ingest/store (the WABA's Durable Object) → forward to the subscriber.
Each stage writes one JSON log line per webhook, batch, or delivery (never one per event) to
Workers Logs. Lines carry business-side ids (`wabaId`, `phoneNumberId`, `deliveryId`,
`accountId`) and counts only: never message content, phone numbers, user ids (BSUIDs), names or
payload values.

Workers Observability indexes every top-level key, so each field below can be filtered on or
grouped by in the Query Builder (Workers & Pages → Observability → Investigate).

## Events

### Worker: `POST /webhooks/meta`

| `event` | When | Fields |
|---|---|---|
| `webhook_ingested` | One per stored batch (WABA + phone) | `wabaId`, `phoneNumberId`, `eventCount`, `received`, one `n_<type>` count per event type: `n_reply`, `n_echo`, `n_status_sent` / `_delivered` / `_read` / `_failed`, `n_message_<messageType>`, `n_message_echo_<messageType>` |
| `webhook_ignored` | A batch was parsed but not stored, or the webhook parsed to no event | `reason`, plus `wabaId`, `phoneNumberId`, `eventCount` for a batch, or `wabaIds`, `bodyBytes`, `shape` for `no_events` and `sync_only` |
| `webhook_dropped` | Messages or echoes of a WABA parsed to no event | `wabaId`, `dropped` (count), `missing` (required fields absent, e.g. `from`; empty when they only carried nothing), `types` (`text+reaction`, `echo_text`), `keys` (their top-level key names) |
| `webhook_held` | A batch of a WABA that is not active (`pending`: provisioning or a re-run Embedded Signup; or `failed`) was held in its Durable Object, to be ingested once it is active | `wabaId`, `phoneNumberId`, `eventCount`, `heldEvents` (total now held for the WABA) |
| `webhook_ingest_failed` | The Durable Object write failed (answered 503, Meta retries) | `wabaIds`, `bodyBytes`, `errorType` |
| `webhook_hold_failed` | Holding the batch of a WABA that is not active failed (answered 503, Meta retries) | `wabaIds`, `bodyBytes`, `errorType` |
| `webhook_sync_captured` | A coexistence sync payload was stored | `wabaId`, `fields`, and what was stored |

`webhook_ignored.reason`:

| `reason` | Meaning |
|---|---|
| `no_events` | Nothing in the webhook maps to an event (a field Eccos does not forward, or every message dropped: see `webhook_dropped` and `shape`) |
| `sync_only` | A coexistence sync webhook (`history`, `smb_app_state_sync`): stored (see `webhook_sync_captured`), nothing to forward live. Expected in bulk while a number imports its history |
| `unknown_waba` | The WABA is not registered in the control plane |
| `hold_full` | The WABA is `pending` or `failed` and already holds 5000 events |
| `phone_not_registered` | The WABA is active but the phone number id is not registered under it |
| `invalid_waba_id` | The entry id is not a WABA id |
| `lookup_failed` | The control plane lookup threw |

### Worker: `POST /v1/wabas/:wabaId[/phones/:phoneNumberId]/messages`

| `event` | When | Fields |
|---|---|---|
| `outbound_send` | One per send request | `wabaId`, `phoneNumberId`, `messageType`, `ok`; `messageId` on success. On a Meta failure (`status` 502): `httpStatus` (Graph's; `0` when the request never got an answer), `errorCode`, `errorSubcode`, `errorType` (Meta's `error.code` / `error_subcode` / `type`, null when absent). A request refused before Meta is called has `reason = invalid_target` and the requested `wabaId` |

Meta's error `message` and `error_data` are never logged: they can echo the recipient or content.

### Durable Object `EccosGateway` and `GatewayRPC`

| `event` | `area` | Fields |
|---|---|---|
| `ingested` | `ingest` | `wabaId`, `eventCount`, `inserted` (new rows; the rest were duplicates). Ties a `$workers.durableObjectId` to its WABA |
| `delivered` | `forward` | `wabaId`, `phoneNumberId`, `deliveryId`, `attempt`, `httpStatus`, `durationMs` (subscriber response time), `lagMs` (time since the webhook was stored) |
| `attempt-failed` / `delivery-failed` | `forward` | Same as `delivered`, plus `error`. `delivery-failed` means it exhausted every retry |
| `held_released` | `ingest` | `wabaId`, `released`, `discarded` (events of a phone the active WABA does not register). Runs when provisioning activates the WABA (from `pending`, or from `failed` through a retry or re-check), or on its next webhook if activation raced a hold |
| `held_expired` | `ingest` | `wabaId`, `eventCount`: held events older than 3 days, deleted by the retention sweep. Also raises the "Held webhooks expired" alert |
| `held_release_failed` | `ingest` | `wabaId`, `errorType`: a release failed; the events stay held until the next webhook's ingest retries it, or they expire |
| `outbound_send` | `rpc` | A console send: `source` (`send_test` for a template test, `send_text` for the composer), then the same fields as the worker's `outbound_send` (no `invalid_target`) |
| `rpc_scope` | `rpc` | `accountId`, `wabaId` of a console RPC call (Workers Logs adds the RPC method) |
| `sync-failed`, `item-skipped`, `history-error`, ... | `history` / `retention` / `media` | `wabaId`, `error` |

### Alerts (Telegram HQ, "Eccos ops")

Each alert kind fires at most once per hour per WABA. Occurrences in between are counted and
reported in the next alert.

- **Deliveries are failing:** a delivery exhausted its retries. Matching logs: `delivery-failed`.
- **Inbound messages are being dropped:** an active WABA's messages lack a field the parser needs,
  so Meta changed a shape and that customer's messages are neither stored nor forwarded. Matching
  logs: `webhook_dropped`.
- **Held webhooks expired:** events held for a WABA that never became active (e.g. a provisioning
  that stayed `failed`) were deleted after 3 days, never forwarded. It keeps recurring (at most hourly)
  while a WABA Meta still sends webhooks for stays `failed`. Matching logs: `held_expired`.

## Queries

1. **Traffic per WABA.** Filter `event = webhook_ingested`; group by `wabaId` (and `phoneNumberId`);
   calculate `sum(eventCount)`, or `sum(n_reply)` / `sum(n_status_read)` for one type.
2. **Drops by reason.** Filter `event = webhook_ignored`; group by `reason`, `wabaId`;
   calculate `count`. Add `sum(eventCount)` for the events lost.
3. **Messages lost to parsing.** Filter `event = webhook_dropped`; group by `wabaId`, `missing`,
   `types`; calculate `sum(dropped)`. `keys` tells you what Meta sent instead.
4. **Delivery success rate and latency per WABA.** Filter `area = forward`; group by `wabaId`,
   `event`; calculate `count`, `p95(durationMs)`, `p95(lagMs)`. Success rate is `delivered`
   over all attempts. Group by `httpStatus` to see how a subscriber fails.
5. **Failed sends by Meta error per WABA.** Filter `event = outbound_send` and `ok = false`; group
   by `wabaId`, `errorCode`, `errorSubcode`; calculate `count`. `131047` is a free-form message
   outside the 24-hour window; `httpStatus = 0` is a network failure, with no Meta codes.
6. **What a customer's console did.** Filter `event = rpc_scope` and `accountId = <id>`; group by
   `$workers.event.rpcMethods`.

To follow one webhook end to end, filter on its `correlationId` (the `cf-ray`) for the worker
lines. Then use `wabaId` and `deliveryId` for the Durable Object lines that follow.
