# Connect and provisioning

A workspace gets a WhatsApp number by connecting it. Eccos checks the Meta token, finds the WABA and its numbers, subscribes the app to the WABA's webhooks, and marks the number `active`. Until then the number is `pending`, or `failed` with a reason.

## Sub-features

- `connect-attach-token` attaches a number from the console by pasting a Meta token.
- `provision-admin` registers a WABA through the self-host admin routes.
- `provision-active` ends with the number `active` after Meta confirms the webhook subscription.
- `provision-admin-auth` rejects admin routes without the admin key.

## How to get to it (user POV)

- In the console, open `http://localhost:3000/numbers/attach-token`.
- In the console, choose `Connect WhatsApp` on `Numbers`, which opens Meta's Embedded Signup. Not drivable here. See Gotchas.
- A self-hoster calls `POST /v1/accounts`, then `POST /v1/accounts/:accountId/wabas`, with the admin key.

## Driving it with verify-eccos

Preconditions:

- A fresh launch. WABA `100200300` can belong to one account only, so run the console path or the admin path, not both.
- For `connect-attach-token`, a signed-in console user with a workspace. See [Console onboarding](./console-onboarding.md).

- **Attach by token.** Open `http://localhost:3000/numbers/attach-token`, fill the textbox `Meta access token` with `EAAverifyFakeToken0000000000`, choose the button `Attach number`. Attaching needs a fresh step-up. A user without TOTP first gets the dialog `Set up two-factor authentication`, and a user whose step-up is older than 15 minutes gets `Confirm it's you`. Follow `stepup-console-setup` or `stepup-console-confirm` in [Step-up](./step-up.md). The attach then continues by itself: the page moves to `/numbers` and the table has a row with `+34 600 000 001`, `555001`, `100200300` and status `active`.
- **Asked Meta.** Run `$V fake-log /graph/`. In order: `GET /graph/v25.0/debug_token`, `GET /graph/v25.0/100200300/phone_numbers`, `POST /graph/v25.0/100200300/subscribed_apps` with a body carrying `override_callback_uri=https%3A%2F%2Fgateway.eccos-verify.example%2Fwebhooks%2Fmeta`.
- **Admin: account.** Run `$V admin POST /v1/accounts '{"accountId":"acme"}'`. The status is `HTTP 201` and the body has `apiKey`, shown once.
- **Admin: register.** Run `$V admin POST /v1/accounts/acme/wabas '{"wabaId":"100200300","metaAccessToken":"fake-token","callbackUrl":"https://gateway.eccos-verify.example/webhooks/meta","phones":[{"phoneNumberId":"555001","displayPhoneNumber":"+34600000001"}],"subscriber_webhook_url":"https://subscriber.eccos-verify.example/hook","subscriber_secret":"verify-subscriber-secret"}'`. The status is `HTTP 202` and `waba.status` is `pending`.
- **Admin: active.** Run `$V admin POST /v1/accounts/acme/wabas/100200300/reconcile`. The status is `HTTP 200` and `waba.status` is `active`.
- **Admin auth.** Run `curl -s -w ' [%{http_code}]' -X POST http://localhost:8787/v1/accounts -H 'content-type: application/json' -d '{"accountId":"x"}'`. The output is `{"ok":false,"error":"unauthorized"} [401]`.

## Gotchas

- Embedded Signup opens Meta's own dialog on facebook.com and returns the browser to `GATEWAY_PUBLIC_URL`. Neither exists locally, so the OAuth start, return and exchange are not provable with this skill. `apps/gateway/tests/worker/connect.spec.ts`, `connect-return.spec.ts` and `connect-provisioning.spec.ts` cover them as tests.
- The stack sets `GATEWAY_PUBLIC_URL` to `https://gateway.eccos-verify.example`. With an `http` value, attaching fails with `invalid callbackUrl: must use https`.
- The console refuses a token shorter than a real one with the alert `that does not look like a Meta access token`, before it asks for step-up. The fake accepts any token that gets past that, and always confirms the subscription. The `failed` state, an expired token and a refused subscription are not reachable. `provisioning.spec.ts` and `token-connect.spec.ts` cover them.
- The admin register route answers `400 invalid callbackUrl: must use https` when the body has no `callbackUrl`, because it defaults to the request's own `http://localhost` origin.
- Connection links (`Copy connection link`) and the public `/connect` page are not mapped yet.
