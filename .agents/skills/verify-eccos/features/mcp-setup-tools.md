# MCP setup tools

An agent connected to `apps/mcp` takes a workspace from nothing to a live number: it reads billing, makes the connection link for a person, follows the link and the number's provisioning, re-checks a pending number and reads its health. The console's `ConsoleRPC` is not served yet, so the MCP server authorizes through the stub console in `apps/mcp/tests/stubs/console.ts`; every tool except billing reads the stack's real gateway.

## Sub-features

- `mcp-connect-link` makes the link behind an approval, keeps an existing one, and replaces it with `replace: true`.
- `mcp-numbers` lists a WABA registered pending, re-checks it to active against the fake's `subscribed_apps`, and reads its status after an inbound webhook.
- `mcp-billing` answers billing from the stub console: disabled, subscription required, checkout link.
- `mcp-two-accounts` refuses another account's WABA without naming that account.

## How to get to it (user POV)

- An MCP client posts to `http://localhost:8788/mcp` with a bearer token the stub console knows. `apps/mcp/tests/dev/evidence.ts` is that client.

## Driving it with verify-eccos

Preconditions: a fresh `$V launch` ending in `doctor: healthy.`.

- **Stub console.** `(cd apps/mcp && bunx wrangler dev -c tests/dev/wrangler.console.jsonc --inspector-port 9241)`, detached. It is `eccos-console-stub` on port 8791, so it does not collide with the fake (8790) or the console's worker name.
- **MCP server.** `(cd apps/mcp && bunx wrangler dev -c tests/dev/wrangler.mcp.jsonc --inspector-port 9242 --var REQUEST_STATE_KEY:$(openssl rand -base64 48))`, detached. Ready when `curl -s localhost:8788/.well-known/oauth-protected-resource/mcp` answers `200`.
- **Run.** `E=$($V evidence mcp-setup-tools)`, then `VERIFY_ECCOS=1 EVIDENCE_DIR=$E bun apps/mcp/tests/dev/evidence.ts`. `07-setup-tools.json` holds every setup-tool call in order; files `01` to `06` are the skeleton's own evidence. Expect: `numbers_list` empty with `nextTool: connect_link_create`; `connect_link_create` first `approval_required`, then `created` with `http://localhost:3000/connect#<link-token>`, then `exists`, then `created` again with `replace: true`; `numbers_list` shows `100200300` `pending`; `status_get` refused; `number_recheck` `active`; `status_get` `healthy` with `counts.inbound` 1; the last two calls refuse WABA `700800900` with "is not connected to this workspace. Its WABAs are: 100200300".
- **Side effect.** `$V fake-log /subscribed_apps` shows the one `POST /graph/v25.0/100200300/subscribed_apps` the re-check made.

## Gotchas

- Billing answers come from the stub console, so they prove the tools' handling, not Creem or the console's billing rules.
- The script writes the connection link as `/connect#<link-token>` and the bearer as `<token>`. Keep it that way: the link is a bearer value.
- Opening the link is the console's `/connect` page and Meta's dialog; neither is reachable here, so `connect_status` never moves past `pending` in this run.
- Stop the two `wrangler dev` processes before `$V stop`; `$V stop` only stops what `$V launch` started.
