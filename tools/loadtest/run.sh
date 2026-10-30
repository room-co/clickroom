#!/usr/bin/env bash
# AC-2 load harness: drive load → drain → assert zero loss.
#
# Runs the full capture → NATS → ingest → ClickHouse pipeline at a target
# EVENTS/s for a DURATION, then asserts ClickHouse received exactly what capture
# accepted (zero accepted-then-lost). The assertion is delta-based (final minus a
# baseline snapshot), so it holds whether or not the table starts empty — load
# rows are ADDED to whatever is already there and are KEPT by default.
#
# Usage:
#   tools/loadtest/run.sh [--rate N] [--duration 5m] [--batch 100] [--no-manage] [--truncate]
#
#   --rate N        target events/second           (default 5000)
#   --duration D    k6 duration (e.g. 30s, 5m)      (default 5m)
#   --batch N       events per POST, <=100          (default 100)
#   --no-manage     use already-running services instead of starting release
#                   capture+ingest (default: this script starts+stops them)
#   --truncate      TRUNCATE the events table before AND after the run
#                   (default OFF — existing data is preserved)
#
# Requires: k6, cargo, psql, curl. Services use local docker-compose infra.
set -euo pipefail

# ── Params ────────────────────────────────────────────────────────────────
RATE=5000
DURATION=5m
BATCH=100
MANAGE=1
TRUNCATE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rate) RATE="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --batch) BATCH="$2"; shift 2 ;;
    --no-manage) MANAGE=0; shift ;;
    --truncate) TRUNCATE=1; shift ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# ── Config (env overridable) ──────────────────────────────────────────────
CAPTURE_URL="${CAPTURE_URL:-http://localhost:3001}"
CH_URL="${CLICKHOUSE_URL:-http://localhost:8123}"
CH_DB="${CLICKHOUSE_DATABASE:-clickroom}"
CH_USER="${CLICKHOUSE_USER:-clickroom}"
CH_PASS="${CLICKHOUSE_PASSWORD:-clickroom}"
NATS_URL="${NATS_URL:-nats://localhost:4222}"
REDIS_URL="${REDIS_URL:-redis://localhost:6380}"
DATABASE_URL="${DATABASE_URL:-postgresql://clickroom:clickroom@localhost:5433/clickroom}"
TOKEN="${TOKEN:-ckw_live_loadtest}"

# psql connection derived from DATABASE_URL host/port/user/db (dev compose).
PG_HOST="${PG_HOST:-localhost}"; PG_PORT="${PG_PORT:-5433}"
PG_USER="${PG_USER:-clickroom}"; PG_PW="${PG_PW:-clickroom}"; PG_DB="${PG_DB:-clickroom}"

ch() { curl -s -u "$CH_USER:$CH_PASS" "$CH_URL/?database=$CH_DB" --data-binary "$1"; }
ch_count() { ch 'SELECT count() FROM events'; }
psql_do() { PGPASSWORD="$PG_PW" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tAc "$1"; }

