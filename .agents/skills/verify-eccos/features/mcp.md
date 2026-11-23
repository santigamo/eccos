# MCP server

Agents reach Eccos through the MCP server in `apps/mcp`. This recipe drives its template tools with the MCP SDK client against the real local gateway, with Meta answered by the fake. The console's OAuth side is not built yet, so a stub console (`apps/mcp/tests/stubs/console.ts`) stands in for `ConsoleRPC` and grants a token for a fixed owner.

## Sub-features

- `mcp-templates-list` lists the WABA's templates, each with what a test send needs.
- `mcp-template-create` submits a template and refuses what the console refuses before Meta is called.
- `mcp-template-send-test` sends an approved template to one recipient and turns Meta's refusals into actionable errors.
- `mcp-template-delete` deletes one translation.
- `mcp-two-accounts` refuses another workspace's WABA and phone ids.

## How to get to it (user POV)

- An agent connects to `http://localhost:8788/mcp` with a bearer token and calls the tools `templates_list`, `template_create`, `template_edit`, `template_delete` and `template_send_test`.

## Driving it with verify-eccos

Preconditions:

- `$V launch` ended with `doctor: healthy.`.
- The stub console registers under the console's Worker name, so stop the launched console first: `kill -- -$(cat .verify/run/dashboard.pid)`. Its port 8790 belongs to the fake, so the stub console runs on 8791.

Then:

- **Start the MCP side.** In `apps/mcp`, run `bunx wrangler dev -c tests/dev/wrangler.console.jsonc --port 8791 --inspector-port 9241` and `bunx wrangler dev --inspector-port 9242`, each in its own terminal. Both print `Ready on`, and both list their `GATEWAY` binding as `[connected]`.
- **Drive the tools.** From the repository root run `E=$($V evidence mcp-templates); ECCOS_ADMIN_API_KEY=$($V env | sed -n 's/^ECCOS_ADMIN_API_KEY=//p') CONSOLE_URL=http://localhost:8791 EVIDENCE_DIR="$E" bun apps/mcp/tests/dev/evidence.ts`. It provisions a workspace, attaches WABA `100200300` through the admin routes, and writes `04-templates-setup.json` with `reconcile.wabaStatus` `active`.
- **List.** In `$E/05-template-tools.json`, the `templates_list` call returns `order_update` with `testSend: { ready: true, bodyParamCount: 2 }`.
- **Create.** `template_create` of `pickup_ready` returns `templateId` `900101` and status `PENDING`. `template_create` of a body with `{{name}}` is an error starting `Named parameters cannot be created here`, and `$V fake-log /message_templates` shows exactly one `POST`.
- **Send.** `template_send_test` with two `bodyParams` returns `status: "accepted"` and `messageId` `wamid.FAKE1`; `$V fake-log /555001/messages` shows the send to `34611111111`. With one parameter it is an error `does not match: it takes exactly 2 bodyParams` and no send is logged. To `34600000999` it is an error `Meta refused the send. Meta said: "Message undeliverable"`.
- **Delete.** `template_delete` of `900100` returns `deleted: true`, and the fake log has a `DELETE /graph/v25.0/100200300/message_templates`.
- **Two accounts.** `$E/06-two-accounts.json`: an agent of a second workspace calling `templates_list` and `template_delete` with WABA `100200300`, and `template_send_test` with phone `555001`, gets three errors, and the fake log has no Graph request for them.

## Gotchas

- The fake has no answer for Meta's template edit (`POST /graph/v25.0/900100`), so `template_edit` ends in the tool's `invalid` error with `fake-meta has no answer` in Meta's sentence. That proves the error path only. The success path is covered by `apps/mcp/tests/worker/templates.spec.ts`.
- The stub console is not the real authorization server. Scopes, roles and step-up are proven by the Workers specs in `apps/mcp/tests/worker/`, not here.
- The second workspace owns no WABA, because the fake knows one WABA and a WABA belongs to one account, so its refusals read `no WhatsApp Business account connected yet`. The specs cover a second workspace that owns its own WABA.
