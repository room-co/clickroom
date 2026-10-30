#!/usr/bin/env bash
#
# Clickroom self-host installer. Needs only Docker (with the compose plugin) and openssl.
#
#   curl -fsSL https://raw.githubusercontent.com/room-co/clickroom/main/deploy/selfhost/install.sh | bash
#
# What it does: checks the machine, asks ONE question (your domain; Enter = http://localhost),
# generates every secret, pulls the images, runs the database migrations, starts the stack,
# waits until it is healthy and prints the URL. Re-running is safe and IS the upgrade path:
# existing secrets and settings are kept; images are pulled and migrated before services restart.
#
# Usage: install.sh [--domain example.com] [--version v0.1.0] [--dir PATH] [--with-storage]
#                   [--with-admin] [--non-interactive] [--no-pull] [--no-refresh] [--help]
# Env:   CLICKROOM_DOMAIN, CLICKROOM_VERSION, CLICKROOM_REGISTRY, CLICKROOM_DIR (default ~/clickroom),
#        CLICKROOM_WITH_STORAGE=1, CLICKROOM_WITH_ADMIN=1,
#        CLICKROOM_RAW_BASE (where stack files are downloaded from when not run from a checkout;
#        default: the repo at the tag matching --version, or main for "latest").
# Files: <dir>/.env holds your secrets (chmod 600) - back it up.

set -euo pipefail

RAW_ROOT="https://raw.githubusercontent.com/room-co/clickroom"
FILES=(install.sh docker-compose.yml docker-compose.build.yml Caddyfile .env.example clickhouse/memory.xml nats/nats-server.conf garage/garage.toml garage/init.sh
  scripts/backup.sh scripts/restore.sh scripts/upgrade.sh scripts/smoke-test.sh)

NON_INTERACTIVE=0
NO_PULL=0
NO_REFRESH=0
WITH_STORAGE="${CLICKROOM_WITH_STORAGE:-0}"
WITH_ADMIN="${CLICKROOM_WITH_ADMIN:-0}"
DOMAIN="${CLICKROOM_DOMAIN:-}"
INSTALL_DIR="${CLICKROOM_DIR:-}"

usage() {
  cat <<'USAGE'
Clickroom self-host installer (requires Docker + compose plugin + openssl).

  curl -fsSL <url>/install.sh | bash
  install.sh [--domain example.com] [--version v0.1.0] [--dir PATH] [--with-storage] [--with-admin]
             [--non-interactive] [--no-pull] [--no-refresh]

  --domain D          public domain (automatic HTTPS). Omit for http://localhost.
  --version V         image tag to install/upgrade to (default: keep current, else latest).
  --dir PATH          install directory (default ~/clickroom).
  --non-interactive   never prompt (also implied when there is no terminal).
  --with-storage      enable support-ticket attachments (bundled Garage S3); writes the .env values.
  --with-admin        enable the admin console at admin.<domain> (needs a DNS record for it).
  --no-pull           use locally available images (air-gapped / locally built).
  --no-refresh        on a re-run, keep the existing compose/Caddy/scripts instead of downloading
                      the files that match the target version (replaced files go to <dir>/.bak/).

Re-run any time to upgrade: secrets, .env and docker-compose.override.yml are preserved, stack files
are refreshed to the target version, migrations run before restart.
Env: CLICKROOM_DOMAIN CLICKROOM_VERSION CLICKROOM_REGISTRY CLICKROOM_DIR CLICKROOM_RAW_BASE
     CLICKROOM_WITH_STORAGE=1 CLICKROOM_WITH_ADMIN=1
USAGE
}

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] ERROR: %s\n' "$1" >&2; [ -z "${2:-}" ] || printf '[install] Fix: %s\n' "$2" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --no-pull) NO_PULL=1 ;;
    --no-refresh) NO_REFRESH=1 ;;
    --with-storage) WITH_STORAGE=1 ;;
    --with-admin) WITH_ADMIN=1 ;;
    --domain) DOMAIN="${2:?--domain needs a value}"; shift ;;
    --dir) INSTALL_DIR="${2:?--dir needs a value}"; shift ;;
    --version) CLICKROOM_VERSION="${2:?--version needs a value}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

# `curl | bash` consumes stdin, so prompts read from the controlling terminal instead.
HAVE_TTY=0
if [ "$NON_INTERACTIVE" = 0 ] && { : </dev/tty; } 2>/dev/null; then HAVE_TTY=1; fi

