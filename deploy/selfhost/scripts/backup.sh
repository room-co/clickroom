#!/usr/bin/env bash
#
# Back up a self-host install into ./backups/<timestamp>/ (override with BACKUP_DIR=...).
#   Postgres    pg_dump (custom format)
#   ClickHouse  per-table FORMAT Native export, zstd-compressed. Tables fed by materialized views
#               are skipped: they are rebuilt from `events` on restore.
#   Garage      tar of the meta + data volumes (Garage is stopped for a few seconds for a consistent copy)
#   NATS        NOT backed up: the JetStream EVENTS stream is a short-lived buffer (default 72 h)
#               between capture and ClickHouse. Events accepted but not yet ingested at backup
#               time (normally seconds) are lost on restore — that is the stated RPO.
# Also copies .env (secrets) — store the backup somewhere safe.

set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env here" >&2; exit 1; }

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR:-./backups}/$TS"
mkdir -p "$OUT/clickhouse"
chmod 700 "$OUT"

env_get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' || true; }
CH_PASS="$(env_get CLICKHOUSE_PASSWORD)"

ch() { docker compose exec -T clickhouse clickhouse-client --user clickroom --password "$CH_PASS" --database clickroom "$@"; }

echo "[backup] postgres"
docker compose exec -T postgres pg_dump -U clickroom -Fc clickroom > "$OUT/postgres.dump"

echo "[backup] clickhouse"
# Targets of materialized views (`CREATE MATERIALIZED VIEW x TO db.target`) — derived, skipped.
MV_TARGETS="$(ch --query "SELECT create_table_query FROM system.tables WHERE database='clickroom' AND engine='MaterializedView'" \
  | grep -oE ' TO [A-Za-z0-9_.]+' | sed -E 's/^ TO ([A-Za-z0-9_]+\.)?//' | sort -u || true)"
TABLES="$(ch --query "SELECT name FROM system.tables WHERE database='clickroom' AND engine NOT IN ('View','MaterializedView') AND name NOT LIKE '.inner%' ORDER BY name")"
for t in $TABLES; do
  if printf '%s\n' "$MV_TARGETS" | grep -qx "$t"; then echo "  skip $t (derived)"; continue; fi
  echo "  $t"
  ch --query "SELECT * FROM clickroom.\`$t\` FORMAT Native" | { command -v zstd >/dev/null && zstd -q -T0 || gzip; } > "$OUT/clickhouse/$t.native.z"
done
printf '%s\n' "$TABLES" > "$OUT/clickhouse/_tables.txt"
printf '%s\n' "$MV_TARGETS" > "$OUT/clickhouse/_skipped.txt"
{ command -v zstd >/dev/null && echo zstd || echo gzip; } > "$OUT/clickhouse/_codec.txt"

if docker compose ps --status running --services 2>/dev/null | grep -qx garage; then
  echo "[backup] garage (stopping briefly for a consistent copy)"
  mkdir -p "$OUT/garage"
  docker compose --profile storage stop garage
  # garage-init mounts both Garage volumes; its curl image ships busybox tar.
  if docker compose --profile storage run --rm --no-deps -T -v "$(cd "$OUT/garage" && pwd):/backup" --entrypoint /bin/sh garage-init \
    -c 'tar -C /mnt -czf /backup/garage.tar.gz meta data'; then :; else
    echo "[backup] WARNING: garage volume archive failed" >&2
  fi
  docker compose --profile storage start garage
else
  echo "[backup] garage not running (attachments storage disabled) — skipped"
fi

cp .env "$OUT/env.backup"; chmod 600 "$OUT/env.backup"
echo "[backup] done: $OUT"
