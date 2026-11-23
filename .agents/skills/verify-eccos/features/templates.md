# Templates

Eccos reads a WABA's message templates from Meta and shows them to servers over the API and to operators in the console. Operators also create, edit and test-send templates from the console's Templates page.

## Sub-features

- `templates-api-list` lists the WABA's templates over the API.
- `templates-console-list` shows the same templates on the console's Templates page.
- `templates-console-create` submits a new template to Meta from `New template`.
- `templates-console-edit` submits changed content for an existing template from its `Edit` action.
- `templates-console-send-test` sends an approved template to one recipient from its `Send test` action.

## How to get to it (user POV)

- Call `GET http://localhost:8787/v1/wabas/100200300/templates` with an account API key.
- In the console, choose `Templates` in the sidebar.
- On Templates, choose the button `New template`, or open a row's menu (button `Actions for order_update (en_US)`) and choose the menu item `Edit` or `Send test`.

## Driving it with verify-eccos

Preconditions:

- Baseline with an active number.
- An API key in `$KEY` for the API recipe. See [Send a message](./send-message.md).
- For the console recipes, the console baseline: a signed-in user whose number is attached. See [Console onboarding](./console-onboarding.md).

- **API list.** Run `curl -s -w ' [%{http_code}]' http://localhost:8787/v1/wabas/100200300/templates -H "authorization: Bearer $KEY"`. The status is `200` and `data[0]` has `"name":"order_update"`, `"language":"en_US"`, `"status":"APPROVED"`.
- **Asked Meta.** Run `$V fake-log /message_templates`. A `GET` line for `/graph/v25.0/100200300/message_templates` exists for each API call. The `API key` step of Console onboarding adds one too.
- **Console list.** Open `http://localhost:3000/templates`. One row shows a button `Open order_update`, the body `Hi {{1}}, your order {{2}} is on its way.`, category `Utility`, language `en_US` and status `APPROVED`.
- **Console create.** Open `http://localhost:3000/templates` and choose the button `New template`. A dialog `New template` opens with a disabled button `Create template`. Fill the textbox `Name` with `verify_shipping` and `Body` with `Hi {{1}}, your parcel has shipped.`. A textbox `Example {{1}}` appears; fill it with `Ana`. Fill `Footer` with `Sent by Verify Workspace`. Choose the button `+ Add button` and fill `Label` with `Track parcel` and `URL` with `https://example.com/track`. The preview reads `Hi Ana, your parcel has shipped.` with the footer and a `Track parcel` button. Choose `Create template`. The dialog's status reads `Submitted for review · PENDING · 900101`.
- **Create reached Meta.** Run `$V fake-log /message_templates`. The newest `POST /graph/v25.0/100200300/message_templates` line has a body with `"name":"verify_shipping"`, `"category":"UTILITY"`, a `BODY` component with `"example":{"body_text":[["Ana"]]}`, a `FOOTER` with the footer text and a `BUTTONS` component with one `URL` button. The list still shows only `order_update`, because the fake serves a fixed list.
- **Console edit.** Close the dialog. Open the menu `Actions for order_update (en_US)` and choose `Edit`. A dialog `Edit template` shows `order_update · en_US`, a disabled combobox `Category` (`UTILITY`), the body `Hi {{1}}, your order {{2}} is on its way.` and the examples `Ana` and `A-1`. Change `Body` to `Hi {{1}}, your order {{2}} has left our warehouse.` and fill `Footer` with `Reply STOP to opt out`. Choose `Submit changes for review`. The status reads `Meta refused the edit` with the detail `fake-meta has no answer for POST /graph/v25.0/900100`. See Gotchas.
- **Edit reached Meta.** Run `$V fake-log /graph/v25.0/900100`. One `POST` line has a body with the new `BODY` text, `"example":{"body_text":[["Ana","A-1"]]}` and the `FOOTER`, and `"status":400,"handled":false`. A `GET /graph/v25.0/100200300/message_templates` precedes it: the gateway checks that the template id belongs to this WABA.
- **Console send test.** Close the dialog, choosing `Discard draft` if asked. Open the menu `Actions for order_update (en_US)` and choose `Send test`. A dialog `order_update · en_US` shows `APPROVED`, `From +34 600 000 001 · 555001`, and the textboxes `Recipient`, `{{1}}` and `{{2}}`. Fill them with `34611111111`, `Ana` and `A-1042`. The preview reads `Hi Ana, your order A-1042 is on its way.`. Choose `Send test message`. The button becomes a disabled `Sent`, a button `Send another` appears, and the status reads `Sent · wamid.FAKE<n>` (the fake's send counter) with a link `View in messages`.
- **Send reached Meta.** Run `$V fake-log /555001/messages`. The newest `POST` line has `"to":"34611111111"`, `"type":"template"`, `"name":"order_update"`, `"language":{"code":"en_US"}` and body parameters `Ana` and `A-1042`.

## Gotchas

- The fake serves one fixed template. Filters and paging need more than one, so they are not provable here. `packages/core/tests/templates.test.ts` covers them.
- The fake has no answer for a template edit (`POST /graph/v25.0/<template id>`), so `templates-console-edit` always ends in `Meta refused the edit`. The proof is the request body in the fake's log, not an accepted edit. Meta's real edit answer and the console's success state are not provable here.
- The fake answers every create with id `900101` and status `PENDING`, and its template list never changes, so a created template does not appear in the table.
- The console's `Delete` and `Duplicate` actions are not mapped yet. The fake answers a delete with success, but nobody has driven those screens.
- Field labels are drawn in capitals (`NAME`, `BODY`, `META ACCESS TOKEN`), and a browser text wait may match neither spelling. Wait for the element by role and accessible name instead.
- Template status changes arrive from Meta as webhooks. No fixture ships for them yet.
