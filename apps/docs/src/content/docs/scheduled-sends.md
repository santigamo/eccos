---
title: Scheduled sends
description: "Schedule one approved WhatsApp template to one recipient at a set time, under your own key. Move it, cancel it, and follow it until it is sent."
---

A **scheduled send** is one approved template to one recipient at a time you choose, under a key
you pick (an appointment id, for example). It is the primitive for reminders: you create it when
the appointment is booked, move or cancel it when the appointment changes, and Eccos sends it on
time.

## Schedule one

`PUT /v1/wabas/{wabaId}/scheduled/{key}`

```json
{
  "phone_number_id": "1098765432",
  "to": "34600000001",
  "template": {
    "name": "appointment_reminder",
    "language": { "code": "es" },
    "components": [{ "type": "body", "parameters": [{ "type": "text", "text": "Ana" }, { "type": "text", "text": "10:30" }] }]
  },
  "sendAt": "2026-11-20T09:00:00+01:00",
  "expiresAt": "2026-11-20T10:00:00+01:00"
}
```

- `key` is 1 to 128 characters: letters, digits and `. _ : -`. It is unique per WhatsApp Business
  Account. The key is the idempotency: repeating a `PUT` never schedules a second send, so there is no
  [Idempotency-Key](/idempotency) header here. While the send is pending, a repeat replaces it
  and starts its attempts and backoff over; once it is being sent, was sent or has an unknown
  outcome, it answers `409`. Use an id from your own system (an appointment id),
  not a phone number or a name: the key shows in the console, its URLs and audit lines.
- `to` is a phone number or a BSUID. `template` is Meta's template object, as in a
  [broadcast](/bulk-sending).
- `sendAt` is absolute: epoch milliseconds, or an ISO 8601 time **with** a timezone (`Z` or an
  offset). A time without one is refused. It can be at most 90 days ahead. A `sendAt` already in
  the past is sent now, as long as it has not expired.
- `expiresAt` is optional and defaults to `sendAt` plus one hour. A send that has not gone out by
  then is not sent at all. It must be after `sendAt`, at most 7 days after it, and in the future.
- `phone_number_id` (or `/v1/wabas/{wabaId}/phones/{phoneNumberId}/scheduled/{key}`) is needed
  only when the account has more than one number.

The response is `{ "ok": true, "scheduled": { ... } }` (see [Follow it](#follow-it)):

| Response | Why |
|---|---|
| `201` | Scheduled. |
| `200` | The key was pending: it was replaced. |
| `400` | A malformed request: the key, a time, the recipient or the template. |
| `404` | The WhatsApp Business Account, or the phone number, is not connected to your account. |
| `409` | `scheduled_send_not_pending` (with `status`): it was, or may have been, sent. Or `too_many_scheduled_sends`. |
| `413` | The request body is over 64 KB. |
| `422` | `template_not_found` or `template_not_approved` (with `templateStatus`) for that name and exact language. |
| `502` | Eccos could not read your templates from Meta. Nothing was scheduled. |

The template must be `APPROVED` in exactly that language when you schedule: there is no
`en` versus `en_US` fallback.

## Move or cancel

- **Move.** `PUT` the same key again. The whole body replaces the previous one: a new `sendAt`,
  new values, even a new recipient.
- **Cancel.** `DELETE /v1/wabas/{wabaId}/scheduled/{key}` cancels a pending send. Deleting one
  already cancelled or failed answers `200` and changes nothing.
- **`409 scheduled_send_not_pending`.** A send that is being sent, was sent, or has an unknown
  outcome cannot be moved or cancelled: it was, or may have been, sent. Use a new key.
- **Start over.** A `PUT` on a key that was cancelled or failed schedules it again from scratch.

## How it is sent

- At `sendAt`, usually within seconds. Scheduled sends go ahead of
  [broadcasts](/bulk-sending) inside the 80% share of your send rate that broadcasts use, so a
  large campaign does not delay a reminder.
- **Throttling.** When Meta says it is busy (HTTP 429, or codes 4, 80007, 130429, 131056), the
  message was not sent: Eccos waits 5 seconds, then 10, 20… up to 5 minutes, and tries again, up
  to 8 attempts or `expiresAt`.
- **Never twice.** When Meta does not answer, or answers with a 5xx, the message may have been
  sent, so Eccos never retries it. It ends `unknown`: check the conversation.
- **A refusal ends only that send.** Any other Meta error, including account-wide ones, ends this
  send as `failed` with Meta's error. Other scheduled sends are not affected.
- **Expiry.** Past `expiresAt` the send ends `failed` with reason `expired`, with no call to Meta.
  If the WhatsApp Business Account is disconnected meanwhile, sends wait and then expire.

## Follow it

`GET /v1/wabas/{wabaId}/scheduled/{key}`

```json
{
  "ok": true,
  "scheduled": {
    "key": "appt-8812", "status": "pending", "phoneNumberId": "1098765432", "to": "34600000001",
    "template": { "name": "appointment_reminder", "language": "es" },
    "sendAt": 1763625600000, "expiresAt": 1763629200000, "attempts": 0,
    "messageId": null, "failureReason": null, "error": null,
    "createdAt": 1762250000000, "updatedAt": 1762250000000
  }
}
```

- `status`: `pending`, `sending`, `sent` (`messageId` is the `transportMessageId` of its
  statuses), `failed`, `unknown` or `cancelled`.
- `failureReason`: `rejected` or `expired` on `failed`, `unknown` on `unknown`; `error` is Meta's
  error when it answered with one. Times are epoch milliseconds. The template values are never
  returned.

`GET /v1/wabas/{wabaId}/scheduled?status=pending&limit=100&after=...` lists your scheduled sends
ordered by key. `status` filters by one status; `limit` is 1 to 1000. When a page is full the
response carries `next`, the last key, which you pass as `after` for the next page. Use it to
reconcile after an outage on your side.

## Events

A scheduled send is a normal send: your webhook receives its `sent`, `delivered`, `read` and
`failed` [status events](/event-reference) with `scheduleKey`, and so does a `reply` or `message`
whose `replyTo` is that message, such as a tap on a button.

When a send will not go out, Eccos emits one
[`scheduled_failed`](/event-reference#scheduled_failed-a-scheduled-send-that-will-not-go-out)
event: `rejected`, `expired` or `unknown`. A send that goes out normally emits no event of its
own, and cancelling emits none.

## Limits

- 50,000 sends pending per WhatsApp Business Account. Beyond it a new key answers `409
  too_many_scheduled_sends`; moving an existing key still works.
- At most 90 days ahead.
- Meta's own [limits](/bulk-sending#metas-limits) apply on top.

## Privacy

The recipient and the template values are message content. The values are deleted from the
schedule as soon as the send is attempted, or when it is cancelled or expires. The log of a send
that was attempted keeps the request, values included, until the [retention window](/data-endpoints)
ends: in `outbound_messages`, and in the conversation (`messages`) once it was sent. A settled send is deleted with the rest of
your content when the [retention window](/data-endpoints) passes; a pending one is kept until it
ends. Erasing a customer deletes their scheduled sends too, pending ones included, which are then
never sent.
