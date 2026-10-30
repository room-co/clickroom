#!/usr/bin/env bash
# scripts/e2e-down.sh — stop the e2e services started by scripts/e2e-up.sh.
# Only touches .e2e/* pidfiles and the e2e alt ports — never touches the
# dev docker containers or `.dev/*` pidfiles from `make up`.
#
# Usage: make down:e2e                     (stop services, keep clickroom_e2e data)
#        bash scripts/e2e-down.sh --wipe   (also drop clickroom_e2e postgres + clickhouse DBs —
#                                            `make` targets can't forward flags, so call the
#                                            script directly for --wipe)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env.e2e"
RUN_DIR=".e2e"
PG_CONTAINER="clickroom-postgres"
PG_USER="clickroom"
PG_DB="clickroom_e2e"

WIPE=false
for arg in "$@"; do
  case "$arg" in
    --wipe) WIPE=true ;;
  esac
done

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
fi

echo "── stopping e2e services ────────────────────────────────────────────"
for name in capture ingest query api; do
  pidfile="$RUN_DIR/$name.pid"
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && echo "  stopped $name (pid $pid)"
    fi
    rm -f "$pidfile"
  fi
done

echo "── clearing orphan ports ────────────────────────────────────────────"
for port in "${CAPTURE_PORT:-3101}" "${API_PORT:-3100}" "${WEB_PORT:-5273}" "${QUERY_PORT:-3102}"; do
  lsof -ti:"$port" | xargs kill -9 2>/dev/null || true
done

if [ "$WIPE" = "true" ]; then
  echo "── wiping e2e data (--wipe) ─────────────────────────────────────────"

  if docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" >/dev/null 2>&1; then
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${PG_DB}'" >/dev/null 2>&1 || true
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c \
      "DROP DATABASE IF EXISTS ${PG_DB}" >/dev/null 2>&1 \
      && echo "  dropped postgres database ${PG_DB}" \
      || echo "  warning: could not drop postgres database ${PG_DB}"
  else
    echo "  warning: $PG_CONTAINER not running — skipping postgres drop"
  fi

  CH_URL="${CLICKHOUSE_URL:-http://localhost:8123}"
  CH_USER="${CLICKHOUSE_USER:-clickroom}"
  CH_PASSWORD="${CLICKHOUSE_PASSWORD:-clickroom}"
  CH_DB="${CLICKHOUSE_DATABASE:-clickroom_e2e}"
  if curl -sf -u "${CH_USER}:${CH_PASSWORD}" "$CH_URL" \
      --data-binary "DROP DATABASE IF EXISTS ${CH_DB}" >/dev/null; then
    echo "  dropped clickhouse database ${CH_DB}"
  else
    echo "  warning: could not drop clickhouse database ${CH_DB}"
  fi
else
  echo "  (data kept — clickroom_e2e postgres/clickhouse DBs left in place; pass --wipe to drop)"
fi

echo ""
echo "clickroom e2e down (dev stack + 'make up' pids untouched)"
