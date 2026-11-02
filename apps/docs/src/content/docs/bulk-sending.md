---
title: Bulk sending
description: "How to run a WhatsApp campaign through Eccos: one request per recipient, pacing, backoff, retries and Meta limits."
---

There is no bulk endpoint and no server-side send queue. A campaign is one request per
recipient, driven by your code:

1. Send one request per recipient, each with its own [Idempotency-Key](/idempotency).
2. Pace yourself under the rate limit (for example a small worker pool with a token bucket)
   rather than relying on `429`s.
3. On `429`, wait (exponential backoff with jitter) and retry with the **same** key. A `429`
   happens before the send, so nothing was sent.
   Meta's own throughput and pacing errors (for example codes 130429 and 131056) come back as a
   Meta 4xx, which Eccos stores as a final `502` under the key. Retrying with the same key
   replays that failure, so back off and retry these with a **new** key.
4. Record each returned message `id`, then follow `sent` / `delivered` / `read` / `failed` through
   [status events](/event-reference). A `200` only means Meta accepted the message.
5. Skip customers who opted out (see [Opt-out](/event-reference#opt-out)).

Meta applies its own limits on top of Eccos. Eccos neither enforces nor reports them, so read
Meta's documentation:

- Business portfolio messaging limits (how many unique customers you can message per 24 hours,
  by tier) and quality rating: [messaging limits](https://developers.facebook.com/docs/whatsapp/messaging-limits).
- Per-number throughput. Numbers connected with coexistence ("I use this number in the WhatsApp
  Business app") are capped lower than standard numbers: see the throughput section of the
  [Cloud API overview](https://developers.facebook.com/docs/whatsapp/cloud-api/overview).
- Per-user marketing message limits: Meta may refuse a marketing template to a customer who has
  recently received several marketing messages, whoever sent them (the failure arrives as a
  `failed` event or a `502`).
- Template quality, which can lower your limits or pause a template.
