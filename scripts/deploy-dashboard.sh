#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

if [[ -z "${GATEWAY_WABA_ID:-}" ]]; then
  echo "Missing env: GATEWAY_WABA_ID (set it in .env or export before running)" >&2
  exit 1
fi

cd "$ROOT/apps/dashboard"
wrangler deploy --var "GATEWAY_WABA_ID=$GATEWAY_WABA_ID" "$@"
