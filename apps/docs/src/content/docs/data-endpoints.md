---
title: Health and data endpoints
description: "The health check, the WABA data export and the per-customer erasure endpoints of the Eccos Cloud API."
---

## Health

`GET /health` needs no authentication and returns `{"ok":true,...}`.

## Data endpoints

```
GET  /v1/wabas/{wabaId}/export
POST /v1/wabas/{wabaId}/privacy/erasure     {"phone": "34600000000"}
```

**Export** returns `{ "ok": true, "data": { ... } }` with everything Eccos still holds for the
WABA, in one unpaginated response: incoming events, sent messages, delivery attempts, conversations and contacts. Message
content is kept for 30 days by default; delivery records are kept longer.

**Erasure** deletes or redacts every stored trace of one customer, named by phone number or BSUID
in the `phone` field of the JSON body (never in the URL). A phone number is matched on its
digits, so formatting does not matter. It is safe to repeat:

```json
{ "ok": true, "phone": "34600000000",
  "counts": { "inboundEventsDeleted": 4, "outboundMessagesDeleted": 2, "deliveriesRedacted": 3,
              "deliveriesDeleted": 0, "messagesDeleted": 6, "contactsDeleted": 1 } }
```

Errors: `400` for a missing or invalid `phone` (at least 5 digits, or a BSUID), `404` for an
unknown WABA, and `503` when the erasure did not finish; repeat the same request.
