#!/bin/sh
# Dump the compose Postgres volume to a timestamped file on the host.
# Usage (repo root): ./scripts/pg-backup.sh [output-dir]
set -eu
cd "$(dirname "$0")/.."
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT_DIR/mediatrack-${STAMP}.sql.gz"
# Template must end with X… (BSD/macOS mktemp requirement).
TMP="$(mktemp "${OUT_DIR}/mediatrack-${STAMP}.sql.XXXXXX")"
trap 'rm -f "$TMP"' EXIT INT TERM
echo "==> pg_dump → $FILE"
# Avoid pipe status masking: dump to temp first, then gzip (pg_dump failure aborts).
docker compose exec -T postgres pg_dump -U mediatrack -d mediatrack > "$TMP"
gzip -c "$TMP" > "$FILE"
echo "==> OK ($(wc -c < "$FILE") bytes)"
echo "Restore: gunzip -c \"$FILE\" | docker compose exec -T postgres psql -U mediatrack -d mediatrack"
