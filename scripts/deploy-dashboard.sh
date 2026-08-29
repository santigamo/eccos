#!/usr/bin/env bash
set -euo pipefail

# Dashboard deploy helper (eccos-0x0.4): customer auth is Better Auth + D1.
#
# Required in production (Worker secrets — set once with `wrangler secret put`):
#   BETTER_AUTH_SECRET — auth secret (>= 32 chars)
#   RESEND_API_KEY     — mail provider key (docs/auth-email-delivery.md)
# Optional var:
#   MAIL_FROM          — verified sending identity, e.g. "Eccos <noreply@notify.eccos.chat>"
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
if [[ -n "${MAIL_FROM:-}" ]]; then
  wrangler_args+=(--var "MAIL_FROM:$MAIL_FROM")
fi

if (( ${#wrangler_args[@]} > 0 )); then
  wrangler deploy "${wrangler_args[@]}" "$@"
else
  wrangler deploy "$@"
fi
