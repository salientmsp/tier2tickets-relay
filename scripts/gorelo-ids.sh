#!/usr/bin/env bash
# Dump the Gorelo IDs needed to fill wrangler.toml [vars]:
#   ticket types, statuses, priorities, sources and tags, contact tags, and clients (id / name / domains).
#
# Usage:
#   GORELO_API_KEY=xxxx ./scripts/gorelo-ids.sh
#   GORELO_API_KEY=xxxx GORELO_BASE_URL=https://api.aue.gorelo.io ./scripts/gorelo-ids.sh
#   RAW=1 GORELO_API_KEY=xxxx ./scripts/gorelo-ids.sh    # always print raw bodies
#
# Requires: curl, jq. The key needs asset/contact/client read (and ticket write for creates).
set -euo pipefail

BASE_URL="${GORELO_BASE_URL:-https://api.usw.gorelo.io}"
: "${GORELO_API_KEY:?Set GORELO_API_KEY}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required (https://jqlang.github.io/jq/)" >&2
  exit 1
fi

# Fetch a path; print the HTTP status, and either the extracted rows or the raw
# body (on non-2xx, non-JSON, or when the jq extraction finds nothing / RAW=1).
# $1 = path, $2 = jq extraction program
dump() {
  local path="$1" prog="$2" body code
  # Capture body + trailing HTTP code without failing the script on non-2xx.
  body="$(curl -sS -w $'\n%{http_code}' \
    -H "X-API-Key: ${GORELO_API_KEY}" -H "Accept: application/json" \
    "${BASE_URL}${path}" || true)"
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"

  echo "  HTTP ${code}"
  if [[ "${code}" != 2* ]]; then
    echo "  !! request failed — raw body:"
    echo "${body}" | sed 's/^/    /'
    echo "  (403 usually means the API key lacks the required scope.)"
    return
  fi

  # Valid JSON?
  if ! echo "${body}" | jq -e . >/dev/null 2>&1; then
    echo "  !! response is not JSON — raw body:"
    echo "${body}" | sed 's/^/    /'
    return
  fi

  local rows err
  # Surface jq errors (don't hide them) so a shape mismatch is obvious.
  err="$(echo "${body}" | jq -r "${prog}" 2>&1 1>/dev/null || true)"
  rows="$(echo "${body}" | jq -r "${prog}" 2>/dev/null || true)"
  if [[ -n "${err}" ]]; then
    echo "  !! jq extraction error: ${err}"
  fi
  if [[ -z "${rows}" || "${RAW:-}" == "1" ]]; then
    echo "  (no rows extracted — raw JSON below; adjust the vars accordingly)"
    echo "${body}" | jq . | sed 's/^/    /'
  else
    echo "${rows}" | sed 's/^/    /'
  fi
}

# Handles a bare array or an { items | data | results | value: [...] } envelope, in
# camelCase or PascalCase (Gorelo's responses moved to PascalCase in 2026-08).
LIST='(if type=="array" then . else (.Data // .data // .items // .results // .value // []) end) | .[]'
ROWS="${LIST}"' | "\(.Id // .id)\t\(.Name // .name)"'
CLIENT_ROWS="${LIST}"' | "\(.Id // .id)\t\(.Name // .name)\tdomains=\([(.Domains // .domains)[]? | (.Domain // .domain // .Name // .name)] | join(","))"'

# NOTE: DEFAULT_GROUP_ID is intentionally NOT fetched here. GET /v1/organization/groups
# requires the 'Organization' scope, and the Worker never calls it at runtime — get the
# group id from the Gorelo UI (Admin -> Teams/Groups) once.

echo "=== Ticket types  (GET /v1/tickets/types)  -> DEFAULT_TYPE_ID ==="
dump /v1/tickets/types "${ROWS}"

echo
echo "=== Ticket statuses  (GET /v1/tickets/statuses)  (optional) ==="
dump /v1/tickets/statuses "${ROWS}"

echo
# Fixed scales, identical for every Gorelo account (per the spec), so these only
# need reading once to confirm what the wrangler.toml integers mean.
echo "=== Ticket priorities  (GET /v1/tickets/priorities)  -> DEFAULT_PRIORITY, EMERGENCY_PRIORITY ==="
dump /v1/tickets/priorities "${ROWS}"

echo
echo "=== Ticket sources  (GET /v1/tickets/sources)  -> DEFAULT_SOURCE ==="
echo "  (7 = Messenger is read-only: it appears on tickets but create/update reject it.)"
dump /v1/tickets/sources "${ROWS}"

echo
echo "=== Ticket tags  (GET /v1/tickets/tags)  -> HDB_TAG_ID, HUNTRESS_TAG_ID, NERDIO_TAG_ID, FALLBACK_TAG_ID ==="
dump /v1/tickets/tags "${ROWS}"

echo
echo "=== Contact tags  (GET /v1/contacts/tags)  -> VIP_CONTACT_TAG_IDS ==="
dump /v1/contacts/tags "${ROWS}"

echo
echo "=== Clients  (GET /v1/clients)  -> CATCHALL_CLIENT_ID + domain mirror ==="
dump /v1/clients "${CLIENT_ROWS}"
