#!/usr/bin/env bash
#
# Restore a backup made by backup.sh into a RUNNING stack (destructive: replaces data).
#   ./scripts/restore.sh backups/20260101T000000Z [--yes]
#
# Intended flow on a fresh VM: install.sh (or `docker compose up -d`) with the SAME .env
# secrets (copy env.backup over .env first — AI_ENCRYPTION_KEY / SSO_SECRETS_KEY must match),
# then run this. Order: stop writers -> Postgres -> ClickHouse (events first; materialized views
# rebuild derived tables) -> Garage -> start writers.

set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:?usage: restore.sh <backup-dir> [--yes]}"
[ -d "$SRC" ] || { echo "no such directory: $SRC" >&2; exit 1; }
SRC="$(cd "$SRC" && pwd)"
if [ "${2:-}" != "--yes" ]; then
  read -r -p "This REPLACES current Postgres/ClickHouse/Garage data with $SRC. Type 'restore' to continue: " ans
  [ "$ans" = "restore" ] || exit 1
fi

env_get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' || true; }
CH_PASS="$(env_get CLICKHOUSE_PASSWORD)"
ch() { docker compose exec -T clickhouse clickhouse-client --user clickroom --password "$CH_PASS" --database clickroom "$@"; }

echo "[restore] stopping writers"
ADMIN_WAS_UP=0
if docker compose --profile admin ps --status running --services 2>/dev/null | grep -qx admin; then ADMIN_WAS_UP=1; fi
docker compose stop caddy api capture ingest query web
[ "$ADMIN_WAS_UP" = 0 ] || docker compose --profile admin stop admin

echo "[restore] postgres"
docker compose exec -T postgres psql -U clickroom -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS clickroom WITH (FORCE)" -c "CREATE DATABASE clickroom OWNER clickroom"
docker compose exec -T postgres pg_restore -U clickroom -d clickroom --no-owner --exit-on-error < "$SRC/postgres.dump"

echo "[restore] clickhouse (schema comes from migrations; data from the export)"
docker compose run --rm migrate
CODEC="$(cat "$SRC/clickhouse/_codec.txt" 2>/dev/null || echo gzip)"
decompress() { if [ "$CODEC" = zstd ]; then zstd -dc; else gzip -dc; fi; }
SKIPPED="$(cat "$SRC/clickhouse/_skipped.txt" 2>/dev/null || true)"
# events first: its materialized views repopulate flag/survey/support tables.
ORDER="events $(grep -vx events "$SRC/clickhouse/_tables.txt" || true)"
for t in $ORDER; do
  f="$SRC/clickhouse/$t.native.z"
  [ -f "$f" ] || continue
  printf '%s\n' "$SKIPPED" | grep -qx "$t" && continue
  echo "  $t"
  ch --query "TRUNCATE TABLE IF EXISTS clickroom.\`$t\`"
  # An empty table exports to a zero-row Native stream; INSERT would fail with NO_DATA_TO_INSERT.
  if [ -z "$(decompress < "$f" 2>/dev/null | head -c 1 | od -An -tx1 | tr -d ' \n')" ]; then echo "    (empty)"; continue; fi
  decompress < "$f" | ch --query "INSERT INTO clickroom.\`$t\` FORMAT Native"
done

echo "[restore] garage"
if [ -f "$SRC/garage/garage.tar.gz" ]; then
  # Replace the meta + data volumes wholesale (they carry layout, bucket and key too), then let
  # garage-init (idempotent) re-assert bucket/key/CORS from .env.
  docker compose --profile storage stop garage
  docker compose --profile storage run --rm --no-deps -T -v "$SRC/garage:/backup:ro" --entrypoint /bin/sh garage-init \
    -c 'find /mnt/meta /mnt/data -mindepth 1 -delete && tar -C /mnt -xzf /backup/garage.tar.gz'
  docker compose --profile storage up -d garage
  docker compose --profile storage run --rm garage-init
fi

echo "[restore] starting services"
docker compose up -d
[ "$ADMIN_WAS_UP" = 0 ] || docker compose --profile admin up -d admin
echo "[restore] done"
