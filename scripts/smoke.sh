#!/usr/bin/env bash
# Eccos smoke test — run against a local `wrangler dev` or a deployed workers.dev URL.
# Exits non-zero on the first failed check (set -e + `curl -f`), so it's safe to gate a
# deploy on its exit code.
# Usage:
#   ./scripts/smoke.sh https://eccos.<sub>.workers.dev
#   BASE_URL=https://eccos.<sub>.workers.dev ./scripts/smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Positional arg wins over BASE_URL env, which wins over the local wrangler-dev default.
BASE_URL="${1:-${BASE_URL:-http://localhost:8787}}"

required=(META_APP_SECRET META_WEBHOOK_VERIFY_TOKEN)
for v in "${required[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "Missing env: $v (set in .env or export before running)" >&2
    exit 1
  fi
done
SMOKE_WABA_ID="${SMOKE_WABA_ID:-smoke-waba}"
if [[ ! "$SMOKE_WABA_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Invalid SMOKE_WABA_ID: expected letters, digits, '_' or '-'" >&2
  exit 1
fi
echo "==> health ($BASE_URL)"
health="$(curl -sf "$BASE_URL/health")"
echo "$health"
echo "$health" | grep -q '"ok":true'

echo "==> ready ($BASE_URL)"
ready="$(curl -sf "$BASE_URL/ready")"
echo "$ready"
echo "$ready" | grep -q '"ok":true'

echo "==> webhook challenge (valid token)"
challenge="$(curl -sf "$BASE_URL/webhooks/meta?hub.mode=subscribe&hub.verify_token=$META_WEBHOOK_VERIFY_TOKEN&hub.challenge=smoke123")"
echo "$challenge"
[[ "$challenge" == "smoke123" ]]

echo "==> webhook challenge (invalid token -> 403)"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x")"
[[ "$code" == "403" ]]

BODY='{"object":"whatsapp_business_account","entry":[{"id":"'"$SMOKE_WABA_ID"'","changes":[{"field":"messages","value":{"statuses":[{"id":"wamid.SMOKE","status":"delivered","timestamp":"1700000000","recipient_id":"34600000000"}]}}]}]}'
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

if [[ -n "${ECCOS_ACCOUNT_API_KEY:-}" ]]; then
  echo "==> scoped send with a bogus account key -> 401"
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/v1/wabas/$SMOKE_WABA_ID/messages" \
    -H "content-type: application/json" \
    -H "authorization: Bearer $ECCOS_ACCOUNT_API_KEY" \
    -d '{"to":"34600000000","type":"text","text":{"body":"hi"}}')"
  [[ "$code" == "401" ]]
fi

echo ""
echo "Smoke test passed against $BASE_URL"
