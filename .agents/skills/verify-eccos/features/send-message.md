# Send a message

A server sends a WhatsApp message through `POST /v1/wabas/:wabaId/messages` with an account API key. An operator replies to a customer from the console's Conversations page. Either way Eccos calls Meta's `/<phone number id>/messages` and records the result.

## Sub-features

- `send-api-text` sends a text message over the API and returns Meta's message ID.
- `send-api-refused` returns Meta's error when Meta refuses the recipient.
- `send-api-auth` rejects a missing or wrong key, and a WABA the key's account does not own.
- `send-console-reply` sends a reply from an open conversation.

## How to get to it (user POV)

- Call `POST http://localhost:8787/v1/wabas/100200300/messages` with `authorization: Bearer <api key>`.
- In the console, open `Conversations`, choose a conversation, type in the textbox `Reply`, choose `Send`.

## Driving it with verify-eccos

Preconditions:

- Baseline with an active number.
- An API key in `$KEY`. On the console baseline, create it at `http://localhost:3000/api-keys` (textbox `Label`, button `Create key`), which shows it once. On the API baseline it is the `apiKey` printed when the account was created.
- For `send-console-reply`, the inbound message from [Webhook intake](./webhook-intake.md) `intake-ingest` exists, so the 24-hour window is open.

- **Send text.** Run `curl -s -w ' [%{http_code}]' -X POST http://localhost:8787/v1/wabas/100200300/messages -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"to":"34611111111","type":"text","text":{"body":"hi"}}'`. The output is `{"ok":true,"messages":[{"id":"wamid.FAKE1"}]} [200]`. The number after `FAKE` counts sends since launch.
- **Reached Meta.** Run `$V fake-log /555001/messages`. The newest line has `"path":"/graph/v25.0/555001/messages"` and the body `{"messaging_product":"whatsapp","to":"34611111111","type":"text","text":{"body":"hi"}}`.
- **Refused by Meta.** Repeat the send with `"to":"34600000999"`. The status is `502` and the body is `{"ok":false,"error":{"error":{"message":"Message undeliverable","type":"OAuthException","code":131026,"fbtrace_id":"FAKE"}}}`. The request still reached the fake: `$V fake-log /555001/messages` gains a line with `"status":400`.
- **No key.** Repeat the send without the `authorization` header. The output is `{"ok":false,"error":"unauthorized"} [401]`. Repeat it with `authorization: Bearer ek_wrong` for the same output. `$V fake-log /555001/messages | wc -l` prints the same count before and after both.
- **Foreign WABA.** Send with a valid key to `/v1/wabas/999999/messages`. The output is `{"ok":false,"error":"WABA is not configured"} [404]`.
- **Console reply.** Open `http://localhost:3000/conversations`, choose the link starting `Ana`, fill the textbox `Reply` with `gracias`, choose the button `Send`. The button `Send` is disabled until the textbox has text. The thread gains a message `Sent via Eccos`, `gracias`, `sent`, and `$V fake-log /555001/messages` gains a line whose body has `"to":"34611111111"` and `"body":"gracias"`. After the API send above, the conversation link reads `Ana … You: hi` and the thread already holds `hi`.
- **Logged.** Open `http://localhost:3000/messages`. Each request that reached Meta has a row with its time, recipient, a button reading `#<n> · text` and Meta's answer. The two accepted sends read `sent`. The refused one reads `failed` with `131026 · Recipient cannot receive messages.`. The message text is not in the row, and the unauthorized and foreign-WABA attempts have no row. The counters read `failed 1` and `sent 2`.

## Gotchas

- `Send` stays disabled until the `Reply` textbox has text.
- The reply window counts from the `timestamp` inside the webhook body, not from when it arrives. `$V webhook` replaces `__NOW__` in `fixtures/inbound-text.json` with the current time, so the composer reads `Window open, 23 h left`. A body with a timestamp older than 24 hours leaves the window closed.
- The fake accepts every payload shape. A pass does not prove Meta accepts it. Payload rules live in `packages/core/tests` and `apps/gateway/tests/worker/send-text.spec.ts`.
- Delivery statuses (`sent`, `delivered`, `read`) only appear when a status webhook arrives. Post one with `$V webhook` if the recipe needs it. No fixture ships for it yet.
- Rate limiting is not bound in local dev. `send-rate-limit.test.ts` covers it.
- Idempotent retries (`Idempotency-Key` header), template sends, broadcasts and scheduled sends are not mapped yet. Add a recipe before claiming them.
