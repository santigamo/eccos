# Webhook intake

Meta calls `/webhooks/meta`. Eccos answers Meta's verification challenge, rejects unsigned or malformed calls, stores events for registered numbers, and forwards each event batch, signed, to the workspace's forwarding target.

## Sub-features

- `intake-challenge` answers Meta's subscription challenge only for the right verify token.
- `intake-signature` rejects a body whose `x-hub-signature-256` does not match.
- `intake-ingest` stores an inbound message for an active number.
- `intake-forward` posts the event to the forwarding target with `x-eccos-signature`.
- `intake-unknown` answers 200 and stores nothing for a WABA nobody registered.
- `intake-dedup` stores a repeated Meta delivery once.
- `intake-referral` stores and forwards the click-to-WhatsApp ad `referral` of an inbound message, camel-cased.

## How to get to it (user POV)

- Meta sends `GET /webhooks/meta` once when the callback URL is saved.
- Meta sends `POST /webhooks/meta` for every message and status.
- The operator reads the result on the console's Events page and in their own server's logs.

## Driving it with verify-eccos

Preconditions:

- Baseline with an active number.
- `wamid.VERIFY1` has not been posted on this stack. The `Events` step of [Console onboarding](./console-onboarding.md) posts it. After that step, the `Ingest` command here is already the repeated delivery: keep that step's output as the ingest proof and run this recipe's `Ingest` only as the `Dedup` step.
- For `intake-forward`, a forwarding target is set: `https://subscriber.eccos-verify.example/hook` with secret `verify-subscriber-secret`. Set it on the console's Webhooks page (textbox `Forwarding URL`, textbox `Signing secret`, button `Save`, then the status `Saved. Forwarding target updated.`). On the API baseline it is already set by the registration body.

- **Challenge.** Run `curl -s -w ' [%{http_code}]' "http://localhost:8787/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=abc123"`. The output is `abc123 [200]`. With `hub.verify_token=wrong` it is `Forbidden [403]`.
- **Bad signature.** Run `$V webhook .agents/skills/verify-eccos/fixtures/inbound-text.json --bad-signature`. The output is `{"ok":false,"error":"invalid signature"}` and `HTTP 401`.
- **Invalid JSON.** Run `echo not-json | $V webhook -`. The output is `{"ok":false,"error":"invalid json"}` and `HTTP 400`.
- **Ingest.** Run `$V webhook .agents/skills/verify-eccos/fixtures/inbound-text.json`. The output is `{"ok":true,"received":1}` and `HTTP 200`.
- **Stored.** Open `http://localhost:3000/events`. The counter reads `1 event` and one row shows kind `reply`, party `from +34611111111`, detail `hola`. Without a console user, run `curl -s http://localhost:8787/v1/wabas/100200300/export -H "authorization: Bearer <api key>"` and find `wamid.VERIFY1` under `data.inbound`, which has one entry.
- **Forwarded.** Run `$V fake-log /subscriber/`. One line has `"path":"/subscriber/hook"`, a header `x-eccos-signature` starting `sha256=`, and a body whose `events[0]` has `"type":"reply"`, `"messageId":"wamid.VERIFY1"`, `"text":"hola"`. The Events row's forward state reads `forwarded` (drawn in capitals as `FORWARDED`).
- **Unknown WABA.** Run `$V webhook .agents/skills/verify-eccos/fixtures/unknown-waba.json`. The output is `{"ok":true,"received":0}` and `HTTP 200`. `grep webhook_ignored .verify/run/gateway.log | tail -1` shows `"reason":"unknown_waba"`.
- **Dedup.** Run the ingest command a second time. The Events page still reads `1 event`, `$V fake-log /subscriber/ | grep -c wamid.VERIFY1` still prints `1`, and `/export` still has one entry under `data.inbound` and one under `data.deliveries`.
- **Ad referral.** Run `$V webhook .agents/skills/verify-eccos/fixtures/inbound-ad-referral.json`, Meta's documented click-to-WhatsApp example. The output is `{"ok":true,"received":1}` and `HTTP 200`. `$V fake-log wamid.VERIFYAD1` shows one `/subscriber/hook` line whose `events[0]` has `"type":"reply"` and a `referral` with `"sourceType":"ad"`, `"sourceId":"120226305854810726"`, a `ctwaClid` starting `Aff-n8ZT` and `"welcomeMessage":{"text":"Hi there! Let us know how we can help!"}`. In `/export`, the `data.inbound` entry for `wamid.VERIFYAD1` carries the same `referral`. The `wamid.VERIFY1` event from `Ingest` has no `referral` key, in the forward and in `/export`.

## Gotchas

- The HTTP response to a repeated delivery still says `"received":1`. Prove dedup by the stored and forwarded counts, not by the response.
- Forwarding only accepts public `https` targets. The reserved host `subscriber.eccos-verify.example` is the only one the harness reroutes to the fake. Any other host goes to the real internet.
- Forwarding runs on a Durable Object alarm, a moment after the 200. Wait for the fake-log line before failing the step.
- Events for a WABA whose provisioning is `pending` or `failed` are held, not ingested. The fake always lets provisioning succeed, so the held path is not reachable here. Use `apps/gateway/tests/worker/held-webhooks.spec.ts` and report it as a test.
- A failed store answers 5xx so Meta retries. The harness cannot force a storage failure. `sync-capture.spec.ts` covers it.
