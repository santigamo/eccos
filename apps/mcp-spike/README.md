# MCP spike (task 0.3) — throwaway, never merged

Evidence for `openspec/changes/add-mcp-server` task 0.3. Nothing here is production code; the
console changes on this branch (`apps/dashboard/src/spike/`, the plugin wiring in `auth.ts`) are
prototypes the phase 1 build replaces.

## Run it

```bash
bun install
cd apps/dashboard && cp .dev.vars.example .dev.vars && bunx wrangler d1 migrations apply eccos-auth --local
# terminal 1: gateway
cd apps/gateway && bunx wrangler dev --port 8787 --var DO_JURISDICTION: --var GATEWAY_PUBLIC_URL:http://localhost:8787
# terminal 2: console, as the production build (proves the named ConsoleRPC export survives the build)
cd apps/dashboard && bunx vite build && cp .dev.vars dist/server/ && \
  (cd dist/server && bunx wrangler dev -c wrangler.json --port 3000 --persist-to ../../.wrangler/state) > /tmp/dashboard.log
# terminal 3: the MCP resource server
cd apps/mcp-spike && bunx wrangler dev --port 8788
# then, from apps/mcp-spike (DASHBOARD_LOG points at the console's log, where dev mail links are printed)
DASHBOARD_LOG=/tmp/dashboard.log bun scripts/01-flow.ts   # DCR, sign-up, workspace step, consent, token, tools
DASHBOARD_LOG=/tmp/dashboard.log bun scripts/02-mcp.ts    # SDK client: actor, elicitUrl round trip, requestState, revocation
bun scripts/03-cimd.ts            # Workers CIMD transport against Claude's and ChatGPT's published documents
bun scripts/04-signup-resume.ts   # resuming after email verification
bun scripts/05-stepup.ts          # TOTP and re-authentication inside the consent visit
bun scripts/06-refresh-keys.ts    # refresh, revocation, JWT keys on D1
bun scripts/07-schema.ts          # isError + structuredContent with and without an outputSchema
bun scripts/08-verify-compare.ts  # in-process verification: internal helper vs public API
bun scripts/11-discovery.ts       # RFC 9728 -> RFC 8414 discovery as the MCP SDK client runs it
```

`evidence/` holds the outputs from the run on 2026-11-23 (tokens redacted), `evidence/browser/`
the screenshots of the real console sign-in page driving the consent visit, and
`evidence/10-inspector-cli.txt` the MCP Inspector 2.16.0 CLI against the server. The findings
are written up in `openspec/changes/add-mcp-server/design.md` § 8.
