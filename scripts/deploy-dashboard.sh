#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

if [[ -z "${GATEWAY_ACCOUNT_ID:-}" ]]; then
  echo "Missing env: GATEWAY_ACCOUNT_ID (set it in .env or export before running)" >&2
  exit 1
fi

cd "$ROOT/apps/dashboard"
# wrangler v4 `--var` takes KEY:VALUE (a colon); KEY=VALUE silently becomes a
# var *named* "KEY=VALUE" and leaves the real var empty.
wrangler deploy --var "GATEWAY_ACCOUNT_ID:$GATEWAY_ACCOUNT_ID" "$@"