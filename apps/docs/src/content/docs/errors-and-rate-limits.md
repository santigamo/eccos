---
title: Errors and rate limits
description: "Error statuses and bodies returned by the Eccos Cloud API, and the 60 messages per minute per WABA send limit."
---

## Errors

Every error body has `"ok": false` and an `error` field.

| Status | When | `error` |
|---|---|---|
| 400 | Body is not valid JSON | `"invalid body"` |
| 400 | Bad recipient | `"invalid to: expected a phone number (5-15 digits) or a BSUID"` |
| 400 | Several numbers and none chosen | `"phoneNumberId is required when a WABA has more than one phone"` |
| 400 | URL and body name different numbers | `"phone selector mismatch"` |
| 400 | Malformed `Idempotency-Key` | `"Idempotency-Key must be 1-255 printable ASCII characters"` |
| 401 | Missing, unknown or revoked key | `"unauthorized"` |
| 404 | WABA unknown, malformed, not yours, or not active | `"WABA is not configured"` |
| 404 | Number not in this WABA | `"phone number is not registered to this WABA"` |
| 409 | Idempotency key in progress or unknown outcome | see [Idempotency](/idempotency) |
| 422 | Idempotency key reused with a different body | `"idempotency_key_reused"` |
| 429 | Rate limit | `"rate limited"` |
| 502 | Meta did not accept the message | Meta's whole JSON error body under `error`, see below |

A synchronous rejection from Meta (for example an unknown template or a bad parameter) looks like
this; `error` is Meta's body unchanged, hence the doubled `error`
([error codes](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)):

```json
{ "ok": false,
  "error": { "error": { "message": "(#132001) Template name does not exist in the translation",
                        "type": "OAuthException", "code": 132001, "fbtrace_id": "A1b2..." } } }
```

When the outcome is unknown the body also has `"outcome": "unknown"`, and `error` may be Meta's
JSON, a string (network error or timeout), or `null` (a non-JSON 5xx). Unknown also covers a
Meta 2xx that carries no message id.

Eccos does not validate the message itself (template name, parameters, media). Meta does, and
its verdict comes back as a `502`.

## Rate limit

Sending is limited to **60 messages per minute per WABA** by default; higher limits are available
on request. The limit is shared by every number and API key of the WABA and by sends from the
console (the conversation composer and "Send test"). It counts every send that passes
validation, including idempotent replays and sends Meta rejects; requests rejected with
`400` or `404` do not count. It is enforced at Cloudflare's edge, per location, so
it is approximate rather than an exact global counter. Over the limit you get `429`
`{"ok":false,"error":"rate limited"}`. No `Retry-After` header is sent: back off and retry.
