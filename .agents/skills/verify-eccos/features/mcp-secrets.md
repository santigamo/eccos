# MCP secret tools

An agent sets the webhook target and makes API keys over `apps/mcp` without a secret ever passing through it: `api_key_create` and `webhook_set` with `secret: "generate"` return a one-time claim, and the claim's `command` writes the secret to `.env`. The console's claim page and `POST /api/claim` are not built yet, so the stub console (`apps/mcp/tests/stubs/console.ts`) answers `POST /api/claim` by calling the gateway's `redeemSecretClaim`; everything else is the stack's real gateway.

## Sub-features

- `mcp-api-key-claim` makes a key by claim: nothing exists until the command runs, the key then works on `/v1`, and a second redemption is refused.
- `mcp-webhook-secret-claim` sets the target URL at once and a generated signing secret by claim; forwards are then signed with that secret.
- `mcp-api-key-revoke` revokes the key, and `/v1` refuses it.

## How to get to it (user POV)

- An agent connects to `http://localhost:8788/mcp`, calls `api_keys_list`, `api_key_create`, `api_key_revoke`, `webhook_get` and `webhook_set`, and runs the `command` from a claim in a shell. `apps/mcp/tests/dev/evidence.ts` is that agent; it runs each command in a scratch directory with the origin `http://localhost:3000` changed to the stub console's `http://localhost:8791`.

## Driving it with verify-eccos

Preconditions: a fresh `$V launch` ending in `doctor: healthy.`, and the stub console and the MCP server started as in [MCP setup tools](./mcp-setup-tools.md).

- **Run.** `E=$($V evidence mcp-secrets)`, then `VERIFY_ECCOS=1 EVIDENCE_DIR=$E bun apps/mcp/tests/dev/evidence.ts`. Step 11 writes `$E/11-secret-tools.json` and `$E/11-secret-tools-leak-check.json`; it needs the WABA that step 8 registers.
- **Key claim.** In `11-secret-tools.json`, `api_key_create` returns `status: "claim_ready"`, a `claimUrl` `http://localhost:3000/claim#<claim-token>` and a `command`. The `api_keys_list` right after it has one `pendingClaims` entry labelled `evidence-claim` and no key with that label.
- **Redeem.** `apiKey.command` has `exitCode: 0`, one `.env` line and `wroteKey: true`. `v1WithKey` is `200`. The next `api_keys_list` has the key `evidence-claim` and no pending claim.
- **Second redemption.** `apiKey.secondCommand` exits `22` with `curl: (22) The requested URL returned error: 410` and writes nothing; `secondPost` is `410` with body `gone` and `cacheControl` `no-store`.
- **Signing secret.** `webhook_set` with `secret: "generate"` returns `claim_ready`. `signingSecret.hasSecretBeforeRedeem` is `false` and `hasSecretAfterRedeem` is `true`. After an inbound webhook, `forward.path` is `/subscriber/hook` and `signatureValid` is `true`: the `x-eccos-signature` the fake received equals the HMAC of the forwarded body under the redeemed secret.
- **Revoke.** `api_key_revoke` returns `revoked`, and `v1AfterRevoke` is `401`.
- **No secret leaked.** `11-secret-tools-leak-check.json` has `secretsInFakeLog: 0`. In the MCP server's `wrangler dev` log, the audit lines of `api_key_create` and `webhook_set` carry a `claimId` and no token, and `grep -cE '[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{43}|ek_[A-Za-z0-9_-]{20}'` over that log, the stub console's log and `.verify/run/gateway.log` prints `0`.

## Gotchas

- `POST /api/claim` here is the stub console's stand-in. It proves the claim, the gateway's redemption and the command's shape, not the console's page, its wrong-token limit or its creator re-check (task 1.4c).
- Step-up comes from the stub console: step 8 approves an elevation for the run's agent, so these calls are not asked for approval. Both approval carriers are proven by `apps/mcp/tests/worker/webhook.spec.ts` and `api-keys.spec.ts`.
- The script masks every claim token, every redeemed secret and every `ek_` key in the files it writes. Keep it that way when you change it.
- Step 11 sends an inbound webhook with a new message id: the fixture's own id was ingested in step 8, and a duplicate is not forwarded again.
