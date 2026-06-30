<div align="center">

![Eccos — self-hostable WhatsApp gateway on the official Meta Cloud API](docs/assets/banner.png)

<h3>Self-hostable, open-source WhatsApp gateway on the official Meta Cloud API</h3>

<p>A <a href="https://kapso.ai">Kapso</a> alternative you run yourself — your app, your token, no message quota.</p>

[![CI](https://github.com/santigamo/eccos/actions/workflows/ci.yml/badge.svg)](https://github.com/santigamo/eccos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-25D366.svg)](./LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-000?logo=bun&logoColor=white)](https://bun.sh)
[![Edge: Cloudflare Workers](https://img.shields.io/badge/edge-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-25D366.svg)](./CONTRIBUTING.md)

</div>

---

Bring your own Meta app + WhatsApp Business Account. Eccos holds the credentials and gives your
apps a small, stable HTTP surface: **send messages**, **receive inbound + delivery statuses**,
and get **normalized events** forwarded to your backend.

> **Status: v0 / thin wrapper.** Single tenant (one WABA / one phone number). The Cloudflare
> Workers target adds an Embedded-Signup `/connect` flow and a read-only dashboard. Multi-tenant
> onboarding is on the [roadmap](#-roadmap).

## ✨ Why Eccos

- 🟢 **Official Cloud API** — built on Meta's WhatsApp Cloud API. No unofficial WhatsApp Web
  automation, so no fragile sessions and no ban risk.
- 🔓 **Self-host & own your token** — MIT-licensed, runs on your box. Eccos keeps your Meta
  credentials; your apps just talk to a small HTTP surface.
- 💸 **No message quota** — pay Meta directly. Service/inbound and in-window utility messages are
  free, and nobody meters or marks up your traffic.
- ⚡ **Two runtimes, one core** — run the **Bun** binary anywhere, or deploy to **Cloudflare
  Workers** for zero-ops and a permanent HTTPS webhook URL (no tunnel needed).
- 🔁 **Reliable forwarding** — inbound messages and statuses are normalized and forwarded to your
  app, HMAC-signed and retried with exponential backoff.
- 🪪 **Onboarding + dashboard** — the Workers target ships an Embedded Signup `/connect` flow and
  a read-only ops `/dashboard`.

## 🆚 How it compares

| | **Eccos** | Cloud-API SaaS<br>(Kapso, 360dialog) | Unofficial<br>(Evolution API, WAHA, wuzapi) |
|---|:---:|:---:|:---:|
| WhatsApp API | ✅ Official Cloud API | ✅ Official Cloud API | ⚠️ Unofficial Web |
| Ban risk | ✅ None | ✅ None | ❌ High |
| Self-hosted | ✅ Yes | ❌ SaaS only | ✅ Yes |
| Open source | ✅ MIT | ❌ Closed | ✅ Varies |
| Message metering | ✅ Pay Meta direct | ❌ Metered / markup | — |
| Cost | ✅ Free | 💰 Paid | ✅ Free |

## 🧩 How it works

```
your app  ──POST /v1/messages──▶  Eccos  ──▶  Meta Cloud API  ──▶  WhatsApp
your app  ◀──forward (HMAC)────   Eccos  ◀──  Meta webhook    ◀──  WhatsApp
```

- **Outbound:** `POST /v1/messages` (Bearer `ECCOS_API_KEY`) → Meta `/{phone}/messages`.
- **Inbound:** Meta calls `POST /webhooks/meta`; Eccos verifies `X-Hub-Signature-256`,
  normalizes the payload, and forwards `{ events: [...] }` to your `SUBSCRIBER_WEBHOOK_URL`,
  signed `X-Eccos-Signature: sha256=<hex>` with `SUBSCRIBER_SECRET`. Failed forwards retry
  with exponential backoff.
- **Templates:** `GET /v1/templates` proxies the WABA's `message_templates`.

Normalized event shape (`WhatsAppCallbackEvent`):

```ts
| { type: "delivered" | "read"; transportMessageId; at }
| { type: "failed"; transportMessageId; at; errorCode?; errorMessage? }
| { type: "reply"; from; messageId; text; at }
| { type: "echo"; to; messageId; text; at }   // staff reply sent from the WhatsApp app (coexistence)
```

### On Cloudflare

The Workers target is just two pieces inside one box: a **Worker** at the edge that speaks HTTP
and talks to Meta, and a single **Durable Object** that remembers everything and does the
retrying. The Worker keeps no state — it hands every message and event to the Durable Object,
which stores them in its built-in **SQLite** and uses an **Alarm** to forward them to your app
(retrying on failure).

```mermaid
flowchart LR
    meta["Meta Cloud API<br/>📱 WhatsApp"]
    app["Your app<br/>(subscriber)"]

    subgraph cf["Cloudflare"]
        direction TB
        worker["Worker — the edge<br/>handles HTTP, checks auth, calls Meta<br/>(keeps no state)"]
        subgraph dobj["Durable Object — the memory (one instance)"]
            direction LR
            sqlite[("SQLite<br/>stores messages<br/>and events")]
            alarm{{"Alarm<br/>forwards to your app,<br/>retries on failure"}}
        end
        worker ==>|"hands off all state"| dobj
    end

    app -->|"send a message"| worker
    meta <-->|"messages and webhooks"| worker
    alarm -->|"forward events"| app

    classDef ext fill:#eef,stroke:#99a,color:#223;
    classDef edge2 fill:#fde2c6,stroke:#f6821f,color:#7a3e0a;
    classDef stateful fill:#f6821f,stroke:#a85a12,color:#fff;
    class meta,app ext;
    class worker edge2;
    class sqlite,alarm stateful;
```

_Orange = the stateful Durable Object primitives (SQLite + Alarm); peach = the stateless Worker._

| Cloudflare primitive | What it is, in Eccos |
|---|---|
| **Worker** (`worker/worker.ts`) | The front door. Stateless HTTP: checks auth, calls the Meta API, hands all work to the Durable Object. Keeps nothing between requests. |
| **Durable Object** — `EccosGateway` (`worker/gateway.ts`) | One global instance that holds all state and coordinates everything (the gateway's single brain). |
| **SQLite storage** _(inside the DO)_ | The database embedded in the Durable Object: inbound events, outbound log, the delivery queue, and onboarding config. |
| **Alarms** _(inside the DO)_ | A timer that wakes the Durable Object to forward events to your app and retry with exponential backoff. |

## 🎯 Deployment targets

Eccos ships **two targets that share one pure core** (`src/core/`: parser, signature, send,
templates). Pick whichever fits how you want to run it:

| | **Bun** (self-host) | **Cloudflare Workers** |
|---|---|---|
| Code | `src/` | `worker/` |
| Storage | SQLite (`bun:sqlite`) | Durable Object (SQLite) |
| Forwarding retries | in-process loop | Durable Object Alarms |
| Deploy | Docker / single process | `wrangler deploy` |
| Embedded Signup `/connect` | — | ✅ |
| Read-only `/dashboard` | — | ✅ |
| Best for | owning the box and the token | zero-ops + a stable HTTPS webhook URL |

The Bun target is the auditable, run-it-anywhere binary. The Workers target trades literal
"your box" for zero-ops and a permanent HTTPS URL (no tunnel needed for Meta webhooks), and
is where the newer v1 features (connect, dashboard) live first.

## 🚀 Quickstart — local (Bun)

```bash
bun install
cp .env.example .env   # fill in META_* + ECCOS_API_KEY + SUBSCRIBER_*
bun run dev            # http://localhost:3000/health
```

To receive webhooks during development, expose the port (e.g. `ngrok http 3000` or
`cloudflared tunnel --url http://localhost:3000`) and set the Meta webhook callback URL to
`https://<public-host>/webhooks/meta` with your `META_WEBHOOK_VERIFY_TOKEN`. Subscribe the
**`messages`** field.

## 🐳 Quickstart — self-host (Docker)

```bash
cp .env.example .env   # fill in values
docker compose up -d
```

SQLite data is persisted in the `eccos-data` volume. The bundled `.dockerignore` keeps your
`.env` and local data out of the image.

## ☁️ Quickstart — Cloudflare Workers

```bash
bun install
bun run cf-types                 # generate worker-configuration.d.ts
# Required secrets:
wrangler secret put META_ACCESS_TOKEN
wrangler secret put META_PHONE_NUMBER_ID
wrangler secret put META_WABA_ID
wrangler secret put META_APP_SECRET
wrangler secret put META_WEBHOOK_VERIFY_TOKEN
wrangler secret put ECCOS_API_KEY
# Optional (event forwarding):
wrangler secret put SUBSCRIBER_SECRET
wrangler secret put SUBSCRIBER_WEBHOOK_URL
# Optional (Embedded Signup /connect flow):
wrangler secret put META_APP_ID
wrangler secret put META_ES_CONFIG_ID

bun run deploy                   # wrangler deploy
```

Non-secret vars (`META_GRAPH_VERSION`, `FORWARD_MAX_ATTEMPTS`) live in `wrangler.jsonc`.
Point Meta's webhook at `https://<worker>.workers.dev/webhooks/meta`. All six required
secrets must be set for the Worker to boot; the `/connect` (Embedded Signup) flow then
updates the effective `META_WABA_ID` / `META_PHONE_NUMBER_ID` at runtime in the Durable
Object.

## 📡 HTTP API

| Method | Path              | Auth                   | Target | Purpose                              |
|--------|-------------------|------------------------|--------|--------------------------------------|
| GET    | `/health`         | none                   | both   | Liveness                             |
| GET    | `/webhooks/meta`  | verify token (query)   | both   | Meta subscription challenge          |
| POST   | `/webhooks/meta`  | `X-Hub-Signature-256`  | both   | Inbound messages + delivery statuses |
| POST   | `/v1/messages`    | Bearer `ECCOS_API_KEY` | both   | Send a message                       |
| GET    | `/v1/templates`   | Bearer `ECCOS_API_KEY` | both   | List message templates              |
| GET    | `/connect`        | Meta OAuth             | Workers| Embedded Signup (coexistence) flow  |
| POST   | `/connect/exchange` | Meta OAuth code      | Workers| Exchange OAuth code → store WABA/phone |
| GET    | `/dashboard`      | basic auth (`eccos` / `ECCOS_API_KEY`) | Workers | Read-only ops dashboard |

### Send example

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "authorization: Bearer $ECCOS_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "to": "34600000000",
    "type": "template",
    "template": {
      "name": "pre_cita",
      "language": { "code": "es" },
      "components": [
        { "type": "body", "parameters": [
          { "type": "text", "parameter_name": "customer_name", "text": "Ana" }
        ] }
      ]
    }
  }'
```

The body is a Meta message object minus `messaging_product` (Eccos injects it). Returns
`{ "ok": true, "messages": [{ "id": "wamid..." }] }`.

## ⚙️ Configuration

See [`.env.example`](./.env.example). Required: `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`,
`META_WABA_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `ECCOS_API_KEY`. Forwarding
(`SUBSCRIBER_WEBHOOK_URL` / `SUBSCRIBER_SECRET`) is optional — without it, inbound events are
still stored, just not pushed. On the Workers target the same names are set with
`wrangler secret`; the Embedded Signup flow additionally uses `META_APP_ID` and
`META_ES_CONFIG_ID`.

## 🛠️ Development

```bash
bun run typecheck      # tsc --noEmit
bun run test           # Bun unit tests (parser, signature, connect, config)
bun run test:workers   # vitest-pool-workers integration tests for the Workers target
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the repository layout and conventions, and
[docs/BRAND.md](./docs/BRAND.md) for the visual identity if you're making assets.

## 🗺️ Roadmap

- [x] Embedded Signup `/connect` (single-tenant coexistence) — Workers target
- [x] Read-only admin dashboard — Workers target
- [ ] Bun-target parity for `/connect` + `/dashboard`
- [ ] Multi-tenant: multiple WABAs/numbers per instance
- [ ] Self-serve onboarding for Tech Providers (connect *clients'* numbers)
- [ ] Postgres storage option (Drizzle)
- [ ] Outbound media + interactive message helpers

## 🤝 Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). For security reports, see
[SECURITY.md](./SECURITY.md). Brand and asset guidelines live in [docs/BRAND.md](./docs/BRAND.md).

## 📄 License

MIT © Santiago García Monsalve
