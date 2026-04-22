#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "FAIL: Missing .env at ${ENV_FILE}"
  exit 1
fi

set -a
source "${ENV_FILE}"
set +a

fail() {
  echo "FAIL: $1"
  exit 1
}

warn() {
  echo "WARN: $1"
}

ok() {
  echo "OK: $1"
}

[[ -n "${CLOUDBEDS_API_KEY:-}" ]] || fail "CLOUDBEDS_API_KEY is missing."
[[ -n "${CLOUDBEDS_PROPERTY_ID:-}" ]] || fail "CLOUDBEDS_PROPERTY_ID is missing."
[[ -n "${CLOUDBEDS_PROPERTY_NAME:-}" ]] || warn "CLOUDBEDS_PROPERTY_NAME is not set."

if [[ "${CLOUDBEDS_API_KEY}" == CLOUDBEDS_API_KEY=* ]]; then
  fail "CLOUDBEDS_API_KEY contains a prefixed key string. Use raw key only."
fi

if [[ ! "${CLOUDBEDS_API_KEY}" =~ ^cbat_ ]]; then
  warn "CLOUDBEDS_API_KEY does not look like expected API key format (cbat_*)."
else
  ok "API key format looks valid."
fi

if [[ ! "${CLOUDBEDS_PROPERTY_ID}" =~ ^[0-9]+$ ]]; then
  fail "CLOUDBEDS_PROPERTY_ID should be numeric for Cloudbeds property IDs."
else
  ok "Property ID format looks valid."
fi

echo "Checking Cloudbeds connectivity with getHotels..."
HTTP_CODE="$(
  curl -sS -o /tmp/cloudbeds_preflight_response.json -w "%{http_code}" \
    -G "https://api.cloudbeds.com/api/v1.3/getHotels" \
    -H "x-api-key: ${CLOUDBEDS_API_KEY}" \
    --data-urlencode "page=1" \
    --data-urlencode "pageSize=200"
)"

[[ "${HTTP_CODE}" == "200" ]] || fail "Cloudbeds getHotels returned HTTP ${HTTP_CODE}."

if ! grep -q '"success":[[:space:]]*true' /tmp/cloudbeds_preflight_response.json; then
  fail "Cloudbeds response success flag is not true."
fi

if ! grep -q "\"propertyID\":[[:space:]]*\"${CLOUDBEDS_PROPERTY_ID}\"" /tmp/cloudbeds_preflight_response.json; then
  fail "Configured CLOUDBEDS_PROPERTY_ID was not found in getHotels response."
fi

ok "Cloudbeds auth + property mapping verified."
echo "PASS: Preflight checks completed."
