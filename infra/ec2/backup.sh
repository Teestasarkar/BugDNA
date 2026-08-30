#!/usr/bin/env bash
# =============================================================================
# pg_dump the database
# =============================================================================
# Run nightly by cron (installed by bootstrap.sh) and before every deploy.
#
# A backup sitting on the same EBS volume as the database is not a backup. Set
# BACKUP_S3_BUCKET to have it copied off the instance.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
DB_USER="${POSTGRES_USER:-bugdna}"
DB_NAME="${POSTGRES_DB:-bugdna}"

# Load POSTGRES_* from .env when present.
if [[ -f .env ]]; then
  DB_USER="$(grep -E '^POSTGRES_USER=' .env | tail -1 | cut -d= -f2- || echo "$DB_USER")"
  DB_NAME="$(grep -E '^POSTGRES_DB=' .env | tail -1 | cut -d= -f2- || echo "$DB_NAME")"
fi

mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_DIR}/bugdna-${STAMP}.sql.gz"

echo "==> Dumping ${DB_NAME} to ${TARGET}"

# --clean --if-exists makes the dump restorable over an existing database.
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists \
  | gzip -9 > "$TARGET"

SIZE="$(du -h "$TARGET" | cut -f1)"
echo "==> Wrote ${TARGET} (${SIZE})"

# A zero-length dump means pg_dump failed inside the pipe; gzip would still
# have exited 0, so check explicitly.
if [[ ! -s "$TARGET" ]]; then
  echo "backup is empty - pg_dump failed" >&2
  rm -f "$TARGET"
  exit 1
fi

if [[ -n "${BACKUP_S3_BUCKET:-}" ]] && command -v aws >/dev/null 2>&1; then
  echo "==> Copying to s3://${BACKUP_S3_BUCKET}/"
  aws s3 cp "$TARGET" "s3://${BACKUP_S3_BUCKET}/" --only-show-errors
fi

echo "==> Pruning local backups older than ${RETAIN_DAYS} days"
find "$BACKUP_DIR" -name 'bugdna-*.sql.gz' -mtime "+${RETAIN_DAYS}" -delete

echo "==> Current backups:"
ls -lh "$BACKUP_DIR" | tail -n +2 | awk '{print "    " $9, $5}'
