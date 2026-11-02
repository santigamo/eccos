---
title: Idempotency
description: "Use the Idempotency-Key header so retrying a WhatsApp send after a timeout can never deliver the message twice."
---

Add `Idempotency-Key: <string>` to a send so that retrying after a timeout or a dropped
connection cannot send the message twice. The key is 1 to 255 printable ASCII characters with no
spaces (a UUID works); anything else returns `400`.

Keys are remembered for 24 hours and are bound to the exact request: the sending number plus the
JSON body (field order included).

| Situation | Response |
|---|---|
| First use of the key | The send happens; its result is stored under the key. |
| Same key and body, result already stored | The stored result is replayed with its original status (`200`, or the stored `502`). Nothing is sent again. |
| Same key while the first request is still running, or its outcome is unknown | `409`: `"a request with this Idempotency-Key is in progress or its outcome is unknown; check the conversation before sending again"` |
| Same key, different body or number | `422 {"ok":false,"error":"idempotency_key_reused"}` |
| Meta unreachable, timed out, or answered 5xx | `502 {"ok":false,"outcome":"unknown","error":...}`. Meta may have accepted the message. The key stays pending (retries get `409`) until it expires. |
| Meta rejected the message (4xx) | `502 {"ok":false,"error":<Meta error>}`, and this failure is stored: repeating the same key replays it. After fixing the cause, use a new key. |

Recommended: one key per recipient per campaign (for example `spring-2026:{contactId}`), generated
once and reused on every retry of that send. After `outcome: "unknown"`, check whether the
message exists (status events, or the [export](/data-endpoints)) before sending again under a
new key.