check_prereqs() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed." "curl -fsSL https://get.docker.com | sh   (then re-run this script)"
  docker compose version >/dev/null 2>&1 || die "The 'docker compose' plugin is missing." "install docker-compose-plugin (https://docs.docker.com/compose/install/linux/)"
  docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon." "start Docker, or add your user to the docker group (sudo usermod -aG docker \$USER) and log in again"
  command -v openssl >/dev/null 2>&1 || die "openssl is missing (used to generate secrets)." "apt-get install -y openssl   (or your distro's equivalent)"
}

port_in_use() {
  if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"
  elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; fi
}

check_ports() {
  # Our own running stack legitimately holds the ports on a re-run.
  if (cd "$INSTALL_DIR" 2>/dev/null && docker compose ps -q caddy 2>/dev/null | grep -q .); then return; fi
  local http https
  http="$(env_get HTTP_PORT)"; http="${http:-80}"
  https="$(env_get HTTPS_PORT)"; https="${https:-443}"
  port_in_use "$http" && die "Port $http is already in use." "stop the other web server, or set HTTP_PORT=<free port> in $INSTALL_DIR/.env and re-run"
  case "$(env_get CADDY_SITE_ADDRESS)" in http://*) ;; *) port_in_use "$https" && die "Port $https is already in use." "stop the other web server, or set HTTPS_PORT=<free port> in $INSTALL_DIR/.env and re-run" ;; esac
}

check_resources() {
  local mem_kb disk_kb
  if [ -r /proc/meminfo ]; then
    mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
    if [ "$mem_kb" -lt 3500000 ] && [ "${CLICKROOM_FORCE:-0}" != 1 ]; then
      die "Only $((mem_kb / 1024)) MB RAM; ClickHouse and the stack will not run reliably below ~4 GB." "use a machine with 4+ GB RAM (8 GB / 4 vCPU recommended), or set CLICKROOM_FORCE=1 to try anyway"
    elif [ "$mem_kb" -lt 7000000 ]; then
      log "note: $((mem_kb / 1024)) MB RAM detected; 8 GB (4 vCPU) is recommended."
    fi
  fi
  disk_kb=$(df -Pk "${1:-.}" | awk 'NR==2 {print $4}')
  [ "${disk_kb:-0}" -ge 10000000 ] || log "note: under 10 GB free disk; ClickHouse and NATS need room to grow."
}

resolve_dir() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  if [ -z "$INSTALL_DIR" ] && [ -n "$here" ] && [ -f "$here/docker-compose.yml" ]; then
    INSTALL_DIR="$here"
  fi
  INSTALL_DIR="${INSTALL_DIR:-$HOME/clickroom}"
  mkdir -p "$INSTALL_DIR"
  INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"
}

# Version whose files we want: --version/env, else what .env pins, else latest.
target_version() {
  local v="${CLICKROOM_VERSION:-$(env_get CLICKROOM_VERSION)}"; echo "${v:-latest}"
}

raw_base() {
  if [ -n "${CLICKROOM_RAW_BASE:-}" ]; then echo "$CLICKROOM_RAW_BASE"; return; fi
  local v; v="$(target_version)"
  [ "$v" = latest ] && v=main
  echo "$RAW_ROOT/$v/deploy/selfhost"
}

# Download every stack file for the target version into $1 (all-or-nothing).
download_files() {
  local dest="$1" base f; base="$(raw_base)"
  command -v curl >/dev/null 2>&1 || die "curl not found"
  for f in "${FILES[@]}"; do
    mkdir -p "$dest/$(dirname "$f")"
    curl -fsSL "$base/$f" -o "$dest/$f" || die "could not download $base/$f" "check the version/tag exists, or re-run with --no-refresh to keep the files you have"
  done
}

