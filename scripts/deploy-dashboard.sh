#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

cd "$ROOT/apps/dashboard"
wrangler_args=()
if [[ -n "${ACCESS_TEAM_DOMAIN:-}" ]]; then
  wrangler_args+=(--var "ACCESS_TEAM_DOMAIN:$ACCESS_TEAM_DOMAIN")
fi
if [[ -n "${ACCESS_AUD:-}" ]]; then
  wrangler_args+=(--var "ACCESS_AUD:$ACCESS_AUD")
fi

if (( ${#wrangler_args[@]} > 0 )); then
  wrangler deploy "${wrangler_args[@]}" "$@"
else
  wrangler deploy "$@"
fi
