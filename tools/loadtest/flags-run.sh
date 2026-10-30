#!/usr/bin/env bash
# Feature-flag evaluation load test: seed → drive POST /flags at load → assert
# determinism + p95 under sustained concurrency → teardown.
#
# Seeds a dedicated throwaway bench project (3 flags: boolean %, multivariate,
# property-targeted) + a write/read key + the Redis def cache, runs k6 against
# `POST /flags`, then asserts (via k6 thresholds) that EVERY request was 200,
# deterministic (matches the id's ground-truth captured in setup), and that p95
# stayed under the limit. Always tears the bench project down on exit.
#
# Usage:
#   tools/loadtest/flags-run.sh [--rps N] [--duration 2m] [--pool N] [--p95 25] [--manage]
#
#   --rps N       target requests/second        (default 3000)
#   --duration D  k6 duration (e.g. 30s, 2m)     (default 2m)
#   --pool N      distinct_id pool size          (default 2000)
#   --p95 MS      max acceptable p95 latency ms  (default 25)
#   --manage      build + start a fresh release capture on :3001 and stop it after
#                 (default: use the already-running capture-rs)
#
# Requires: k6, node, curl. capture-rs + docker-compose infra (pg :5433, redis :6380).
set -euo pipefail

RPS=3000
DURATION=2m
POOL=2000
P95=25
MANAGE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rps) RPS="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --pool) POOL="$2"; shift 2 ;;
    --p95) P95="$2"; shift 2 ;;
    --manage) MANAGE=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

FLAGS_URL="${FLAGS_URL:-http://localhost:3001}"
export DATABASE_URL="${DATABASE_URL:-postgresql://clickroom:clickroom@localhost:5433/clickroom}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6380}"

CAP_PID=""
SEEDED=0
cleanup() {
  [[ "$SEEDED" == "1" ]] && node tools/loadtest/flags-seed.mjs teardown || true
  [[ -n "$CAP_PID" ]] && kill "$CAP_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "▶ flag-eval load: rps=${RPS} duration=${DURATION} pool=${POOL} p95<=${P95}ms manage=${MANAGE}"

# ── Optionally start a fresh release capture (rate limit lifted) ───────────
if [[ "$MANAGE" == "1" ]]; then
  echo "  building release capture..."
  cargo build --release -p capture >/dev/null 2>&1
  NATS_URL="${NATS_URL:-nats://localhost:4222}" REDIS_URL="$REDIS_URL" DATABASE_URL="$DATABASE_URL" \
    CAPTURE_PORT=3001 CAPTURE_RATE_LIMIT_BURST=100000000 CAPTURE_RATE_LIMIT_REFILL_PER_SEC=100000000 \
    RUST_LOG=warn ./target/release/capture >/tmp/flagload-capture.log 2>&1 &
  CAP_PID=$!
fi

# ── Preflight: capture health ─────────────────────────────────────────────
for i in $(seq 1 30); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "$FLAGS_URL/health" || true)" == "200" ]] && break
  sleep 0.5
  [[ $i == 30 ]] && { echo "capture not healthy at $FLAGS_URL — start it or pass --manage" >&2; exit 1; }
done

# ── Seed bench project + flags + keys + Redis blob ────────────────────────
ENVFILE="$(mktemp)"
node tools/loadtest/flags-seed.mjs setup --env-out "$ENVFILE" 2>/dev/null
SEEDED=1
# shellcheck disable=SC1090
set -a; . "$ENVFILE"; set +a
rm -f "$ENVFILE"
echo "  seeded token=${TOKEN} project=${PROJECT_ID} flags=${FLAG_KEYS}"

# ── Run k6 ────────────────────────────────────────────────────────────────
SUMMARY="$(mktemp)"
echo "  running k6 (capturing per-id baseline for pool=${POOL} then loading)..."
set +e
FLAGS_URL="$FLAGS_URL" TOKEN="$TOKEN" RPS="$RPS" DURATION="$DURATION" POOL="$POOL" P95_MAX="$P95" \
  SUMMARY_OUT="$SUMMARY" k6 run --quiet tools/loadtest/flags-load.js
K6_EXIT=$?
set -e

ND=$(node -e "try{const fs=require('fs');const d=JSON.parse(fs.readFileSync('$SUMMARY','utf8'));console.log((d.metrics.nondeterministic&&d.metrics.nondeterministic.values.count)||0)}catch(e){console.log('?')}" 2>/dev/null || echo '?')
rm -f "$SUMMARY"

echo "────────────────────────────────────────────"
if [[ "$K6_EXIT" == "0" ]]; then
  echo "  ✅ PASS — deterministic under load (nondeterministic=${ND}), p95 within ${P95}ms, all 200"
  exit 0
else
  echo "  ❌ FAIL — k6 thresholds breached (nondeterministic=${ND}); see output above"
  exit 1
fi
