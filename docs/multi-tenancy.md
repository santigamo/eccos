# Multi-tenancy (Workers target)

The Workers target is **account-scoped by default**. `ECCOS_MULTI_TENANT` no longer exists: every
deployment uses the control-plane account → WABA → phone registry. A single-account install and a
multi-account install follow the exact same flow — the only difference is how many accounts you
bootstrap.

## Architecture

- `EccosControlPlane` owns accounts, hashed account API keys, WABA ownership, phone ownership,
  Meta access tokens, and short-lived Embedded Signup state.
- `EccosGateway` remains the data-plane owner for one WABA per Durable Object.
- A WABA and a phone number can belong to only one account.
- Public stateful requests authenticate an account API key before resolving a WABA or phone.
- The control plane uses the configured Durable Object jurisdiction so account metadata and
  credentials follow the same residency boundary as WABA data.

## Bootstrap

Configure the admin bootstrap secret, then create the account. Per-WABA credentials (Meta tokens)
and subscriber settings are **runtime/control-plane/WABA state**, not Worker env:

```bash
wrangler secret put ECCOS_ADMIN_API_KEY

curl -X POST https://<gateway>/v1/accounts \
  -H "authorization: Bearer $ECCOS_ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"accountId":"customer-a","name":"Customer A"}'
```

The response contains an account API key once. Store it outside the repository. The bootstrap
key can issue or revoke additional account keys and register an existing WABA.

## Embedded Signup

An account API key is required to create a short-lived browser handoff:

```bash
curl -X POST https://<gateway>/connect/start \
  -H "authorization: Bearer $ECCOS_ACCOUNT_API_KEY"
```

Open the `url` from the response in a browser. The URL carries a one-time state capability;
`GET /connect` sets the CSRF cookie and redirects straight to Meta's dialog — there is no page in
between and nothing to click twice. The callback consumes that state once, so the resulting WABAs
and phones cannot be assigned to another account by changing a callback parameter. Treat the URL
as account-scoped and do not forward it to an operator for a different account. Opening
`GET /connect` with neither a state nor an API key just explains how to mint that link; it is a
signpost, not a step in the flow. Backend integrations may call `POST /connect/exchange` directly
with the same account key.

Every available WABA and phone returned by the Meta token is registered under that account. If
Meta returns a WABA already owned by another account alongside available matches, it is skipped
and reported as a warning without changing the other account's registry. An explicitly selected
foreign WABA still fails closed.

From the console, **Connect WhatsApp** starts the same flow over the RPC binding and additionally
passes the URL to return to. Meta's callback then redirects the operator back into the dashboard
(`/numbers`) instead of leaving them on the gateway's result page. Success carries no parameter —
the connected number is visible in the console's own table; a failure carries a short outcome code
(`connectError`), and WABAs skipped because another account owns them carry `connectSkipped`.

## Registering an existing WABA

An operator onboarding a WABA that already exists (e.g. brought over from a Bun self-host) uses
the admin bootstrap API:

```bash
curl -X POST https://<gateway>/v1/accounts/<accountId>/wabas \
  -H "authorization: Bearer $ECCOS_ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "wabaId": "<WABA_ID>",
    "metaAccessToken": "<permanent system-user token>",
    "phones": [{ "phoneNumberId": "<phone_number_id>", "displayPhoneNumber": "+34 600 00 00 00" }]
  }'
```

The WABA's Durable Object name is derived from the WABA id, so this does not move data: an object
that already holds history keeps it once the account takes ownership. Registration is idempotent,
preserves already-known phone rows, and never changes another account's ownership. As with
Embedded Signup, the token is stored in the control plane and never returned.

## Dashboard scope

A dashboard deployment is account-scoped: one dashboard and one Cloudflare Access application map to
one generated control-plane account. The dashboard derives an installation identity from the Access
team domain and application audience, then creates the account on the protected `/setup` screen.
No account ID is entered or deployed manually. Local development uses a stable local installation
identity. Once the account exists, **Connect WhatsApp** starts the account-bound Embedded Signup
handoff through the private `GatewayRPC`; set the gateway's `GATEWAY_PUBLIC_URL` to the public
gateway origin so the browser can reach its OAuth callback. The browser never receives an account
API key to authorize this flow.

Never change `DO_JURISDICTION` after data exists without a separate Durable Object export and
import plan: a jurisdiction change creates a new, empty object.
