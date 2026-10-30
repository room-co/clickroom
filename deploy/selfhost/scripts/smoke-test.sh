#!/usr/bin/env bash
#
# End-to-end smoke test of a running stack.
#   1. /health of web (via edge), api, capture (via /capture)
#   2. POST one event through the edge to /capture/v1/capture
#   3. read it back from ClickHouse (polls up to 60 s)
#   4. if SUPPORT_ATTACHMENTS_BUCKET is set (storage profile): presign -> PUT -> GET through the edge
#
# Step 2-3 need a project write key. Resolution order:
#   1. CLICKROOM_WRITE_KEY=... in the environment
#   2. the oldest live write key already in Postgres (create a project/key in the dashboard first)
#   3. SMOKE_BOOTSTRAP=1: sign up an owner on an EMPTY instance (first_user_only) and mint a key
#      (CI uses this; do not use it on an instance you care about)
# With no key only step 1 runs and the script exits 0 with a notice. BASE_URL overrides the edge (default: CLICKROOM_PUBLIC_URL from .env, else http://localhost:${HTTP_PORT:-80}).

set -euo pipefail
cd "$(dirname "$0")/.."

env_get() { [ -f .env ] && grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' || true; }
# Default to the public URL from .env (the domain you installed with); fall back to localhost:HTTP_PORT.
PUBLIC_URL="$(env_get CLICKROOM_PUBLIC_URL || true)"
case "$PUBLIC_URL" in
  ""|http://localhost|http://localhost/) BASE_URL="${BASE_URL:-http://localhost:$(env_get HTTP_PORT || true)}" ;;
  *) BASE_URL="${BASE_URL:-${PUBLIC_URL%/}}" ;;
esac
case "$BASE_URL" in *:) BASE_URL="${BASE_URL}80" ;; esac
KEY="${CLICKROOM_WRITE_KEY:-}"
CH_PASS="$(env_get CLICKHOUSE_PASSWORD)"
fail() { echo "[smoke] FAIL: $*" >&2; exit 1; }

echo "[smoke] edge $BASE_URL"
curl -fsS --max-time 10 "$BASE_URL/health" >/dev/null || fail "api /health via edge"
curl -fsS --max-time 10 "$BASE_URL/capture/health" >/dev/null || fail "capture /health via edge"
curl -fsS --max-time 10 "$BASE_URL/" >/dev/null || fail "web /"
curl -fsS --max-time 10 "$BASE_URL/config.js" | grep -q __CLICKROOM_CONFIG__ || fail "web /config.js not rendered"
echo "[smoke] health ok"

json_field() { sed -nE "s/.*\"$1\":\"([^\"]+)\".*/\1/p" | head -1; }

if [ -z "$KEY" ]; then
  KEY="$(docker compose exec -T postgres psql -U clickroom -d clickroom -Atc \
    "SELECT \"publicToken\" FROM \"ApiKey\" WHERE type='write' AND \"revokedAt\" IS NULL AND \"publicToken\" IS NOT NULL ORDER BY \"createdAt\" LIMIT 1" 2>/dev/null | tr -d '[:space:]' || true)"
fi
if [ -z "$KEY" ] && [ "${SMOKE_BOOTSTRAP:-0}" = 1 ]; then
  echo "[smoke] bootstrapping owner + project + write key"
  PW="$(openssl rand -hex 12)Aa1"
  resp=$(curl -fsS --max-time 20 -X POST "$BASE_URL/trpc/auth.signup" -H 'content-type: application/json' \
    -d "{\"email\":\"smoke@example.com\",\"password\":\"$PW\",\"orgName\":\"Smoke\"}") || fail "owner signup (instance not empty?)"
  TOKEN="$(printf '%s' "$resp" | json_field accessToken)"
  AUTH="authorization: Bearer $TOKEN"
  PID="$(curl -fsS --max-time 10 "$BASE_URL/trpc/projects.list" -H "$AUTH" | json_field id)"
  KEY="$(curl -fsS --max-time 10 -X POST "$BASE_URL/trpc/projects.keys.create" -H "$AUTH" -H 'content-type: application/json' \
    -d "{\"projectId\":\"$PID\",\"type\":\"write\"}" | json_field token)"
fi

[ -n "$KEY" ] || { echo "[smoke] no write key found — skipping event round-trip"; exit 0; }

DID="smoke-$(date +%s)-$RANDOM"
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$BASE_URL/capture/v1/capture" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d "{\"batch\":[{\"event\":\"smoke_test\",\"distinct_id\":\"$DID\",\"properties\":{\"source\":\"smoke-test.sh\"}}]}")
case "$code" in 2??) ;; *) fail "capture returned HTTP $code" ;; esac
echo "[smoke] event accepted ($DID)"

found=0
for _ in $(seq 1 30); do
  n=$(docker compose exec -T clickhouse clickhouse-client --user clickroom --password "$CH_PASS" --database clickroom \
      --query "SELECT count() FROM events WHERE distinct_id='$DID'" 2>/dev/null || echo 0)
  if [ "${n:-0}" -ge 1 ]; then found=1; echo "[smoke] event found in ClickHouse — OK"; break; fi
  sleep 2
done
[ "$found" = 1 ] || fail "event not in ClickHouse after 60 s (check: docker compose logs ingest capture)"

# Attachments round trip (bundled Garage): the presigned URL is signed for the public origin, so the
# PUT goes through the edge with exactly the signed headers; GET back is SigV4-signed with the .env key.
if [ -n "$(env_get SUPPORT_ATTACHMENTS_BUCKET)" ]; then
  region="$(env_get AWS_REGION)"; region="${region:-us-east-1}"
  tmp="$(mktemp)"; got="$(mktemp)"; printf 'smoke attachment %s\n' "$DID" > "$tmp"
  size="$(wc -c < "$tmp" | tr -d ' ')"
  url="$(curl -fsS --max-time 15 -X POST "$BASE_URL/capture/v1/support/attachments/presign" \
    -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d "{\"filename\":\"smoke.txt\",\"content_type\":\"text/plain\",\"size_bytes\":$size}" | json_field url)" || fail "attachment presign"
  [ -n "$url" ] || fail "presign returned no url"
  code=$(curl -sS -k -o /dev/null -w '%{http_code}' --max-time 20 -X PUT -H 'Content-Type: text/plain' --data-binary @"$tmp" "$url") || true
  [ "$code" = 200 ] || fail "attachment PUT returned HTTP $code (S3_PUBLIC_ENDPOINT must be reachable from here)"
  curl -fsS -k --max-time 20 --aws-sigv4 "aws:amz:$region:s3" \
    --user "$(env_get S3_ACCESS_KEY_ID):$(env_get S3_SECRET_ACCESS_KEY)" "${url%%\?*}" -o "$got" || fail "attachment GET"
  cmp -s "$tmp" "$got" || fail "attachment bytes differ after round trip"
  rm -f "$tmp" "$got"
  echo "[smoke] attachment PUT/GET round trip — OK"
fi
exit 0
