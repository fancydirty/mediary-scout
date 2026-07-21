#!/bin/sh
# Dump the compose Postgres volume to a timestamped file on the host.
# Usage (repo root): ./scripts/pg-backup.sh [output-dir]
set -eu
cd "$(dirname "$0")/.."
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT_DIR/mediatrack-${STAMP}.sql.gz"
echo "==> pg_dump → $FILE"
docker compose exec -T postgres pg_dump -U mediatrack -d mediatrack | gzip > "$FILE"
echo "==> OK ($(wc -c < "$FILE") bytes)"
echo "Restore: gunzip -c $FILE | docker compose exec -T postgres psql -U mediatrack -d mediatrack"
