# Eccos Cloud API guide

Integration guide for Eccos Cloud: send WhatsApp messages over HTTP and receive incoming
messages and delivery statuses on your own webhook. Eccos is a thin layer over the official
Meta WhatsApp Cloud API, so message bodies are Meta's own format
([message reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages)).

- API base URL: `https://api.eccos.chat`
- Console: `https://app.eccos.chat`

## 1. Getting started

1. Sign up at `app.eccos.chat`.
2. **Numbers**: connect a WhatsApp number with Meta Embedded Signup. Choose **"I use this number
   in the WhatsApp Business app"** to keep using the app on your phone alongside the API
   (coexistence), or **"A new number, or one not on WhatsApp"**. The second option takes a number
   that is on WhatsApp today off the app. The Numbers page then lists each number with its
   **Phone number ID** and **WABA** (WhatsApp Business Account) id. You need the WABA id in every
   API call.
3. **Settings**, **API keys**: enter a label and press **Create key**. The key (prefix `ek_`) is
   shown once; store it. You can revoke it from the same list.
4. **Webhooks**, **Forwarding target**: set the **Forwarding URL** (HTTPS) and a **Signing secret**
   (type one or press **Generate**), then **Save**. The secret is write-only: the console never
   shows it again, so keep your own copy. See [Webhooks](#9-webhooks).

## 2. Authentication

Send the account API key on every `/v1/*` request, either way:

```
Authorization: Bearer ek_...
X-API-Key: ek_...
```

If both are present, `Authorization: Bearer` is used (the word `Bearer` is case-sensitive). A missing, unknown or revoked key returns:

```
401 {"ok":false,"error":"unauthorized"}
```

A key belongs to your account and works for every WABA of that account. A WABA that is not yours
looks the same as one that does not exist (404).

## 3. Send a message

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
incoming [`reply` event](#10-event-reference) when the customer taps the button.

**Media.** Eccos has no media upload endpoint, and Eccos holds the Meta credentials, so you cannot
upload to Meta yourself. Send media by a public HTTPS `link` (as in the header above, or
`{"type":"image","image":{"link":"https://..."}}`); Meta must be able to fetch it without
authentication. Incoming media is the reverse gap: only the Meta media id is forwarded, and
the API cannot return the file (see [`message` events](#10-event-reference)).

## 4. Idempotency

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
message exists (status events, or the [export](#12-data-endpoints)) before sending again under a
new key.

## 5. Errors

Every error body has `"ok": false` and an `error` field.

| Status | When | `error` |
|---|---|---|
| 400 | Body is not valid JSON | `"invalid body"` |
| 400 | Bad recipient | `"invalid to: expected a phone number (5-15 digits) or a BSUID"` |
| 400 | Several numbers and none chosen | `"phoneNumberId is required when a WABA has more than one phone"` |
| 400 | URL and body name different numbers | `"phone selector mismatch"` |
| 400 | Malformed `Idempotency-Key` | `"Idempotency-Key must be 1-255 printable ASCII characters"` |
| 401 | Missing, unknown or revoked key | `"unauthorized"` |
| 404 | WABA unknown, not yours, or not active | `"WABA is not configured"` |
| 500 | Malformed WABA id in the URL | `"internal error"` |
| 404 | Number not in this WABA | `"phone number is not registered to this WABA"` |
| 409 | Idempotency key in progress or unknown outcome | see [Idempotency](#4-idempotency) |
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

## 6. Rate limit

Sending is limited to **60 messages per minute per WABA** by default; higher limits are available
on request. The limit is shared by every number and API key of the WABA and by sends from the
console (the conversation composer and "Send test"), and counts every `POST` to a messages
endpoint, including rejected ones. It is enforced at Cloudflare's edge, per location, so
it is approximate rather than an exact global counter. Over the limit you get `429`
`{"ok":false,"error":"rate limited"}`. No `Retry-After` header is sent: back off and retry.

## 7. Bulk sending

There is no bulk endpoint and no server-side send queue. A campaign is one request per
recipient, driven by your code:

1. Send one request per recipient, each with its own [Idempotency-Key](#4-idempotency).
2. Pace yourself under the rate limit (for example a small worker pool with a token bucket)
   rather than relying on `429`s.
3. On `429`, wait (exponential backoff with jitter) and retry with the **same** key. A `429`
   happens before the send, so nothing was sent.
   Meta's own throughput and pacing errors (for example codes 130429 and 131056) come back as a
   Meta 4xx, which Eccos stores as a final `502` under the key. Retrying with the same key
   replays that failure, so back off and retry these with a **new** key.
4. Record each returned message `id`, then follow `sent` / `delivered` / `read` / `failed` through
   [status events](#10-event-reference). A `200` only means Meta accepted the message.
5. Skip customers who opted out (see [Opt-out](#opt-out)).

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

## 8. Templates

```
GET /v1/wabas/{wabaId}/templates?limit=100
```

Returns Meta's `message_templates` response for the WABA unchanged (`{ "data": [...], "paging": ... }`).
Each template has `name`, `language`, `status` (only `APPROVED` ones can be sent), `category` and
`components`. `limit` is clamped to 1 to 1000 (default 100). The endpoint does not follow Meta's
paging cursor, so you get at most `limit` templates. If Meta fails, the answer is
`502 {"ok":false,"error":...}`.

The console can create text templates (body, optional footer, URL buttons). A template with an
image header or quick-reply buttons, like the example above, has to be created in Meta's
WhatsApp Manager and approved by Meta before you can send it.

## 9. Webhooks

### Setup

Set the **Forwarding URL** and **Signing secret** in the console under **Webhooks**. The URL must
be `https`, without credentials, and not a private or local host. Until a URL is set, events are
queued, not attempted, and go out when you save one; queued events expire with the retention
window (30 days by default). The target is per WABA: each connected WABA has its own URL and
secret.

### The request

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

### Acknowledging and retrying

Answer with any `2xx` within **5 seconds**. Anything else (non-2xx, timeout, connection error)
is retried. **Redirects are not followed**: a `3xx` counts as a failure, so configure the final
URL.

There are 6 attempts in total. After failed attempt n, the next one waits 5 s x 5^(n-1), capped
at 1 hour, with +/-10% jitter:

| Attempt | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| Runs | when the event arrives | ~5 s later | ~25 s later | ~2 min later | ~10 min later | ~52 min later |

After the 6th failure (about 65 minutes after the first attempt) the batch is marked failed and
is not retried automatically. The console's **Forwarding queue** page (opened from links on the
Webhooks page; it is not in the sidebar) lists each batch with its status and last error, and has
a **Retry** action to send a failed batch again.

### Verifying the signature

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

## 10. Event reference

Each element of `events` has a `type`. Common fields: `at` (ms since epoch) and, when known,
`phoneNumberId` (the number the event belongs to). Absent values are omitted, never `null`.

### Statuses of messages you sent

`type` is `sent`, `delivered`, `read` or `failed`. `transportMessageId` is the `id` returned by
the send call. Status events do not name the recipient, so match on that id. Meta's `played`
status (voice messages) arrives as `read`.

```json
{ "type": "delivered", "transportMessageId": "wamid.HBgL...", "at": 1767225600000, "phoneNumberId": "1098765432" }
```

```json
{ "type": "failed", "transportMessageId": "wamid.HBgL...", "at": 1767225600000,
  "errorCode": "131026", "errorMessage": "Message undeliverable", "phoneNumberId": "1098765432" }
```

`errorCode` and `errorMessage` come from Meta's first error; `errorMessage` prefers
`error_data.details` over `message` ([error codes](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)).

### `reply`: incoming text, button taps and list choices

Plain text messages, template quick-reply taps, and interactive button or list replies all arrive
as `reply`. `text` is the message text, or the button or list-row title. `payload` is present
only for button and list replies: the quick-reply `payload` you set on the template, or the `id`
of the interactive button or list row.

```json
{ "type": "reply", "from": "34600000000", "messageId": "wamid.HBgM...", "text": "Yes, count me in",
  "payload": "optin_yes", "profileName": "Ana", "at": 1767225600000, "phoneNumberId": "1098765432" }
```

`from` is the customer's phone number, or their BSUID when Meta withholds the number; `fromUserId`
carries the BSUID whenever Meta sends one. `profileName` is the WhatsApp profile name, if any.

### `message`: any other incoming content

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

### `echo` and `message_echo`: messages sent from the WhatsApp Business app

For numbers connected with coexistence, messages you send from the phone app are forwarded too.
They mirror `reply` and `message` but name the recipient with `to` (and `toUserId` for a BSUID)
instead of `from`. Text is `echo`; anything else is `message_echo`, with the same content fields
as `message`.

```json
{ "type": "echo", "to": "34600000000", "messageId": "wamid.HBgM...", "text": "Thanks!", "at": 1767225600000, "phoneNumberId": "1098765432" }
```

### Opt-out

Eccos does not interpret or act on opt-outs. A customer who writes STOP produces an ordinary
`reply` (or a `reply` with your quick-reply button's `payload`, if you offer an opt-out button).
Recording the opt-out and not messaging that customer again is your responsibility.

## 11. Health

`GET /health` needs no authentication and returns `{"ok":true,...}`.

## 12. Data endpoints

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