CAP_PID=""; ING_PID=""
cleanup() {
  [[ -n "$ING_PID" ]] && kill "$ING_PID" 2>/dev/null || true
  [[ -n "$CAP_PID" ]] && kill "$CAP_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "▶ AC-2 load: rate=${RATE} ev/s duration=${DURATION} batch=${BATCH} manage=${MANAGE}"

# ── Ensure a dedicated write key exists (idempotent, additive) ────────────
HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | awk '{print $1}')
PROJ=$(psql_do 'SELECT id FROM "Project" LIMIT 1;')
[[ -z "$PROJ" ]] && { echo "no Project in Postgres — seed first" >&2; exit 1; }
psql_do "INSERT INTO \"ApiKey\" (id,\"projectId\",\"keyHash\",\"keyPrefix\",type,label,\"createdAt\")
  VALUES ('loadtest_key','$PROJ','$HASH','ckw_live_lt','write','loadtest',CURRENT_TIMESTAMP)
  ON CONFLICT (\"keyHash\") DO NOTHING;" >/dev/null
echo "  project=$PROJ  token=$TOKEN"

# ── Start services (release) unless --no-manage ───────────────────────────
if [[ "$MANAGE" == "1" ]]; then
  echo "  building release capture+ingest..."
  cargo build --release -p capture -p ingest >/dev/null 2>&1
  # Rate limit lifted so the limiter doesn't cap the target rate.
  NATS_URL="$NATS_URL" REDIS_URL="$REDIS_URL" DATABASE_URL="$DATABASE_URL" \
    CAPTURE_PORT=3001 CAPTURE_RATE_LIMIT_BURST=100000000 CAPTURE_RATE_LIMIT_REFILL_PER_SEC=100000000 \
    RUST_LOG=warn ./target/release/capture >/tmp/loadtest-capture.log 2>&1 &
  CAP_PID=$!
  NATS_URL="$NATS_URL" CLICKHOUSE_URL="$CH_URL" CLICKHOUSE_USER="$CH_USER" \
    CLICKHOUSE_PASSWORD="$CH_PASS" CLICKHOUSE_DATABASE="$CH_DB" \
    INGEST_BATCH_MAX_SIZE=1000 INGEST_BATCH_MAX_WAIT_MS=500 RUST_LOG=info \
    ./target/release/ingest >/tmp/loadtest-ingest.log 2>&1 &
  ING_PID=$!
fi

# ── Preflight: wait for capture health + CH ───────────────────────────────
for i in $(seq 1 30); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "$CAPTURE_URL/health" || true)" == "200" ]] && break
  sleep 0.5
  [[ $i == 30 ]] && { echo "capture not healthy" >&2; exit 1; }
done
ch 'SELECT 1' >/dev/null || { echo "clickhouse unreachable" >&2; exit 1; }

# ── (optional truncate) → run → drain → assert ────────────────────────────
if [[ "$TRUNCATE" == "1" ]]; then
  echo "  truncate events (pre)"; ch 'TRUNCATE TABLE events' >/dev/null
fi
BASE=$(ch_count); echo "  baseline=$BASE"

SUMMARY=$(mktemp)
echo "  running k6..."
EVENTS_PER_SEC="$RATE" DURATION="$DURATION" BATCH="$BATCH" \
  CAPTURE_URL="$CAPTURE_URL" TOKEN="$TOKEN" SUMMARY_OUT="$SUMMARY" \
  k6 run --quiet tools/loadtest/capture-load.js || true

ACCEPTED=$(python3 -c "import json,sys;d=json.load(open('$SUMMARY'));print(int(d['metrics']['accepted_events']['values']['count']))" 2>/dev/null || echo 0)
echo "  accepted_by_capture=$ACCEPTED"
TARGET=$((BASE + ACCEPTED))

echo "  draining to ClickHouse (target=$TARGET)..."
STABLE=0; PREV=-1
for _ in $(seq 1 180); do
  sleep 2
  C=$(ch_count)
  [[ "$C" == "$PREV" ]] && STABLE=$((STABLE+1)) || STABLE=0
  PREV="$C"
  [[ "$C" -ge "$TARGET" && "$STABLE" -ge 2 ]] && break
done

FINAL=$(ch_count)
DELTA=$((FINAL - BASE))
LOST=$((TARGET - FINAL))
echo "────────────────────────────────────────────"
echo "  accepted=$ACCEPTED  ch_delta=$DELTA  lost=$LOST"
DLQ=$(curl -s "http://localhost:8222/jsz?streams=1" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    n=sum(s['state']['messages'] for a in d.get('account_details',[])
          for s in a.get('stream_detail',[]) if s.get('name')=='EVENTS_DLQ')
    print(n)
except Exception:
    print('?')" 2>/dev/null || echo '?')
echo "  dlq_messages=$DLQ"

if [[ "$TRUNCATE" == "1" ]]; then
  echo "  truncate events (post)"; ch 'TRUNCATE TABLE events' >/dev/null
fi
rm -f "$SUMMARY"

if [[ "$LOST" -le 0 && "$ACCEPTED" -gt 0 ]]; then
  echo "  ✅ AC-2 PASS — zero accepted-then-lost"
  exit 0
else
  echo "  ❌ AC-2 FAIL — lost=$LOST accepted=$ACCEPTED"
  exit 1
fi
