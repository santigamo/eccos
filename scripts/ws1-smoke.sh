#!/usr/bin/env bash
# WS1.8 manual smoke — run against local wrangler dev or deployed workers.dev URL.
# Usage: BASE_URL=https://eccos.<sub>.workers.dev ./scripts/ws1-smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

BASE_URL="${BASE_URL:-http://localhost:8787}"

required=(META_APP_SECRET META_WEBHOOK_VERIFY_TOKEN)
for v in "${required[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "Missing env: $v (set in .env or export before running)" >&2
    exit 1
  fi
done

echo "==> health ($BASE_URL)"
health="$(curl -sf "$BASE_URL/health")"
echo "$health"
echo "$health" | grep -q '"ok":true'

echo "==> webhook challenge (valid token)"
challenge="$(curl -sf "$BASE_URL/webhooks/meta?hub.mode=subscribe&hub.verify_token=$META_WEBHOOK_VERIFY_TOKEN&hub.challenge=smoke123")"
echo "$challenge"
[[ "$challenge" == "smoke123" ]]

echo "==> webhook challenge (invalid token -> 403)"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x")"
[[ "$code" == "403" ]]

BODY='{"object":"whatsapp_business_account","entry":[{"changes":[{"field":"messages","value":{"statuses":[{"id":"wamid.SMOKE","status":"delivered","timestamp":"1700000000","recipient_id":"34600000000"}]}}]}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$META_APP_SECRET" -hex | sed 's/^.* //')"

echo "==> webhook POST (valid signature)"
resp="$(curl -sf -X POST "$BASE_URL/webhooks/meta" \
  -H "content-type: application/json" \
  -H "x-hub-signature-256: $SIG" \
  --data "$BODY")"
echo "$resp"
echo "$resp" | grep -q '"ok":true'

echo "==> webhook POST (invalid signature -> 401)"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/webhooks/meta" \
  -H "content-type: application/json" \
  -H "x-hub-signature-256: sha256=deadbeef" \
  --data "$BODY")"
[[ "$code" == "401" ]]

echo "==> webhook POST (invalid json, valid sig -> 400)"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/webhooks/meta" \
  -H "content-type: application/json" \
  -H "x-hub-signature-256: $SIG" \
  --data 'not-json')"
[[ "$code" == "400" ]]

if [[ -n "${ECCOS_API_KEY:-}" ]]; then
  echo "==> /v1/messages unauthorized -> 401"
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/v1/messages" \
    -H "content-type: application/json" \
    -d '{"to":"34600000000","type":"text","text":{"body":"hi"}}')"
  [[ "$code" == "401" ]]
fi

echo ""
echo "WS1 smoke passed against $BASE_URL"
