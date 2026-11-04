---
title: Event reference
description: "Reference for every webhook event Eccos forwards: statuses, reply, message, echo and message_echo, with example payloads."
---

Each element of `events` has a `type`. Common fields: `at` (ms since epoch) and, when known,
`phoneNumberId` (the number the event belongs to). Absent values are omitted, never `null`.

## Statuses of messages you sent

`type` is `sent`, `delivered`, `read` or `failed`. `transportMessageId` is the `id` returned by
the send call. Status events do not name the recipient, so match on that id. Meta's `played`
status (voice messages) arrives as `read`.

With coexistence you also get statuses for messages sent from the WhatsApp Business app: their
`transportMessageId` is the `messageId` of the matching [`echo`](#echo-and-message_echo-messages-sent-from-the-whatsapp-business-app)
event, not an id the send call returned. Ignore ids you don't know if you only track API sends.

```json
{ "type": "delivered", "transportMessageId": "wamid.HBgL...", "at": 1767225600000, "phoneNumberId": "1098765432" }
```

```json
{ "type": "failed", "transportMessageId": "wamid.HBgL...", "at": 1767225600000,
  "errorCode": "131026", "errorMessage": "Message undeliverable", "phoneNumberId": "1098765432" }
```

`errorCode` and `errorMessage` come from Meta's first error; `errorMessage` prefers
`error_data.details` over `message` ([error codes](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)).

## `reply`: incoming text, button taps and list choices

Plain text messages, template quick-reply taps, and interactive button or list replies all arrive
as `reply`. `text` is the message text, or the button or list-row title. `payload` is present
only for button and list replies: the quick-reply `payload` you set on the template, or the `id`
of the interactive button or list row.

```json
{ "type": "reply", "from": "34600000000", "messageId": "wamid.HBgM...", "text": "Yes, count me in",
  "payload": "optin_yes", "replyTo": "wamid.HBgL...", "profileName": "Ana", "at": 1767225600000, "phoneNumberId": "1098765432" }
```

`from` is the customer's phone number, or their BSUID when Meta withholds the number; `fromUserId`
carries the BSUID whenever Meta sends one. `profileName` is the WhatsApp profile name, if any.

`replyTo` is the id of the message the customer replied to: the template or interactive
message whose button they tapped, or the message they quoted. It is absent otherwise.

## `message`: any other incoming content

Everything that is not text or a button/list reply. `messageType` is Meta's message type; the
extra fields depend on it. Unknown future types are forwarded with `messageType` only.

| `messageType` | Extra fields |
|---|---|
| `image`, `video`, `audio`, `document`, `sticker` | `media: { id, mimeType?, sha256?, caption?, filename? }` |
| `location` | `location: { latitude, longitude, name?, address?, url? }` |
| `contacts` | `contacts`: Meta's contacts array, unchanged |
| `reaction` | `reaction: { messageId, emoji? }` (`emoji` is absent when the reaction is removed) |
| `interactive` (not a button/list reply, for example a Flow response) | `interactive: { type, body?, responseJson? }` |
| `order`, `system` | `order` / `system`: Meta's object unchanged; `system` also sets `text` |
| `edit` | the edited content's fields, plus `originalMessageId` |
| `revoke` | `originalMessageId` |
| `unsupported` and others | `errorCode?`, `errorMessage?` when Meta sends them |

```json
{ "type": "message", "from": "34600000000", "messageId": "wamid.HBgM...", "messageType": "image",
  "media": { "id": "1234567890", "mimeType": "image/jpeg", "sha256": "ab12...", "caption": "My receipt" },
  "profileName": "Ana", "at": 1767225600000, "phoneNumberId": "1098765432" }
```

`media.id` is a Meta media id. Eccos does not forward the file, and the API has no endpoint to
download it.

`message` carries `replyTo` too when the customer quoted a message (for example an image
sent as a reply) or answered a Flow.

## `echo` and `message_echo`: messages sent from the WhatsApp Business app

For numbers connected with coexistence, messages you send from the phone app are forwarded too.
They mirror `reply` and `message` but name the recipient with `to` (and `toUserId` for a BSUID)
instead of `from`. Text is `echo`; anything else is `message_echo`, with the same content fields
as `message`.

```json
{ "type": "echo", "to": "34600000000", "messageId": "wamid.HBgM...", "text": "Thanks!", "at": 1767225600000, "phoneNumberId": "1098765432" }
```

## Opt-out

Eccos does not interpret or act on opt-outs. A customer who writes STOP produces an ordinary
`reply` (or a `reply` with your quick-reply button's `payload`, if you offer an opt-out button).
Recording the opt-out and not messaging that customer again is your responsibility.
