#!/usr/bin/env bash
# Generate a per-product Halo OAuth credential pair (client_id + client_secret),
# push the SECRET into the Worker with `wrangler secret put`, and print the values
# to paste into that product's Halo integration on the other side. See issue #51:
# each product authenticates with its OWN client_id/secret, so multiple products can
# pass `HALO_TOKEN_ENFORCE="enforce"` at once.
#
# Usage:
#   ./scripts/halo-cred.sh tier2                 # -> HALO_CLIENT_ID / HALO_CLIENT_SECRET
#   ./scripts/halo-cred.sh huntress              # -> HALO_CLIENT_ID_HUNTRESS / HALO_CLIENT_SECRET_HUNTRESS
#   CLIENT_ID=13b3832f... ./scripts/halo-cred.sh huntress   # reuse a client_id the product already fixes
#   ./scripts/halo-cred.sh huntress --env staging          # extra args pass through to wrangler
#   DRY_RUN=1 ./scripts/halo-cred.sh tier2       # print the values, don't call wrangler
#
# The client_id is NOT a secret (it's a public identifier) — set it in wrangler.toml
# [vars] under the printed var name, OR `wrangler secret put` it too if you prefer.
# Only the client_secret is pushed as a secret here. Requires: openssl (or a working
# /dev/urandom) and wrangler.
set -euo pipefail

PRODUCT="${1:-}"
if [[ -z "${PRODUCT}" ]]; then
  echo "usage: $0 <product-key> [extra wrangler args...]   (e.g. tier2, huntress)" >&2
  exit 1
fi
shift || true

# tier2 keeps the original un-suffixed var names; every other product is suffixed
# with its uppercased key (matches clientIdVar/clientSecretVar in src/products.ts).
key_upper="$(printf '%s' "${PRODUCT}" | tr '[:lower:]-' '[:upper:]_')"
if [[ "${PRODUCT}" == "tier2" ]]; then
  ID_VAR="HALO_CLIENT_ID"
  SECRET_VAR="HALO_CLIENT_SECRET"
else
  ID_VAR="HALO_CLIENT_ID_${key_upper}"
  SECRET_VAR="HALO_CLIENT_SECRET_${key_upper}"
fi

# A URL-safe high-entropy token (32 bytes). openssl if present, else /dev/urandom.
gen() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
  else
    head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
  fi
}

CLIENT_ID="${CLIENT_ID:-$(gen)}"
CLIENT_SECRET="$(gen)"

echo "Product:       ${PRODUCT}"
echo "client_id  var: ${ID_VAR}"
echo "client_secret var: ${SECRET_VAR}"
echo
echo "--- paste these into ${PRODUCT}'s Halo integration (the other side) ---"
echo "client_id:     ${CLIENT_ID}"
echo "client_secret: ${CLIENT_SECRET}"
echo "-----------------------------------------------------------------------"
echo

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "DRY_RUN=1 — not calling wrangler. To apply:"
  echo "  printf %s '${CLIENT_SECRET}' | npx wrangler secret put ${SECRET_VAR} $*"
  echo "  # then set ${ID_VAR}=\"${CLIENT_ID}\" in wrangler.toml [vars] (or secret-put it too)"
  exit 0
fi

# Pipe the secret to wrangler on stdin so it never lands in shell history/argv.
echo "Pushing ${SECRET_VAR} via wrangler secret put..."
printf '%s' "${CLIENT_SECRET}" | npx wrangler secret put "${SECRET_VAR}" "$@"

echo
echo "Done. Remaining step: set the (non-secret) client_id so the relay can validate it —"
echo "  add to wrangler.toml [vars]:  ${ID_VAR} = \"${CLIENT_ID}\""
echo "  (or push it as a secret too:  printf %s '${CLIENT_ID}' | npx wrangler secret put ${ID_VAR} $*)"
echo
echo "Both parts must resolve non-empty for ${PRODUCT} to be validated + token-enforced;"
echo "leave them unset to keep ${PRODUCT} lenient (any creds accepted) during rollout."