fetch_files() {
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  if [ "$here" = "$INSTALL_DIR" ] && [ -f "$here/../../pnpm-workspace.yaml" ]; then log "using checkout in $INSTALL_DIR"; return; fi
  if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    [ "$NO_REFRESH" = 0 ] || { log "keeping existing stack files (--no-refresh)"; return; }
    refresh_files
    return
  fi
  log "downloading stack files into $INSTALL_DIR"
  download_files "$INSTALL_DIR"
  chmod +x "$INSTALL_DIR"/install.sh "$INSTALL_DIR"/scripts/*.sh "$INSTALL_DIR"/garage/init.sh
}

# Existing install: bring stack files up to the target version. .env and
# docker-compose.override.yml are never touched; replaced files are kept in .bak/<timestamp>/.
refresh_files() {
  local tmp bak f changed=0
  tmp="$(mktemp -d)"; bak="$INSTALL_DIR/.bak/$(date +%Y%m%dT%H%M%S)"
  log "refreshing stack files to $(target_version)"
  download_files "$tmp"
  for f in "${FILES[@]}"; do
    if [ -f "$INSTALL_DIR/$f" ] && cmp -s "$tmp/$f" "$INSTALL_DIR/$f"; then continue; fi
    if [ -f "$INSTALL_DIR/$f" ]; then mkdir -p "$bak/$(dirname "$f")"; cp -p "$INSTALL_DIR/$f" "$bak/$f"; fi
    mkdir -p "$INSTALL_DIR/$(dirname "$f")"
    mv "$tmp/$f" "$INSTALL_DIR/$f"   # new inode: safe even if this runs from scripts/upgrade.sh
    changed=$((changed + 1)); log "  updated $f"
  done
  rm -rf "$tmp"
  chmod +x "$INSTALL_DIR"/install.sh "$INSTALL_DIR"/scripts/*.sh "$INSTALL_DIR"/garage/init.sh
  if [ "$changed" = 0 ]; then log "stack files already current"; else log "previous versions saved in $bak"; fi
}

# env_get KEY -> current value in .env (empty if absent/blank)
env_get() { grep -E "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' || true; }

# env_set KEY VALUE -> set/replace the line (value never passes through sed)
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -qE "^$key=" "$INSTALL_DIR/.env"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k && !d {print k "=" v; d=1; next} {print}' "$INSTALL_DIR/.env" > "$tmp"
  else
    cat "$INSTALL_DIR/.env" > "$tmp"; printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  cat "$tmp" > "$INSTALL_DIR/.env"; rm -f "$tmp"
}

# gen_secret KEY BYTES -> generate only when missing/blank (never overwrite)
gen_secret() {
  [ -n "$(env_get "$1")" ] || { env_set "$1" "$(openssl rand -hex "$2")"; log "generated $1"; }
}

write_env() {
  FRESH=0
  if [ ! -f "$INSTALL_DIR/.env" ]; then
    FRESH=1
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
    log "created .env"
  fi
  chmod 600 "$INSTALL_DIR/.env"

  for k in POSTGRES_PASSWORD CLICKHOUSE_PASSWORD CLICKHOUSE_QUERY_PASSWORD REDIS_PASSWORD; do gen_secret "$k" 24; done
  for k in JWT_SECRET ADMIN_JWT_SECRET SSO_RELAY_STATE_SECRET SSO_SECRETS_KEY AI_ENCRYPTION_KEY MCP_OAUTH_STATE_SECRET INTERNAL_QUERY_SECRET; do gen_secret "$k" 32; done

  # Bundled Garage S3 (profile `storage`): RPC secret + admin token (32-byte hex) and an S3 key in
  # Garage's own format (GK + 24 hex id, 64 hex secret). Harmless when the profile is off.
  for k in GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN; do gen_secret "$k" 32; done
  [ -n "$(env_get S3_ACCESS_KEY_ID)" ] || { env_set S3_ACCESS_KEY_ID "GK$(openssl rand -hex 12)"; log "generated S3_ACCESS_KEY_ID"; }
  gen_secret S3_SECRET_ACCESS_KEY 32

  if [ -z "$DOMAIN" ] && [ "$FRESH" = 1 ] && [ "$HAVE_TTY" = 1 ]; then
    printf 'Domain to serve Clickroom on (e.g. analytics.example.com), Enter for http://localhost: ' >/dev/tty
    read -r DOMAIN </dev/tty || true
  fi
  # Only touch address settings when asked, so re-runs keep a hand-edited .env.
  if [ -n "$DOMAIN" ]; then
    DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%/}"
    # Bundled-Garage presigned URLs must point at the public origin; keep them in step when it moves.
    local old_public old_s3
    old_public="$(env_get CLICKROOM_PUBLIC_URL)"; old_s3="$(env_get S3_PUBLIC_ENDPOINT)"
    case "$DOMAIN" in localhost|localhost:*)
      env_set CADDY_SITE_ADDRESS "http://$DOMAIN"; env_set CLICKROOM_PUBLIC_URL "http://$DOMAIN" ;;
    *) env_set CADDY_SITE_ADDRESS "$DOMAIN"; env_set CLICKROOM_PUBLIC_URL "https://$DOMAIN" ;;
    esac
    if [ -n "$old_s3" ] && [ "$old_s3" = "$old_public" ]; then env_set S3_PUBLIC_ENDPOINT "$(env_get CLICKROOM_PUBLIC_URL)"; fi
  fi
  [ -z "${CLICKROOM_VERSION:-}" ] || env_set CLICKROOM_VERSION "$CLICKROOM_VERSION"
  [ -z "${CLICKROOM_REGISTRY:-}" ] || env_set CLICKROOM_REGISTRY "$CLICKROOM_REGISTRY"

  [ "$WITH_STORAGE" != 1 ] || enable_storage
  [ "$WITH_ADMIN" != 1 ] || enable_admin
  # Moving to a new domain: keep a previously enabled admin site and Garage URL in step.
  if [ -n "$DOMAIN" ] && has_profile admin; then enable_admin; fi
  has_profile admin || disable_admin_site
}

# profile_add NAME -> append to COMPOSE_PROFILES in .env (idempotent)
profile_add() {
  local cur; cur="$(env_get COMPOSE_PROFILES)"
  case ",$cur," in *",$1,"*) return ;; esac
  env_set COMPOSE_PROFILES "${cur:+$cur,}$1"
}
has_profile() { case ",$(env_get COMPOSE_PROFILES)," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

# --with-storage: bundled Garage S3 for support attachments. Secrets were generated above.
enable_storage() {
  profile_add storage
  env_set S3_BUCKET "$(env_get S3_BUCKET | grep . || echo clickroom-attachments)"
  env_set SUPPORT_ATTACHMENTS_BUCKET "$(env_get S3_BUCKET)"
  env_set S3_ENDPOINT "http://garage:3900"
  env_set S3_PUBLIC_ENDPOINT "$(env_get CLICKROOM_PUBLIC_URL)"
  env_set AWS_REGION "$(env_get AWS_REGION | grep . || echo us-east-1)"
  env_set S3_FORCE_PATH_STYLE true
  log "support attachments enabled (bundled Garage S3)"
}

# --with-admin: admin console on admin.<domain> (plain http://admin.localhost for a local install).
enable_admin() {
  local host; host="$(env_get CLICKROOM_PUBLIC_URL)"; host="${host#http://}"; host="${host#https://}"
  profile_add admin
  case "$host" in
    localhost|localhost:*) env_set ADMIN_SITE_ADDRESS "http://admin.localhost"; env_set ADMIN_PUBLIC_URL "http://admin.localhost" ;;
    *) env_set ADMIN_SITE_ADDRESS "admin.$host"; env_set ADMIN_PUBLIC_URL "https://admin.$host"
       log "admin console needs a DNS record for admin.$host pointing at this server" ;;
  esac
}

# Without the admin profile the admin site block must stay inert (no certificate attempts).
disable_admin_site() {
  case "$(env_get ADMIN_SITE_ADDRESS)" in ""|http://*) ;; *) env_set ADMIN_SITE_ADDRESS "http://admin.localhost" ;; esac
}

wait_healthy() {
  log "waiting for services to become healthy (first start runs migrations; up to ~5 min)"
  local i
  for i in $(seq 1 100); do
    if (cd "$INSTALL_DIR" && docker compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null | grep -q ' unhealthy'); then
      log "WARNING: a service reports unhealthy — see: docker compose logs"
    fi
    if (cd "$INSTALL_DIR" && [ "$(docker compose ps --format '{{.Service}} {{.Health}}' caddy api 2>/dev/null | grep -c ' healthy')" -ge 2 ]); then
      return 0
    fi
    sleep 3
  done
  die "Timed out waiting for the stack to become healthy." "cd $INSTALL_DIR && docker compose ps && docker compose logs --tail=50 api caddy"
}

main() {
  check_prereqs
  resolve_dir
  check_resources "$INSTALL_DIR"
  fetch_files
  write_env
  cd "$INSTALL_DIR"
  check_ports
  docker compose config -q || die "The generated compose configuration is invalid." "delete $INSTALL_DIR/.env to regenerate it, or fix the value named above"
  if [ "$NO_PULL" = 0 ]; then
    log "pulling images (first run downloads ~1-2 GB)"
    docker compose pull --quiet || die "Could not pull images." "check internet access and that CLICKROOM_REGISTRY/CLICKROOM_VERSION exist (registry: $(env_get CLICKROOM_REGISTRY), version: $(env_get CLICKROOM_VERSION))"
  fi
  log "applying database migrations"
  docker compose run --rm migrate || die "Database migration failed." "see the output above; 'docker compose logs postgres clickhouse'. Nothing was restarted."
  log "starting"
  docker compose up -d || die "Could not start the stack." "run: cd $INSTALL_DIR && docker compose ps && docker compose logs --tail=50"
  wait_healthy
  local url
  url="$(env_get CLICKROOM_PUBLIC_URL)"
  cat <<DONE

[install] Clickroom is running.

  1. Open  ${url:-http://localhost}
  2. Create your owner account (the first sign-up becomes the owner; then it is invite-only).
  3. Create a project and copy the install snippet into your site.

  Upgrade later by re-running this script.   Stack dir: $INSTALL_DIR   Secrets: $INSTALL_DIR/.env
  Logs: cd $INSTALL_DIR && docker compose logs -f     Backup: $INSTALL_DIR/scripts/backup.sh
DONE
}

main "$@"
