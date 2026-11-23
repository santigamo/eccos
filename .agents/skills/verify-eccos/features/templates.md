# Templates

Eccos reads a WABA's message templates from Meta and shows them to servers over the API and to operators in the console.

## Sub-features

- `templates-api-list` lists the WABA's templates over the API.
- `templates-console-list` shows the same templates on the console's Templates page.

## How to get to it (user POV)

- Call `GET http://localhost:8787/v1/wabas/100200300/templates` with an account API key.
- In the console, choose `Templates` in the sidebar.

## Driving it with verify-eccos

Preconditions:

- Baseline with an active number.
- An API key in `$KEY` for the API recipe. See [Send a message](./send-message.md).

- **API list.** Run `curl -s -w ' [%{http_code}]' http://localhost:8787/v1/wabas/100200300/templates -H "authorization: Bearer $KEY"`. The status is `200` and `data[0]` has `"name":"order_update"`, `"language":"en_US"`, `"status":"APPROVED"`.
- **Asked Meta.** Run `$V fake-log /message_templates`. A `GET` line for `/graph/v25.0/100200300/message_templates` exists for each API call. The `API key` step of Console onboarding adds one too.
- **Console list.** Open `http://localhost:3000/templates`. One row shows a button `Open order_update`, the body `Hi {{1}}, your order {{2}} is on its way.`, category `Utility`, language `en_US` and status `APPROVED`.

## Gotchas

- The fake serves one fixed template. Filters and paging need more than one, so they are not provable here. `packages/core/tests/templates.test.ts` covers them.
- The console's `New template`, edit and delete flows are not mapped yet. The fake answers a create with status `PENDING` and a delete with success, but nobody has driven those screens. Add a recipe before claiming them.
- Template status changes arrive from Meta as webhooks. No fixture ships for them yet.
