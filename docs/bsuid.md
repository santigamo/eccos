# Business-scoped user IDs (BSUIDs)

Meta can name a WhatsApp user by a business-scoped user id (`US.13491208655302741918`;
`US.ENT.…` for a parent BSUID) and withhold the phone number. Source:
[Meta's BSUID guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids).

What Meta allows:

- **Send:** address a BSUID with top-level `recipient` instead of `to`; if both are sent, `to` wins.
  The response's `contacts[0]` carries `user_id` (not `wa_id`) for a BSUID send.
- **Not allowed:** one-tap, zero-tap and copy-code authentication templates need a phone number;
  Meta answers `131062`. Everything else, marketing included, may go to a BSUID.
- **Webhooks:** `messages[].from_user_id`, echoes' `to_user_id`, `contacts[].user_id`,
  `statuses[].recipient_user_id`, and `smb_app_state_sync` contacts' `user_id`. A phone number
  (`from`, `wa_id`, `phone_number`) is only included for 30 days after contact, or while the user is
  in the business's contact book.

## Audit (2026-10-31)

Every place that assumed a customer id is a phone number. **OK** — already handles a BSUID;
**fixed** — changed by the BSUID gateway PRs; **filed** — tracked as a bead.

| Area | Where | Status |
|---|---|---|
| Parser: `from`/`to`, `fromUserId`/`toUserId`, `contacts[].user_id` profile names | `packages/core/src/parser.ts` | OK (PR #30) |
| Parser: `statuses[].recipient_user_id`, parent BSUID fields | `parser.ts` | OK — statuses carry no recipient; parent ids are not forwarded |
| Conversation key `waIdOf` (digits, or BSUID whole) | `apps/gateway/src/conversations.ts` | OK — pattern moved to `@eccos/core/bsuid` |
| Core send: BSUID `to` sent as `recipient`; `user_id` read back | `packages/core/src/send.ts` | fixed |
| RPC sends `TO_PATTERN` (digits only) | `apps/gateway/src/rpc.ts` `sendText`, `sendTemplateTest` | fixed — digits or BSUID |
| Public send route (`to.length >= 5`) | `apps/gateway/src/worker.ts` `tenantSendTarget` | fixed — `to` phone or BSUID, or a BSUID `recipient`, else `400` |
| Erasure: digits-only `normalizePhoneNumber` | `apps/gateway/src/gateway.ts` `eraseByPhone`, erasure route | fixed — BSUID accepted, matches `fromUserId`/`toUserId` |
| History sync: app-state contact with `user_id` only | `apps/gateway/src/history.ts` `mapSyncItem` | fixed |
| History sync: threads/messages keyed by BSUID | `history.ts` `digitsOf` | OK (PR #30) |
| One customer split into a phone and a BSUID conversation | `gateway.ts` store paths | filed — eccos-yx0v (PR #34) |
| Retention sweeps | `gateway.ts` | OK — time-based, id-agnostic |
| Media | `media-store.ts` (`MEDIA_ID` digits) | OK — Meta media ids, not customers |
| Templates (list/create/delete) | `rpc.ts`, `packages/core/src/templates.ts` | OK — no customer id |
| `131062` surfaced as generic `graph` failure | `rpc.ts` error maps | filed — eccos-9dic (contract + console) |
| Ops logs / Sentry / webhook diagnostics | `worker.ts` `logEvent`, `webhook-diagnostics.ts` | OK — ids and field names only, never customer ids |
| Bun target send (`z.string().min(5)`) | `src/routes/messages.ts` | filed — eccos-2xwv; BSUID sends work through core |
| Bun target storage / forwarding | `src/db`, `src/delivery` | OK — stores and forwards events verbatim |
| Console username / BSUID display | `apps/dashboard` | out of scope — eccos-lqmy, dashboard worker |

Counts: 9 OK, 5 fixed, 3 filed (+1 out of scope, already tracked).
