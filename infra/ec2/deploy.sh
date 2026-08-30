#!/usr/bin/env bash
# =============================================================================
# BugDNA — deploy to EC2
# =============================================================================
# Pulls the images CI built and rolls the stack forward.
#
#   ./infra/ec2/deploy.sh              # deploy :latest
#   ./infra/ec2/deploy.sh v1.4.0       # deploy a specific tag
#   ./infra/ec2/deploy.sh --rollback   # return to the previously deployed tag
#
# Safety properties this script provides, in order of importance:
#
#   1. **It refuses to deploy into a broken configuration.** Required variables
#      are checked before anything is touched.
#   2. **It backs up the database first.** Migrations run on `up`, and a
#      migration is the one deploy step that is not trivially reversible.
#   3. **It verifies readiness afterwards and rolls back on failure.** A deploy
#      that leaves the site down is worse than one that never happened.
#   4. **It records the deployed tag**, so `--rollback` has something to return
#      to.
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$APP_DIR"

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env"
STATE_FILE=".deploy-state"
HEALTH_URL="${HEALTH_URL:-http://localhost/api/v1/system/ready}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"

# --- output helpers ----------------------------------------------------------
log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[1;31mfailed:\033[0m %s\n\n' "$*" >&2; exit 1; }

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# --- arguments ---------------------------------------------------------------
ROLLBACK=false
REQUESTED_TAG=""

for arg in "$@"; do
  case "$arg" in
    --rollback) ROLLBACK=true ;;
    --*)        die "unknown option: $arg" ;;
    *)          REQUESTED_TAG="$arg" ;;
  esac
done

# --- preflight ---------------------------------------------------------------
log "Preflight"

[[ -f "$COMPOSE_FILE" ]] || die "$COMPOSE_FILE not found — run this from the repository root."
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found. Copy .env.example to .env and fill it in."

command -v docker >/dev/null 2>&1 || die "docker is not installed. Run infra/ec2/bootstrap.sh first."
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed."

# Required in production. Checking here turns a container crash-loop into a
# readable message before anything is stopped.
REQUIRED_VARS=(
  POSTGRES_USER POSTGRES_PASSWORD
  SESSION_SECRET TOKEN_ENCRYPTION_KEY ML_SERVICE_TOKEN
  APP_URL API_URL CORS_ORIGINS
  NEXT_PUBLIC_API_URL NEXT_PUBLIC_WS_URL
  GITHUB_CALLBACK_URL
)

missing=()
placeholders=()

for var in "${REQUIRED_VARS[@]}"; do
  value="$(grep -E "^${var}=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  if [[ -z "$value" ]]; then
    missing+=("$var")
  elif [[ "$value" == CHANGE_ME* ]]; then
    placeholders+=("$var")
  fi
done

if (( ${#missing[@]} > 0 )); then
  die "these variables are empty in $ENV_FILE: ${missing[*]}"
fi

if (( ${#placeholders[@]} > 0 )); then
  die "these variables still hold placeholder values: ${placeholders[*]}
     Run ./infra/ec2/generate-secrets.sh to fill in the cryptographic ones."
fi

ok "environment file looks complete"

# --- resolve the tag ---------------------------------------------------------
PREVIOUS_TAG="latest"
[[ -f "$STATE_FILE" ]] && PREVIOUS_TAG="$(grep -E '^current=' "$STATE_FILE" | cut -d= -f2 || echo latest)"

if [[ "$ROLLBACK" == true ]]; then
  TARGET_TAG="$(grep -E '^previous=' "$STATE_FILE" 2>/dev/null | cut -d= -f2 || true)"
  [[ -n "$TARGET_TAG" ]] || die "no previous deployment recorded in $STATE_FILE."
  log "Rolling back to $TARGET_TAG (from $PREVIOUS_TAG)"
else
  TARGET_TAG="${REQUESTED_TAG:-${IMAGE_TAG:-latest}}"
  log "Deploying tag: $TARGET_TAG"
fi

export IMAGE_TAG="$TARGET_TAG"

# --- backup ------------------------------------------------------------------
# Only when Postgres is already running: a first deploy has nothing to back up.
if compose ps --status running postgres 2>/dev/null | grep -q postgres; then
  log "Backing up the database before migrating"
  if [[ -x ./infra/ec2/backup.sh ]]; then
    ./infra/ec2/backup.sh && ok "backup written to ./backups"
  else
    warn "infra/ec2/backup.sh is missing or not executable; skipping the backup"
  fi
else
  warn "Postgres is not running yet; skipping the pre-deploy backup"
fi

# --- pull --------------------------------------------------------------------
log "Pulling images"
if ! compose pull --quiet; then
  die "image pull failed. Authenticate to the registry first:
     echo \$GITHUB_TOKEN | docker login ghcr.io -u Teestasarkar --password-stdin"
fi
ok "images pulled"

# --- deploy ------------------------------------------------------------------
# `up -d` recreates only what changed. Migrations run as part of the API's
# start command, so they are applied exactly once by exactly one service.
log "Starting the stack"
compose up -d --remove-orphans

# --- verify ------------------------------------------------------------------
log "Waiting for readiness (up to ${HEALTH_TIMEOUT_SECONDS}s)"

deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
healthy=false

while (( $(date +%s) < deadline )); do
  # The readiness endpoint returns 200 for ok *and* degraded (the risk service
  # may still be training its bootstrap model), and 503 when Postgres or Redis
  # is unreachable — which is exactly the distinction a deploy gate wants.
  if response="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)"; then
    status="$(echo "$response" | jq -r '.status' 2>/dev/null || echo unknown)"
    ok "readiness: $status"
    healthy=true
    break
  fi
  printf '.'
  sleep 5
done

echo

if [[ "$healthy" != true ]]; then
  warn "the stack did not become ready within ${HEALTH_TIMEOUT_SECONDS}s"
  echo
  echo "Recent logs:"
  compose logs --tail=40 api worker ml-service 2>&1 | sed 's/^/    /'
  echo

  if [[ "$ROLLBACK" == false && -n "$PREVIOUS_TAG" && "$PREVIOUS_TAG" != "$TARGET_TAG" ]]; then
    warn "rolling back to $PREVIOUS_TAG"
    IMAGE_TAG="$PREVIOUS_TAG" compose up -d --remove-orphans
    die "deploy failed and was rolled back to $PREVIOUS_TAG. See the logs above."
  fi

  die "deploy failed. Inspect with: docker compose -f $COMPOSE_FILE logs -f"
fi

# --- record state ------------------------------------------------------------
{
  echo "current=$TARGET_TAG"
  echo "previous=$PREVIOUS_TAG"
  echo "deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$STATE_FILE"

# --- housekeeping ------------------------------------------------------------
log "Pruning unused images"
docker image prune -f --filter "until=168h" >/dev/null 2>&1 || true

# --- summary -----------------------------------------------------------------
log "Deployed"
compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'

echo
ok "tag $TARGET_TAG is live"
echo "     app:    ${APP_URL:-http://localhost}"
echo "     health: $HEALTH_URL"
echo "     logs:   docker compose -f $COMPOSE_FILE logs -f"
echo "     back:   ./infra/ec2/deploy.sh --rollback"
echo
