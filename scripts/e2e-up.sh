#!/usr/bin/env bash
# scripts/e2e-up.sh — bring up the isolated e2e stack (capture/ingest/api) on
# alt ports, reusing the SAME docker containers as `make up` (postgres,
# clickhouse, nats, redis) but pointed at isolated logical resources
# (clickroom_e2e DBs, EVENTS_E2E NATS stream). Coexists with a running dev
# stack — does NOT start/stop docker compose and does NOT touch `.dev/*`.
#
# Usage: make up:e2e   (or: bash scripts/e2e-up.sh)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env.e2e"
RUN_DIR=".e2e"
PG_CONTAINER="clickroom-postgres"
PG_USER="clickroom"
PG_DB="clickroom_e2e"

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found at repo root" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

mkdir -p "$RUN_DIR"

echo "── checking shared docker infra ─────────────────────────────────────"

require_container_healthy() {
  local name="$1"
  if ! docker inspect -f '{{.State.Running}}' "$name" >/dev/null 2>&1; then
    echo "error: container '$name' is not running — run 'make infra:up' first" >&2
    exit 1
  fi
}

require_container_healthy "$PG_CONTAINER"
require_container_healthy "clickroom-clickhouse"
require_container_healthy "clickroom-nats"
require_container_healthy "clickroom-redis"

if ! docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" >/dev/null 2>&1; then
  echo "error: postgres container is running but not ready — run 'make infra:up' first" >&2
  exit 1
fi

echo "  shared infra is up"

echo "── provisioning clickroom_e2e postgres database ─────────────────────"

db_exists="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'")"
if [ "$db_exists" = "1" ]; then
  echo "  $PG_DB already exists"
else
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "CREATE DATABASE ${PG_DB}"
  echo "  created $PG_DB"
fi

echo "── applying postgres migrations (clickroom_e2e) ─────────────────────"
pnpm --filter @clickroom/db prisma:generate
DATABASE_URL="$DATABASE_URL" pnpm --filter @clickroom/db exec prisma migrate deploy

echo "── applying clickhouse migrations ($CLICKHOUSE_DATABASE) ────────────"
CLICKHOUSE_DATABASE="$CLICKHOUSE_DATABASE" pnpm --filter @clickroom/clickhouse migrate

echo "── seeding e2e fixtures ──────────────────────────────────────────────"
DATABASE_URL="$DATABASE_URL" pnpm --filter @clickroom/db seed:e2e

echo "── clearing stale ports ─────────────────────────────────────────────"
for port in "$CAPTURE_PORT" "$API_PORT" "$WEB_PORT" "$QUERY_PORT"; do
  lsof -ti:"$port" | xargs kill -9 2>/dev/null || true
done

echo "── starting e2e services ────────────────────────────────────────────"

start_service() {
  local name="$1"
  shift
  local pidfile="$RUN_DIR/$name.pid"
  local logfile="$RUN_DIR/$name.log"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "  $name already running (pid $(cat "$pidfile"))"
    return
  fi
  echo "  starting $name → $logfile"
  ( "$@" >"$logfile" 2>&1 & echo $! >"$pidfile" )
}

wait_for_health() {
  local label="$1"
  local url="$2"
  local ready=false
  for i in $(seq 1 60); do
    if curl -sf "$url" >/dev/null 2>&1; then
      ready=true
      break
    fi
    printf '.'
    sleep 1
  done
  echo ""
  if [ "$ready" != "true" ]; then
    echo "error: $label did not become healthy within 60s — check $RUN_DIR/*.log" >&2
    exit 1
  fi
}

start_service capture cargo run -p capture

# ingest's durable consumer does a plain `get_stream` (no create) — it must
# not start until capture's `ensure_stream` (get-or-create) has actually run,
# or it races capture's first boot / cargo compile and crashes with
# "stream not found". Wait for capture's own health endpoint first.
echo "── waiting for capture health (:$CAPTURE_PORT) ───────────────────────"
wait_for_health "capture" "http://localhost:${CAPTURE_PORT}/health"

start_service ingest cargo run -p ingest
start_service query cargo run -p query
start_service api pnpm --filter @clickroom/api dev

echo "── waiting for query health (:$QUERY_PORT) ───────────────────────────"
wait_for_health "query" "http://localhost:${QUERY_PORT}/health"

echo "── waiting for api health (:$API_PORT) ──────────────────────────────"
wait_for_health "api" "http://localhost:${API_PORT}/health"

echo ""
echo "clickroom e2e up:"
echo "   api       http://localhost:${API_PORT}/health"
echo "   capture   http://localhost:${CAPTURE_PORT}/health"
echo "   query     http://localhost:${QUERY_PORT}/health"
echo "   ingest    (no port — NATS ${CAPTURE_STREAM_NAME} → clickhouse ${CLICKHOUSE_DATABASE})"
echo "   web       (not started here — Playwright's webServer starts vite on :${WEB_PORT})"
echo "   postgres  ${PG_DB}@localhost:5433 · clickhouse ${CLICKHOUSE_DATABASE}@localhost:8123"
echo "   logs      tail -f ${RUN_DIR}/*.log   ·   stop   make down:e2e"
