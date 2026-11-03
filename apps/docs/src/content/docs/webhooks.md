---
title: Webhooks
description: "Receive WhatsApp messages and delivery statuses on your own HTTPS webhook: setup, request format, retries and HMAC signature verification."
---

## Setup

Set the **Forwarding URL** and **Signing secret** in the console under **Webhooks**. The URL must
be `https`, without credentials, and not a private or local host. Until a URL is set, events are
queued, not attempted, and go out when you save one; queued events expire with the retention
window (30 days by default). The target is per WABA: each connected WABA has its own URL and
secret.

## The request

Each forward is:

```
POST <your URL>
content-type: application/json
x-eccos-signature: sha256=<hex>
x-webhook-event: <type of the first event in the batch>
x-idempotency-key: <SHA-256 hex of the raw body>

{ "events": [ { ... }, { ... } ] }
```

- The body is a **batch** of one or more events, and batches can arrive out of order. `at` is
  Meta's timestamp (whole seconds, times 1000), so statuses often tie; do not sort by it. Handle
  statuses forward-only: `sent`, then `delivered`, then `read`, ignoring anything older; `failed`
  is final. A status can arrive before the send call has returned its message `id`, so be ready
  to store statuses for ids you do not know yet.
- `x-eccos-signature` is only sent while a signing secret is set. It is `sha256=` followed by the
  lowercase hex **HMAC-SHA256 of the raw request body**, keyed with the signing secret you saved
  in the console (as a UTF-8 string). Verify it against the raw bytes before parsing the JSON.
- `x-idempotency-key` is identical on every retry of the same batch, but it identifies a batch
  only. A new batch can re-include events you already received (Meta repeats events in its
  callbacks), and an erasure rewrites queued batches, which changes their key. Deduplicate per
  event: by `messageId` for incoming messages and echoes, and by `(transportMessageId, type)` for
  statuses.

## Acknowledging and retrying

Answer with any `2xx` within **5 seconds**. Anything else (non-2xx, timeout, connection error)
is retried. **Redirects are not followed**: a `3xx` counts as a failure, so configure the final
URL.

Acknowledge first and do the work afterwards (a queue or a background job): a slow answer
holds up the batches queued behind it.

There are 6 attempts in total. After failed attempt n, the next one waits 5 s x 5^(n-1), capped
at 1 hour, with +/-10% jitter:

| Attempt | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| Runs | when the event arrives | ~5 s later | ~25 s later | ~2 min later | ~10 min later | ~52 min later |

After the 6th failure (about 65 minutes after the first attempt) the batch is marked failed and
is not retried automatically. The console's **Forwarding queue** page (opened from links on the
Webhooks page; it is not in the sidebar) lists each batch with its status and last error, and has
a **Retry** action to send a failed batch again.

## Verifying the signature

Node:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyEccos(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = header.slice("sha256=".length);
  return /^[0-9a-f]{64}$/.test(given) &&
    timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

WebCrypto (Cloudflare Workers, Deno, Bun, browsers):

```ts
export async function verifyEccos(rawBody: string, header: string | null, secret: string): Promise<boolean> {
  const hex = header?.startsWith("sha256=") ? header.slice(7) : "";
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signature = Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(rawBody));
}
```

Pass the body exactly as received (`await request.text()`, or a raw-body capture in Express), not
a re-serialized `JSON.parse` result.
