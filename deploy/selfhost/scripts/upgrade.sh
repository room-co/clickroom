#!/usr/bin/env bash
#
# Upgrade a self-host install: pull -> migrate (first!) -> restart services.
#   ./scripts/upgrade.sh [target-version] [--force] [--no-refresh]   e.g. v0.2.1
#   (default target: the CLICKROOM_VERSION in .env)
#
# Also refreshes docker-compose.yml, Caddyfile, garage/ and scripts/ to the target version (old copies
# go to .bak/<timestamp>/; .env and docker-compose.override.yml are never touched). --no-refresh skips.
#
# Rule: migrations run BEFORE new service containers start. While 0.x, breaking changes land in
# minor versions, so this refuses to jump more than one minor at a time (--force to override).
# Back up first: ./scripts/backup.sh

set -euo pipefail
cd "$(dirname "$0")/.."

FORCE=0
NO_REFRESH=0
TARGET=""
for a in "$@"; do
  case "$a" in --force) FORCE=1 ;; --no-refresh) NO_REFRESH=1 ;; -*) echo "unknown option $a" >&2; exit 1 ;; *) TARGET="$a" ;; esac
done
[ -f .env ] || { echo "no .env here — run from a Clickroom install" >&2; exit 1; }

env_get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' || true; }
CURRENT="$(env_get CLICKROOM_VERSION)"; CURRENT="${CURRENT:-latest}"
TARGET="${TARGET:-$CURRENT}"

semver_parts() { printf '%s' "${1#v}" | awk -F'[.-]' '{print $1, $2, $3}'; }

guard_versions() {
  case "$CURRENT$TARGET" in *latest*) echo "[upgrade] 'latest' in use — skipping version-skip check"; return 0 ;; esac
  read -r cm cn _ <<<"$(semver_parts "$CURRENT")"
  read -r tm tn _ <<<"$(semver_parts "$TARGET")"
  if [ "$tm" != "$cm" ] || [ $((tn - cn)) -gt 1 ] || [ "$tn" -lt "$cn" ]; then
    if [ "$FORCE" = 0 ]; then
      echo "[upgrade] refusing $CURRENT -> $TARGET: upgrade one minor at a time (0.$cn -> 0.$((cn+1)) ...), never downgrade or change major. Use --force to override." >&2
      exit 1
    fi
  fi
}

set_version() {
  local tmp; tmp="$(mktemp)"
  awk -v v="$1" 'BEGIN{FS=OFS="="} $1=="CLICKROOM_VERSION" {print "CLICKROOM_VERSION=" v; d=1; next} {print} END{if(!d) print "CLICKROOM_VERSION=" v}' .env > "$tmp"
  cat "$tmp" > .env; rm -f "$tmp"
}

FILES=(install.sh docker-compose.yml docker-compose.build.yml Caddyfile .env.example clickhouse/memory.xml nats/nats-server.conf garage/garage.toml garage/init.sh
  scripts/backup.sh scripts/restore.sh scripts/upgrade.sh scripts/smoke-test.sh)

# Download the stack files for $TARGET (all-or-nothing), back up what differs, then swap them in.
refresh_files() {
  local ref="$TARGET" base tmp bak f n=0
  [ "$ref" = latest ] && ref=main
  base="${CLICKROOM_RAW_BASE:-https://raw.githubusercontent.com/room-co/clickroom/$ref/deploy/selfhost}"
  tmp="$(mktemp -d)"; bak=".bak/$(date +%Y%m%dT%H%M%S)"
  echo "[upgrade] refreshing stack files from $base"
  for f in "${FILES[@]}"; do
    mkdir -p "$tmp/$(dirname "$f")"
    curl -fsSL "$base/$f" -o "$tmp/$f" || { rm -rf "$tmp"; echo "[upgrade] could not download $base/$f (nothing changed). Check the version exists, or use --no-refresh." >&2; exit 1; }
  done
  for f in "${FILES[@]}"; do
    if [ -f "$f" ] && cmp -s "$tmp/$f" "$f"; then continue; fi
    if [ -f "$f" ]; then mkdir -p "$bak/$(dirname "$f")"; cp -p "$f" "$bak/$f"; fi
    mkdir -p "$(dirname "$f")"; mv "$tmp/$f" "$f"; n=$((n + 1)); echo "[upgrade]   updated $f"
  done
  rm -rf "$tmp"
  chmod +x install.sh scripts/*.sh garage/init.sh
  [ "$n" = 0 ] || echo "[upgrade] previous versions saved in $bak"
}

guard_versions
[ "$NO_REFRESH" = 1 ] || refresh_files
echo "[upgrade] $CURRENT -> $TARGET (changelog: https://github.com/room-co/clickroom/releases)"
PREV="$CURRENT"
set_version "$TARGET"

docker compose pull
echo "[upgrade] running migrations"
if ! docker compose run --rm migrate; then
  set_version "$PREV"
  echo "[upgrade] migration FAILED; .env reset to $PREV and services were NOT restarted. Restore from backup if the schema is half-applied." >&2
  exit 1
fi
echo "[upgrade] restarting services"
docker compose up -d --remove-orphans
docker compose ps
echo "[upgrade] done. Verify with ./scripts/smoke-test.sh"
