#!/bin/sh
# Idempotent Garage bootstrap (runs in the curlimages/curl container; busybox sh, no jq).
# Talks to the Garage admin API v2 for layout/bucket/key and to the S3 API (SigV4 via curl) for CORS.
set -eu

A="$GARAGE_ADMIN_URL/v2"
auth="Authorization: Bearer $GARAGE_ADMIN_TOKEN"
log() { echo "[garage-init] $*"; }

# api METHOD PATH [JSON] -> body on stdout, fails on HTTP >= 400 (409 on create calls is handled by callers).
api() {
  if [ -n "${3:-}" ]; then
    curl -sS -X "$1" -H "$auth" -H 'Content-Type: application/json' -d "$3" -w '\n%{http_code}' "$A$2"
  else
    curl -sS -X "$1" -H "$auth" -w '\n%{http_code}' "$A$2"
  fi
}
code_of() { printf '%s' "$1" | tail -n 1; }
body_of() { printf '%s' "$1" | sed '$d'; }
# Extract the first string/number value for a JSON key from a body.
jstr() { printf '%s' "$2" | tr -d '\n ' | grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
jnum() { printf '%s' "$2" | tr -d '\n ' | grep -o "\"$1\":[0-9]*" | head -1 | cut -d: -f2; }
must() { # must LABEL RESPONSE -> exit unless 2xx
  case "$(code_of "$2")" in 2??) ;; *) log "$1 failed: HTTP $(code_of "$2") $(body_of "$2")"; exit 1 ;; esac
}

# 1. Wait for the admin API.
i=0
until curl -fsS -H "$auth" "$A/GetClusterStatus" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -le 60 ] || { log "admin API did not come up"; exit 1; }
  sleep 1
done

# 2. Layout: assign this node once (no role yet => assign + apply).
status="$(curl -fsS -H "$auth" "$A/GetClusterStatus" | tr -d '\n ')"
node_id="$(jstr id "$status")"
case "$status" in
  *'"role":{'*) log "layout already assigned" ;;
  *)
    log "assigning layout to node $node_id"
    r="$(api POST /UpdateClusterLayout "{\"roles\":[{\"id\":\"$node_id\",\"zone\":\"dc1\",\"capacity\":10000000000,\"tags\":[]}]}")"; must UpdateClusterLayout "$r"
    ver="$(jnum version "$(body_of "$r")")"
    r="$(api POST /ApplyClusterLayout "{\"version\":$((ver + 1))}")"; must ApplyClusterLayout "$r"
    ;;
esac

# 3. Bucket (create if the alias is unknown).
r="$(api GET "/GetBucketInfo?globalAlias=$S3_BUCKET")"
if [ "$(code_of "$r")" != 200 ]; then
  log "creating bucket $S3_BUCKET"
  r="$(api POST /CreateBucket "{\"globalAlias\":\"$S3_BUCKET\"}")"; must CreateBucket "$r"
fi
bucket_id="$(jstr id "$(body_of "$r")")"

# 4. Access key from .env (import; already-exists is fine).
r="$(api GET "/GetKeyInfo?id=$S3_ACCESS_KEY_ID")"
if [ "$(code_of "$r")" != 200 ]; then
  log "importing access key $S3_ACCESS_KEY_ID"
  r="$(api POST /ImportKey "{\"accessKeyId\":\"$S3_ACCESS_KEY_ID\",\"secretAccessKey\":\"$S3_SECRET_ACCESS_KEY\",\"name\":\"clickroom\"}")"; must ImportKey "$r"
fi

# 5. Grant read/write on the bucket (idempotent).
r="$(api POST /AllowBucketKey "{\"bucketId\":\"$bucket_id\",\"accessKeyId\":\"$S3_ACCESS_KEY_ID\",\"permissions\":{\"read\":true,\"write\":true,\"owner\":false}}")"; must AllowBucketKey "$r"

# 6. CORS for browser PUT/GET from any origin (the presigned URL is the credential).
# PutBucketCors needs the owner flag: grant it just for this step, then drop it again.
r="$(api POST /AllowBucketKey "{\"bucketId\":\"$bucket_id\",\"accessKeyId\":\"$S3_ACCESS_KEY_ID\",\"permissions\":{\"owner\":true}}")"; must AllowBucketKey-owner "$r"
cat > /tmp/cors.xml <<XML
<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>
XML
code="$(curl -sS -o /tmp/cors.out -w '%{http_code}' -X PUT --aws-sigv4 "aws:amz:$AWS_REGION:s3" \
  --user "$S3_ACCESS_KEY_ID:$S3_SECRET_ACCESS_KEY" -H 'Content-Type: application/xml' \
  --data-binary @/tmp/cors.xml "$GARAGE_S3_URL/$S3_BUCKET?cors")"
r="$(api POST /DenyBucketKey "{\"bucketId\":\"$bucket_id\",\"accessKeyId\":\"$S3_ACCESS_KEY_ID\",\"permissions\":{\"owner\":true}}")"; must DenyBucketKey-owner "$r"
[ "$code" = 200 ] || [ "$code" = 204 ] || { log "PutBucketCors failed: HTTP $code $(cat /tmp/cors.out)"; exit 1; }

log "ready: bucket=$S3_BUCKET key=$S3_ACCESS_KEY_ID region=$AWS_REGION"
