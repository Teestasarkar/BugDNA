#!/usr/bin/env bash
# =============================================================================
# Generate the cryptographic secrets into .env
# =============================================================================
# Only fills values that are missing or still placeholders — running it twice
# will not rotate a working key out from under a live deployment.
#
# TOKEN_ENCRYPTION_KEY is the one to be careful with: it encrypts stored GitHub
# access tokens, so changing it makes every existing connection unreadable.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

ENV_FILE="${ENV_FILE:-.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "$ENV_FILE not found. Run: cp .env.example .env" >&2
  exit 1
fi

command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

# needs_value <KEY>  -> true when unset, empty, or a CHANGE_ME placeholder
needs_value() {
  local key="$1"
  local current
  current="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  [[ -z "$current" || "$current" == CHANGE_ME* ]]
}

set_value() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # `|` delimiter: generated hex never contains it, unlike `/`
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
  echo "  set $key"
}

echo "Generating secrets in $ENV_FILE"

if needs_value SESSION_SECRET; then
  set_value SESSION_SECRET "$(openssl rand -hex 48)"
else
  echo "  SESSION_SECRET already set, leaving it"
fi

if needs_value TOKEN_ENCRYPTION_KEY; then
  # Exactly 32 bytes -> 64 hex characters. AES-256-GCM requires this width.
  set_value TOKEN_ENCRYPTION_KEY "$(openssl rand -hex 32)"
else
  echo "  TOKEN_ENCRYPTION_KEY already set, leaving it (rotating would orphan stored GitHub tokens)"
fi

if needs_value ML_SERVICE_TOKEN; then
  set_value ML_SERVICE_TOKEN "$(openssl rand -hex 24)"
else
  echo "  ML_SERVICE_TOKEN already set, leaving it"
fi

# The compose default password is fine locally but must not reach production.
current_pg="$(grep -E '^POSTGRES_PASSWORD=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
if [[ -z "$current_pg" || "$current_pg" == "bugdna_local_password" || "$current_pg" == CHANGE_ME* ]]; then
  set_value POSTGRES_PASSWORD "$(openssl rand -hex 24)"
else
  echo "  POSTGRES_PASSWORD already customised, leaving it"
fi

cat <<DONE

Done. Still to set by hand in $ENV_FILE:

  APP_URL, API_URL, CORS_ORIGINS      your public origin
  NEXT_PUBLIC_API_URL, NEXT_PUBLIC_WS_URL
  BUGDNA_SERVER_NAME                  the hostname Nginx should answer on
  GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_CALLBACK_URL
  COOKIE_SECURE=true                  once TLS is terminated

Back up TOKEN_ENCRYPTION_KEY somewhere other than this instance.

DONE
