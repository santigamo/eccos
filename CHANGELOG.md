# Changelog

## Unreleased

### Operator alerts

- The daily Telegram census is gone, and with it the daily token check and expiry warnings.
  Telegram now gets only the dropped-inbound and Graph 190 alerts; one customer's delivery
  problems are in the logs (`docs/observability.md`, Queries).

### Console auth dependency

- `better-auth` 1.7.14 → 1.7.27 (exact pin, `apps/dashboard` and `packages/auth-baseline`). Clears the
  advisory batch fixed in 1.7.16. Two touch features the console uses: organization invitations with
  a padded role name (GHSA-c85h-5mrr-mgx4) and invitations accepted by an unverified account
  (GHSA-fmh4-wcc4-5jm3). **No auth D1 migration is needed**: the shipped
  `apps/dashboard/migrations` already match the 1.7.27 schema.

### Self-hosting the console (action required)

- **`BETTER_AUTH_URL` is now required on a public host.** The console no longer hard-codes
  `app.eccos.chat`: it answers only the host in `BETTER_AUTH_URL` and trusts only that origin.
  Unset, every public request gets `403`. Set it to your console's HTTPS origin **before** deploying
  this version, and drop any local patch to the host allowlist.
- **Deploy the gateway first.** The API-key snippet on the API keys page now shows the gateway's own
  `GATEWAY_PUBLIC_URL` (new `GatewayRPC.getPublicOrigin()`); against an older gateway it shows a
  `<GATEWAY_URL>` placeholder.
- **Deploy the gateway first** for workspace rename too: the console calls the new
  `GatewayRPC.setAccountName()` after renaming a workspace. Against an older gateway the rename
  still succeeds in the console, but the gateway's account name keeps the old value (reported to
  Sentry, not retried), so the Overview's account name drifts.
- **Link previews** (`og:url`, `og:image`) use the host that served the page.

### Production config out of the public templates

- `apps/{gateway,dashboard}/wrangler.jsonc` are now neutral templates with `keep_vars: true`:
  no routes, a placeholder D1 id, and no `GATEWAY_PUBLIC_URL`, Meta identifiers or analytics vars.
  Plain deploys keep the values already set on your Workers.
- `bun run deploy` (root) and `scripts/deploy-dashboard.sh` now read a gitignored
  `wrangler.production.jsonc` in each app and refuse to deploy if it is missing or inconsistent
  (`scripts/check-production-config.ts`). Copy your populated configs there before using them.
- Worker names, Durable Object migrations and jurisdiction are unchanged. See the
  [upgrade note](./docs/deployment.md#upgrade-note--existing-self-hosters).

### Forwarded events

- `reply` and inbound `message` now carry `referral` when the customer wrote from a
  click-to-WhatsApp ad: Meta's `referral` camel-cased, including `ctwaClid` (absent for WhatsApp
  Status ads) and `welcomeMessage`. Additive: events without one are unchanged. Thanks to
  @ericviniciusrota-ui (#97, #108).
- `message_echo` now carries `payload` when a quick-reply or interactive button is tapped in the
  WhatsApp Business app (coexistence). Additive: the field was dropped before.
- `GET /v1/wabas/{wabaId}/templates` now asks Meta for `id`, `name`, `language`, `status`,
  `category` and `components` explicitly, instead of relying on Meta's default fields.

### Business-scoped user IDs (BSUIDs)

Meta now names some WhatsApp users by a business-scoped user id (BSUID, e.g.
`US.13491208655302741918`, or `US.ENT.…` for a parent BSUID) and withholds their phone number.

- **Forwarded events (additive, check your validation):** `reply` / `message` carry `fromUserId`
  and `echo` / `message_echo` carry `toUserId` whenever Meta sends a BSUID. When Meta withholds the
  number, `from` / `to` is the BSUID instead of a phone number. A subscriber that validates
  `from` / `to` as E.164 must accept a BSUID too.
- **Send (Workers):** `POST /v1/wabas/<id>/messages` and the console sends accept `to` as a phone
  number or a BSUID; a BSUID is sent to Meta as `recipient`. The public route also takes Meta's own
  `recipient` (a BSUID) when `to` is absent; if both are sent, `to` wins. Any other recipient is now
  a `400` (previously anything of 5+ characters was passed to Meta). Meta refuses one-tap, zero-tap and
  copy-code authentication templates to a BSUID (error `131062`).
- **Erasure (Workers):** `POST /v1/wabas/<id>/privacy/erasure` accepts a BSUID in `phone`.
- **History sync:** app-state contacts that Meta sends with only a BSUID are now stored.
