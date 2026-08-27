# Multi-tenancy (Workers target)

The Workers target keeps the current single-tenant behavior by default. Set
`ECCOS_MULTI_TENANT=true` only after the control-plane migration and isolation tests have
been completed.

## Architecture

- `EccosControlPlane` owns accounts, hashed account API keys, WABA ownership, phone ownership,
  Meta access tokens, and short-lived Embedded Signup state.
- `EccosGateway` remains the data-plane owner for one WABA per Durable Object.
- A WABA and a phone number can belong to only one account.
- Public stateful requests authenticate an account API key before resolving a WABA or phone.
- The control plane uses the configured Durable Object jurisdiction so account metadata and
  credentials follow the same residency boundary as WABA data.

## Bootstrap

Enable the mode with a non-secret variable and configure the bootstrap secret:

```bash
wrangler secret put ECCOS_ADMIN_API_KEY
```

Set `ECCOS_MULTI_TENANT=true` in the gateway Worker variables, then create an account:

```bash
curl -X POST https://<gateway>/v1/accounts \
  -H "authorization: Bearer $ECCOS_ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"accountId":"customer-a","name":"Customer A"}'
```

The response contains an account API key once. Store it outside the repository. The bootstrap
key can issue or revoke additional account keys and register an existing WABA during migration.

## Embedded Signup

An account API key is required to create a short-lived browser handoff:

```bash
curl -X POST https://<gateway>/connect/start \
  -H "authorization: Bearer $ECCOS_ACCOUNT_API_KEY"
```

Open the `url` from the response in a browser. The URL carries a one-time state capability; the
browser-only `GET /connect` page sets the CSRF cookie before redirecting to Meta. The callback
consumes that state once, so the resulting WABAs and phones cannot be assigned to another account
by changing a callback parameter. Backend integrations may call `POST /connect/exchange` directly
with the same account key.

Every WABA and phone returned by the Meta token is registered under that account. Existing
ownership conflicts fail without changing the other account's registry.

## Migration and rollback

1. Deploy the control-plane migration with `ECCOS_MULTI_TENANT=false`.
2. Set `ECCOS_MULTI_TENANT=true` and configure the admin bootstrap key.
3. Create the account with the admin bootstrap key.
4. Register each existing WABA, all phone numbers, its Meta token, its callback URL, and its
   subscriber target. The registration body accepts `subscriber_webhook_url` and
   `subscriber_secret`; copy the values that were previously supplied by the legacy environment
   into the WABA registration rather than relying on the multi-tenant environment fallback.
5. Verify data-plane counts, subscriber configuration, webhook delivery, templates, and a send
   against the existing WABA Durable Object.
6. Repeat the smoke checks with the account API key.

If registration or the Meta subscription call fails after the registry write, rerun registration
for the same account/WABA and use the dashboard or `resubscribe` action. Re-registration is
idempotent, preserves already-known phone rows, and never changes another account's ownership.

The WABA Durable Object name does not change, so this migration does not move its SQLite data.
The new control plane is additive. To roll back, restore the previous single-tenant variables and
secrets; newly provisioned accounts remain in the registry and are unavailable until multi-tenant
mode is enabled again.

Never change `DO_JURISDICTION` during this process without a separate Durable Object export and
import plan: a jurisdiction change creates a new, empty object.
