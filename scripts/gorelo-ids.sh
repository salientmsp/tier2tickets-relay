#!/usr/bin/env bash
# Dump the Gorelo IDs needed to fill wrangler.toml [vars]:
#   groups, ticket types, ticket statuses, and clients (id / name / domains).
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

# Handles a bare array or an { items | data | results | value: [...] } envelope.
ROWS='(if type=="array" then . else (.items // .data // .results // .value // []) end) | .[] | "\(.id)\t\(.name)"'
CLIENT_ROWS='(if type=="array" then . else (.items // .data // .results // .value // []) end) | .[] | "\(.id)\t\(.name)\tdomains=\([.domains[]? | (.domain // .name)] | join(","))"'

# NOTE: DEFAULT_GROUP_ID is intentionally NOT fetched here. GET /v1/organization/groups
# requires the 'Organization' scope, and the Worker never calls it at runtime — get the
# group id from the Gorelo UI (Admin -> Teams/Groups) once.

echo "=== Ticket types  (GET /v1/tickets/types)  -> DEFAULT_TYPE_ID ==="
dump /v1/tickets/types "${ROWS}"

echo
echo "=== Ticket statuses  (GET /v1/tickets/statuses)  (optional) ==="
dump /v1/tickets/statuses "${ROWS}"

echo
echo "=== Clients  (GET /v1/clients)  -> CATCHALL_CLIENT_ID + domain mirror ==="
dump /v1/clients "${CLIENT_ROWS}"

echo
echo "DEFAULT_PRIORITY / DEFAULT_SOURCE: the v1 spec ships PublicTicketPriority=[0..4]"
echo "and TicketSource=[1..6] as bare int enums with NO labels, and exposes no list"
echo "endpoint (nor a GET-ticket endpoint to read one back). Read the mapping off the"
echo "New Ticket form in the Gorelo UI: the Priority (0..4) and Source (1..6) dropdown"
echo "order gives the integer to use."
