#!/usr/bin/env bash
set -euo pipefail

# Dashboard deploy helper (eccos-0x0.4): customer auth is Better Auth + D1.
#
# Required in production (Worker secrets — set once with `wrangler secret put`):
#   BETTER_AUTH_SECRET — auth secret (>= 32 chars)
#   RECCADO_API_KEY    — mail provider key (docs/auth-email-delivery.md)
# Vars that accompany the mail key (the adapter fails closed without them):
#   RECCADO_BASE_URL   — provider origin. Configuration, not a constant: the
#                        custom domain is behind Cloudflare Access and answers
#                        only on its workers.dev host today.
#   RECCADO_MAILBOX_ID — sending mailbox (also the sending identity; there is
#                        no MAIL_FROM any more)
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
wrangler_args=()
if [[ -n "${RECCADO_BASE_URL:-}" ]]; then
  wrangler_args+=(--var "RECCADO_BASE_URL:$RECCADO_BASE_URL")
fi
if [[ -n "${RECCADO_MAILBOX_ID:-}" ]]; then
  wrangler_args+=(--var "RECCADO_MAILBOX_ID:$RECCADO_MAILBOX_ID")
fi

if (( ${#wrangler_args[@]} > 0 )); then
  wrangler deploy "${wrangler_args[@]}" "$@"
else
  wrangler deploy "$@"
fi
