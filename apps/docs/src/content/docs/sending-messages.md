---
title: Sending messages
description: "Send text, template and media WhatsApp messages with POST /v1/wabas/{wabaId}/messages, and list approved templates."
---

```
POST /v1/wabas/{wabaId}/messages
POST /v1/wabas/{wabaId}/phones/{phoneNumberId}/messages
```

The body is a Meta Cloud API message object, passed through unchanged except that Eccos adds
`"messaging_product": "whatsapp"`. Send `Content-Type: application/json`.

- **Recipient**: `to` is a phone number (5 to 15 digits; a leading `+` and, inside the number, spaces,
  dots, dashes and parentheses are accepted; a leading `(` is rejected) or a business-scoped user id (BSUID, like `US.13491208655302741918`).
  A BSUID can also be given as `recipient` when `to` is absent. Eccos sends BSUIDs to Meta in the
  `recipient` field.
- **Which number sends**: if the WABA has exactly one number, nothing else is needed. With several
  numbers you must choose one, either in the URL (second form) or with `"phone_number_id"` in the
  body (Eccos removes this field before calling Meta). If both are given they must match. A
  number that is not registered to the WABA returns 404.

Success:

```json
{ "ok": true, "messages": [{ "id": "wamid.HBgL..." }] }
```

Keep the `id`: it is the `transportMessageId` of the status events you will receive.

Text (Meta only delivers free-form messages inside the 24-hour window after the customer last
wrote to you; outside it, use a template):

```bash
curl -X POST https://api.eccos.chat/v1/wabas/$WABA_ID/messages \
  -H "Authorization: Bearer $ECCOS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"to":"34600000000","type":"text","text":{"body":"Hello"}}'
```

Approved template with an image header, body parameters and buttons (Meta's
[template message format](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates)):

```json
{
  "to": "34600000000",
  "type": "template",
  "template": {
    "name": "spring_campaign",
    "language": { "code": "es" },
    "components": [
      { "type": "header",
        "parameters": [{ "type": "image", "image": { "link": "https://example.org/banner.jpg" } }] },
      { "type": "body",
        "parameters": [
          { "type": "text", "text": "Ana" },
          { "type": "text", "text": "12 May" }
        ] },
      { "type": "button", "sub_type": "quick_reply", "index": "0",
        "parameters": [{ "type": "payload", "payload": "optin_yes" }] },
      { "type": "button", "sub_type": "url", "index": "1",
        "parameters": [{ "type": "text", "text": "ana-123" }] }
    ]
  }
}
```

Body parameters are positional (`{{1}}`, `{{2}}`) unless the template uses named parameters; for
those, add `"parameter_name"` to each parameter. A quick-reply `payload` comes back in the
incoming [`reply` event](/event-reference) when the customer taps the button, with `replyTo`
set to the template's message id.

**Media.** Eccos has no media upload endpoint, and if you connected through Embedded Signup,
Eccos holds the Meta credentials, so you cannot upload to Meta yourself. Send media by a public HTTPS `link` (as in the header above, or
`{"type":"image","image":{"link":"https://..."}}`); Meta must be able to fetch it without
authentication. Incoming media is the reverse gap: only the Meta media id is forwarded, and
the API cannot return the file (see [`message` events](/event-reference)).

## Templates

```
GET /v1/wabas/{wabaId}/templates?limit=100
```

Returns Meta's `message_templates` response for the WABA unchanged (`{ "data": [...], "paging": ... }`).
Each template has `id`, `name`, `language`, `status` (only `APPROVED` ones can be sent), `category`,
`components` and `parameter_format`, plus `sub_category`, `previous_category`, `rejected_reason`,
`quality_score` and `last_updated_time` when Meta has them. `limit` is clamped to 1 to 1000 (default 100). The endpoint does not follow Meta's
paging cursor, so you get at most `limit` templates. If Meta fails, the answer is
`502 {"ok":false,"error":...}`.

The console can create text templates (body, optional footer, URL buttons). A template with an
image header or quick-reply buttons, like the example above, has to be created in Meta's
WhatsApp Manager and approved by Meta before you can send it.
