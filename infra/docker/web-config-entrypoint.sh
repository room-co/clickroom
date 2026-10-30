#!/bin/sh
#
# Renders /config.js from config.js.template at container start (nginx runs every
# executable /docker-entrypoint.d/*.sh before launching). This is what lets ONE prebuilt
# web/admin image be configured purely by environment:
#
#   CLICKROOM_API_ORIGIN    ""  = same-origin (/trpc on the page's own host) — the default
#   CLICKROOM_CAPTURE_HOST  ""  = same-origin /capture
#   CLICKROOM_DEPLOYMENT    self_host (default) | cloud
#   CLICKROOM_WRITE_KEY     ""  = dashboard self-analytics off
#
# Values are interpolated into JS string literals, so anything that could break out of one
# is refused rather than escaped.

set -eu

TEMPLATE=/etc/clickroom/config.js.template
OUT_DIR=/tmp/clickroom-config

CLICKROOM_API_ORIGIN="${CLICKROOM_API_ORIGIN-}"
CLICKROOM_CAPTURE_HOST="${CLICKROOM_CAPTURE_HOST-}"
CLICKROOM_DEPLOYMENT="${CLICKROOM_DEPLOYMENT:-self_host}"
CLICKROOM_WRITE_KEY="${CLICKROOM_WRITE_KEY-}"

NL='
'
for pair in \
  "CLICKROOM_API_ORIGIN=$CLICKROOM_API_ORIGIN" \
  "CLICKROOM_CAPTURE_HOST=$CLICKROOM_CAPTURE_HOST" \
  "CLICKROOM_DEPLOYMENT=$CLICKROOM_DEPLOYMENT" \
  "CLICKROOM_WRITE_KEY=$CLICKROOM_WRITE_KEY"; do
  case "$pair" in
    *\"* | *\\* | *"$NL"* | *"<"*)
      echo "[config] FATAL: ${pair%%=*} contains a quote, backslash, '<' or newline" >&2
      exit 1
      ;;
  esac
done

[ -f "$TEMPLATE" ] || { echo "[config] FATAL: $TEMPLATE missing" >&2; exit 1; }

mkdir -p "$OUT_DIR"
export CLICKROOM_API_ORIGIN CLICKROOM_CAPTURE_HOST CLICKROOM_DEPLOYMENT CLICKROOM_WRITE_KEY
envsubst '${CLICKROOM_API_ORIGIN} ${CLICKROOM_CAPTURE_HOST} ${CLICKROOM_DEPLOYMENT} ${CLICKROOM_WRITE_KEY}' \
  < "$TEMPLATE" > "$OUT_DIR/config.js"
echo "[config] rendered $OUT_DIR/config.js (deployment=$CLICKROOM_DEPLOYMENT)"
