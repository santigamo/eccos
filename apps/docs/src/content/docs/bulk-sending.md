---
title: Bulk sending
description: "Send one approved WhatsApp template to up to 10,000 recipients in one request. Eccos paces the sends, retries throttling and reports progress."
---

A **broadcast** sends one approved template to many recipients. You make one request; Eccos
sends at your account's rate, retries when Meta asks it to slow down, and reports the progress
of every recipient.

## Create a broadcast

`POST /v1/wabas/{wabaId}/broadcasts`

```json
{
  "phone_number_id": "1098765432",
  "template": {
    "name": "ramadan_appeal",
    "language": { "code": "en_US" },
    "components": [{ "type": "body", "parameters": [{ "type": "text", "text": "friend" }] }]
  },
  "recipients": [
    { "to": "34600000001", "components": [{ "type": "body", "parameters": [{ "type": "text", "text": "Ana" }] }] },
    { "to": "34600000002" }
  ]
}
```

- `template` is Meta's template object: `name`, `language` (`{ "code": "es" }` or `"es"`) and,
  optionally, `components` used for every recipient that does not bring its own.
- `recipients` holds 1 to 10,000 entries. `to` is a phone number or a BSUID. A recipient's
  `components` replace the template's: it is where each person's values go, in the same shape
  as a [single template send](/sending-messages).
- `phone_number_id` (or `/v1/wabas/{wabaId}/phones/{phoneNumberId}/broadcasts`) is needed only
  when the WhatsApp Business Account has more than one number.
- Send an [Idempotency-Key](/idempotency) header: retrying with the same key returns the same
  broadcast instead of creating a second one, for as long as the broadcast is kept. Reusing it
  with a different set of recipients or values returns `422`. A broadcast's key is separate from
  single-send keys and is not limited to 24 hours.

Eccos checks the request before queueing anything:

| Response | Why |
|---|---|
| `202` | Queued. The body is the broadcast (below). |
| `400` | A malformed request. When recipients are invalid, `invalid` lists them (`index`, `error`, up to 100) and nothing is queued. |
| `404` | The WhatsApp Business Account, or the phone number, is not connected to your account. |
| `409` | Five broadcasts are already running on this WhatsApp Business Account. Wait for one to finish or cancel one. |
| `413` | The request body is over 8 MB. Split the recipients into several broadcasts. |
| `422` | `template_not_found` or `template_not_approved` (with `templateStatus`) for that name and language, or `idempotency_key_reused`. |
| `502` | Eccos could not read your templates from Meta. Nothing was queued. |

A recipient that appears twice, however it is written (`+34 600 000 001` and `34600000001`), is
sent once; `duplicatesSkipped` counts the extra entries.

## How it is sent

- **Pace.** A broadcast uses 80% of the send rate of your WhatsApp Business Account (60
  messages a minute by default, so 48), leaving the rest for your
  [single sends](/errors-and-rate-limits) such as verification codes and replies. Both draw
  from the same budget, which is approximate rather than an exact quota.
- **Throttling.** When Meta answers that it is busy (HTTP 429, or codes 4, 80007, 130429,
  131056), the message was not sent: Eccos queues it again and waits 5 seconds, then 10, 20… up
  to 5 minutes. After 8 throttled attempts the recipient is marked `failed`.
- **Never twice.** When Meta does not answer, or answers with a 5xx, the message may have been
  sent, so Eccos never retries it. The recipient ends as `unknown`: check the conversation.
- **Errors for everyone stop it.** An invalid token, a locked, blocked or unpaid account or
  number, or a template that no longer exists or is paused (codes 10, 190, 200, 368, 131031,
  131042, 131045, 131048, 132001, 132007, 132015, 132016, 133010) would fail every remaining
  recipient. The broadcast stops as `halted`, with the reason in `haltReason`, and the
  recipients not yet attempted are `cancelled`. It also stops if its first 20 sends all fail.
- **Parameter errors** (codes 132000, 132005, 132012) fail only that recipient when it brought
  its own `components`; when it used the template's, every recipient would fail, so the
  broadcast stops.
- **Any other Meta error** fails that recipient only, with Meta's error stored on it.

Every message is a normal send: it appears in your logs and conversations, and your webhook
receives its `sent`, `delivered`, `read` and `failed` [status events](/event-reference). Use a
recipient's `messageId` to match them.

## Follow it

`GET /v1/wabas/{wabaId}/broadcasts/{broadcastId}`

```json
{
  "ok": true,
  "broadcast": {
    "id": "bc_6f1c0e1b0a3d4c51a7a39c8d8b0e2f44",
    "status": "running",
    "phoneNumberId": "1098765432",
    "template": { "name": "ramadan_appeal", "language": "en_US" },
    "total": 5000,
    "duplicatesSkipped": 3,
    "ratePerMinute": 600,
    "counts": { "queued": 3800, "sending": 10, "sent": 1170, "failed": 20, "unknown": 0, "cancelled": 0 },
    "delivery": { "delivered": 1102, "read": 640, "failed": 4 },
    "haltReason": null,
    "createdAt": 1767225600000,
    "finishedAt": null
  }
}
```

- `status`: `running`, `completed` (every recipient settled), `cancelled` or `halted`.
- `counts` is where each recipient stands on the send to Meta. `delivery` counts the receipts
  Meta has sent back for the messages that went out, so it keeps growing after the broadcast
  completes.

`GET /v1/wabas/{wabaId}/broadcasts/{broadcastId}/recipients?status=failed&limit=500&after=...`
lists recipients in order with `seq`, `to`, `status`, `messageId`, `attempts` and Meta's `error`.
`status` filters by one status; when a page is full the response carries `next`, which you pass
as `after` for the next page.

`GET /v1/wabas/{wabaId}/broadcasts?limit=20` lists your latest broadcasts.

## Cancel it

`POST /v1/wabas/{wabaId}/broadcasts/{broadcastId}/cancel` stops a running broadcast: recipients
not yet attempted become `cancelled`; messages already sent are not recalled.

## Privacy

Recipients and their values are message content. The broadcast's own copy of the values is
deleted as soon as each message is attempted; the message itself is kept in your message log
like any other send. Both, and the broadcast's recipients, are deleted with the rest of your
content when the [retention window](/data-endpoints) passes. Erasing a customer removes them
from your broadcasts too.

## Meta's limits

Meta applies its own limits on top of Eccos. Eccos neither enforces nor reports them:

- Business portfolio messaging limits (how many unique customers you can message per 24 hours,
  by tier) and quality rating: [messaging limits](https://developers.facebook.com/docs/whatsapp/messaging-limits).
- Per-number throughput. Numbers connected with coexistence ("I use this number in the WhatsApp
  Business app") are capped at 20 messages per second.
- Per-user marketing message limits: Meta may refuse a marketing template to a customer who has
  recently received several marketing messages, whoever sent them.
- Template quality, which can lower your limits or pause a template.

Skip customers who opted out (see [Opt-out](/event-reference#opt-out)).
