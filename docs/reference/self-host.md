# Self-host files, scripts, routes and ports

Everything lives in the install directory (default `~/clickroom`). Run all commands there.

## install.sh

```text
install.sh [--domain example.com] [--version v0.1.0] [--dir PATH] [--with-storage] [--with-admin]
           [--non-interactive] [--no-pull] [--no-refresh] [--help]
```

| Option / env | Meaning |
|---|---|
| `--domain D` / `CLICKROOM_DOMAIN` | Public domain (automatic HTTPS). Omit for `http://localhost`. `http://`, `https://` and a trailing `/` are stripped. |
| `--version V` / `CLICKROOM_VERSION` | Image tag to install or upgrade to. Default: keep the current, else `latest`. |
| `--dir PATH` / `CLICKROOM_DIR` | Install directory. Default `~/clickroom` (or the script's own directory if run from a checkout that contains `docker-compose.yml`). |
| `--with-storage` / `CLICKROOM_WITH_STORAGE=1` | Enable support-ticket attachments: sets `COMPOSE_PROFILES`, `S3_BUCKET`, `SUPPORT_ATTACHMENTS_BUCKET`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `AWS_REGION`, `S3_FORCE_PATH_STYLE` in `.env`. |
| `--with-admin` / `CLICKROOM_WITH_ADMIN=1` | Enable the admin console: adds the `admin` profile and sets `ADMIN_SITE_ADDRESS=admin.<domain>` and `ADMIN_PUBLIC_URL` (plain `http://admin.localhost` on a localhost install). Needs a DNS record for `admin.<domain>`. |
| `--no-refresh` | On a re-run, keep the existing compose file, Caddyfile and scripts instead of downloading the ones for the target version. |
| `--non-interactive` | Never prompt. Implied when there is no terminal. |
| `--no-pull` | Do not pull images (air-gapped or locally built). |
| `CLICKROOM_REGISTRY` | Image registry prefix, saved to `.env`. |
| `CLICKROOM_RAW_BASE` | Where stack files are downloaded from (default `https://raw.githubusercontent.com/room-co/clickroom/<ref>/deploy/selfhost`, where `<ref>` is the tag given by `--version`, or `main` for `latest`). |
| `CLICKROOM_FORCE=1` | Continue on less than about 3.5 GB RAM. |

Pass options when piping: `curl -fsSL <url> | bash -s -- --domain analytics.example.com`.
Exit status is non-zero on failure and the last line is `Fix: ...`.

Re-running on an existing install refreshes `docker-compose.yml`, `Caddyfile`, `garage/`, `clickhouse/`,
`nats/` and `scripts/` to the target version. Files that change are copied first to
`<dir>/.bak/<timestamp>/`. `.env` and `docker-compose.override.yml` are never touched. Nothing is
refreshed when the script runs from a repository checkout or with `--no-refresh`.

## scripts/

| Script | Usage | Notes |
|---|---|---|
| `backup.sh` | `[BACKUP_DIR=path] ./scripts/backup.sh` | Writes `<dir>/<UTC timestamp>/` (default `./backups`). Postgres dump, ClickHouse export, Garage tar if running, `env.backup`. [Details](../self-host/backup-restore.md) |
| `restore.sh` | `./scripts/restore.sh <backup-dir> [--yes]` | Destructive. Needs a running stack with the original `.env` secrets. Stops the writers (and `admin` if it is running) and starts them again afterwards. |
| `upgrade.sh` | `./scripts/upgrade.sh [version] [--force] [--no-refresh]` | Refresh stack files, pull, migrate, restart. One minor at a time. [Details](../self-host/upgrade.md) |
| `smoke-test.sh` | `[BASE_URL=https://domain] [CLICKROOM_WRITE_KEY=...] [SMOKE_BOOTSTRAP=1] ./scripts/smoke-test.sh` | Checks `/health`, `/capture/health`, `/`, `/config.js`; then sends an event and reads it from ClickHouse (up to 60 s); with attachments on, does a presign/PUT/GET round trip. Without a write key (none in env and none in Postgres) it runs only the health checks. `SMOKE_BOOTSTRAP=1` creates an owner on an empty instance: do not use on a real one. Default `BASE_URL` is `CLICKROOM_PUBLIC_URL` from `.env`, or `http://localhost:$HTTP_PORT` for a localhost install. |

## CLI commands (run in the `cli` container)

```bash
docker compose run --rm cli pnpm admin:create --email <e> [--name "Full Name"] [--rotate]
docker compose run --rm cli pnpm user:reset-password --email <e> [--password <new>]
```

See [Accounts](../self-host/accounts.md).

## Compose files

| File | Purpose |
|---|---|
| `docker-compose.yml` | The stack. Project name `clickroom-selfhost`. |
| `docker-compose.build.yml` | Overlay that builds images from a repository checkout instead of pulling: `docker compose -f docker-compose.yml -f docker-compose.build.yml build`. Build context is the repo root. |
| `docker-compose.override.yml` | Yours. Merged automatically. |

Common commands:

```bash
docker compose ps
docker compose logs -f [service]
docker compose up -d                  # apply .env changes
docker compose restart api
docker compose pull && docker compose run --rm migrate && docker compose up -d
docker compose exec postgres psql -U clickroom clickroom
docker compose exec clickhouse clickhouse-client --user clickroom --password "$(grep ^CLICKHOUSE_PASSWORD= .env | cut -d= -f2)" --database clickroom
```

## Caddy routes

One origin; there is no `/api` prefix.

| Match | Upstream |
|---|---|
| `/capture/*` (prefix stripped) | `capture:3001` |
| `/trpc`, `/trpc/*`, `/flags/stream`, `/ai`, `/ai/*`, `/mcp`, `/mcp/*`, `/auth/sso/*`, `/authorize`, `/token`, `/register`, `/revoke`, `/.well-known/*`, `/health`, `/ready` | `api:3000` |
| `/<S3_BUCKET>/*` | `garage:3900` (unchanged path and Host) |
| anything else | `web:8080` |
| admin host (`ADMIN_SITE_ADDRESS`, inert `http://admin.localhost` unless the admin profile is enabled): `/trpc`, `/trpc/*`, `/health` | `api:3000` |
| admin host, anything else | `admin:8080` |

Health checks: `GET /health` (API) and `GET /capture/health` (capture) return 200 when up.
Caddy's own admin API listens on `127.0.0.1:2019` inside its container and is used by its healthcheck.

## Ports

| Port | Where | Exposure |
|---|---|---|
| 80, 443/tcp, 443/udp | Caddy | Published on the host (`HTTP_PORT`, `HTTPS_PORT`) |
| 3000 api, 3001 capture, 3002 query, 8080 web/admin | containers | Internal only |
| 5432 Postgres, 8123 ClickHouse, 4222 NATS (8222 monitor), 6379 Redis | containers | Internal only |
| 3900 S3, 3901 RPC, 3903 admin | Garage | Internal only |

## Volumes

Prefix `clickroom-selfhost_`: `postgres-data`, `clickhouse-data`, `nats-data`, `redis-data`,
`garage-meta`, `garage-data`, `caddy-data`, `caddy-config`. Inspect with `docker volume ls`.

## Limits baked into the files

| File | Setting |
|---|---|
| `clickhouse/memory.xml` | Server memory 60% of visible RAM; mark cache 256 MiB; uncompressed cache off; `max_memory_usage` 3 GiB per query. |
| `nats/nats-server.conf` | JetStream file store 20 GB, memory store 256 MB. |
| `docker-compose.yml` | ClickHouse `nofile` 262144; all long-running services `restart: unless-stopped`; images pinned: Postgres 16.4, ClickHouse 24.8, NATS 2.10.22, Redis 7.4, Caddy 2.8, Garage 2.5.0. |
| `garage/garage.toml` | Single node, `replication_factor = 1`, `s3_region = "us-east-1"`, sqlite metadata. |
