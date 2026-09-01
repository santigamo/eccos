#!/usr/bin/env bash
set -euo pipefail

# Dashboard deploy helper (eccos-0x0.4): customer auth is Better Auth + D1.
#
# Required in production (Worker secrets — set once with `wrangler secret put`):
#   BETTER_AUTH_SECRET — auth secret (>= 32 chars)
#   RECCADO_API_KEY    — mail provider key (docs/auth-email-delivery.md)
#   RECCADO_ENDPOINT   — full message endpoint, mailbox id and all:
#                        https://<host>/v1/mailboxes/<mailboxId>/transactional/messages
#                        One value, not a host plus an id: the key already binds
#                        to exactly one mailbox, so a second id could only ever
#                        disagree — and a disagreement reads as
#                        `403 invalid_api_key`, blaming the key, not the pairing.
#                        A secret, not a --var: it carries the provider host and
#                        wrangler.jsonc is in a public repo. The adapter
#                        validates it and fails closed on boot.
#
# The auth D1 schema must exist before traffic is served:
#   cd apps/dashboard && wrangler d1 migrations apply eccos-auth --remote
# The canonical-host allowlist (app.eccos.chat) is enforced in src/server.ts;
# there are no Access variables anymore and workers.dev is disabled.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

cd "$ROOT/apps/dashboard"
# No --var plumbing: every mail setting is a Worker secret now, set once with
# `wrangler secret put` (see the header). Nothing about the provider belongs in
# the public wrangler.jsonc or in a deploy command line.
wrangler deploy "$@"
