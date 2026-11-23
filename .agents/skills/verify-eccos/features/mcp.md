# MCP server

Agents reach Eccos through the MCP server in `apps/mcp`. This recipe drives its template tools with the MCP SDK client against the real local gateway, with Meta answered by the fake. The console's OAuth side is not built yet, so a stub console (`apps/mcp/tests/stubs/console.ts`) stands in for `ConsoleRPC` and grants a token for a fixed owner.

## Sub-features

- `mcp-templates-list` lists the WABA's templates, each with what a test send needs.
- `mcp-template-create` submits a template and refuses what the console refuses before Meta is called.
- `mcp-template-send-test` sends an approved template to one recipient and turns Meta's refusals into actionable errors.
- `mcp-template-edit` replaces one translation's content at Meta.
- `mcp-template-delete` deletes one translation.
- `mcp-two-accounts` refuses another workspace's WABA and phone ids.

## How to get to it (user POV)

- An agent connects to `http://localhost:8788/mcp` with a bearer token and calls the tools `templates_list`, `template_create`, `template_edit`, `template_delete` and `template_send_test`.

## Driving it with verify-eccos

Preconditions: a fresh `$V launch` ending in `doctor: healthy.`, and the stub console and the MCP server started as in [MCP setup tools](./mcp-setup-tools.md).

- **Run.** `E=$($V evidence mcp-templates)`, then `VERIFY_ECCOS=1 EVIDENCE_DIR=$E bun apps/mcp/tests/dev/evidence.ts`. The setup tools' run (file `08`) registers WABA `100200300` and re-checks it to `active`, and gives a second workspace WABA `700800900`. The template tools then run against `100200300`.
- **List.** In `$E/09-template-tools.json`, the first `templates_list` call returns `order_update` with `testSend: { ready: true, bodyParamCount: 2 }`.
- **Create.** `template_create` of `pickup_ready` returns `templateId` `900101` and status `PENDING`. `template_create` of a body with `{{name}}` is an error starting `Refused before reaching Meta: Named parameters cannot be created here`, and `$V fake-log /message_templates` shows exactly one `POST`.
- **Edit.** `template_edit` of `900100` returns `templateId` `900100` and a `next` that says Meta reviews the new content. `$V fake-log /graph/v25.0/900100` shows one `POST` whose body carries `"text":"Hi {{1}}, order {{2}} shipped."`, answered `200`. The next call, `templates_list` with `name` `order_update`, returns that body.
- **Send.** `template_send_test` with two `bodyParams` returns `status: "accepted"` and `messageId` `wamid.FAKE1`; `$V fake-log /555001/messages` shows the send to `34611111111`. With one parameter it is an error `does not match: it takes exactly 2 bodyParams` and no send is logged. To `34600000999` it is an error `Meta refused the send. Meta said: "Message undeliverable"`.
- **Another workspace's WABA.** `templates_list` with `wabaId` `700800900` is an error `WABA 700800900 is not connected to this workspace. Its WABAs are: 100200300`.
- **Delete.** `template_delete` of `900100` returns `deleted: true`, and the fake log has a `DELETE /graph/v25.0/100200300/message_templates`.
- **Two accounts.** In `$E/10-template-two-accounts.json`, the second workspace's agent calls `templates_list` and `template_delete` with WABA `100200300`, and `template_send_test` with phone `555001`. The two WABA calls are errors `WABA 100200300 is not connected to this workspace. Its WABAs are: 700800900`; the send is an error `Phone number id 555001 is not registered in this workspace`. None names the first workspace's ids as its own, and the fake log has no Graph request for them.

## Gotchas

- The fake applies an edit at once and keeps the template `APPROVED`; Meta puts an edited template back into review. The send after the edit proves the tool's path, not Meta's review.
- The fake keeps templates per WABA, so WABA `700800900` has none. A refusal of another workspace's WABA comes from Eccos before Meta is asked, which the fake log shows by having no request for it.
- Whether a template input is refused exactly as the console refuses it is proven by `apps/mcp/tests/worker/template-parity.spec.ts`, not here.
- The stub console is not the real authorization server. Scopes, roles and step-up are proven by the Workers specs in `apps/mcp/tests/worker/`, not here.
