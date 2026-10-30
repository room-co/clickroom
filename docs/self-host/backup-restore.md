# Backup and restore

Run these from the install directory (`cd ~/clickroom`). They use the bundled containers via
`docker compose exec`, so they work for the default stack only (not [external services](external-services.md#backups-with-external-services)).

## What is backed up

| Data | Method | Notes |
|---|---|---|
| Postgres (accounts, projects, keys, flags) | `pg_dump` custom format | `postgres.dump` |
| ClickHouse (events and other tables) | per-table export in Native format, compressed with zstd (gzip if `zstd` is not installed on the host) | Tables fed by materialized views are skipped and rebuilt on restore |
| Garage (attachments) | tar of its volumes | Only when Garage is running. Garage is stopped for a few seconds. |
| `.env` | copied as `env.backup` (mode 600) | Contains every secret |
| NATS JetStream | **not backed up** | See below |
| Redis | not backed up | Cache; rebuilds itself |
| TLS certificates | not backed up | Re-issued automatically |

**What the NATS gap means.** JetStream holds only events that capture accepted but ingest has not yet
written to ClickHouse, normally a few seconds' worth (at most the 72-hour buffer if ClickHouse was
down). Those events are lost on restore. This is the stated recovery point.

## Back up

```bash
./scripts/backup.sh
```

Output goes to `./backups/<UTC timestamp>/`. Choose another location with the `BACKUP_DIR`
environment variable (there is no positional argument):

```bash
BACKUP_DIR=/var/backups/clickroom ./scripts/backup.sh
```

The folder contains `postgres.dump`, `clickhouse/*.native.z`, `garage/garage.tar.gz` (if applicable)
and `env.backup`. Install `zstd` on the host (`apt install zstd`) for smaller, faster backups.

Backups are plain files containing all your data and secrets. **Copy them off the server** (another
region/provider, object storage, `rsync`) and protect them.

### Schedule it

```cron
0 3 * * * cd /root/clickroom && BACKUP_DIR=/var/backups/clickroom ./scripts/backup.sh >> /var/log/clickroom-backup.log 2>&1
```

Adjust the path to your install directory, then add an off-box copy and pruning of old folders. Cron
runs with a minimal `PATH`; if it cannot find `docker`, use its full path or set `PATH` at the top of
the crontab.

Backups are full exports, not incremental. A large events table means a long, large backup; watch
free disk space on the backup target.

## Restore

Restore **replaces** the current data. Typical case: a fresh server.

1. Install Docker (see the [quickstart](quickstart.md#4-install-docker)).
2. Put the saved secrets in place **before** the first install, so the new databases are created with
   the original passwords and keys (`AI_ENCRYPTION_KEY` and `SSO_SECRETS_KEY` must match the
   originals):

   ```bash
   mkdir -p ~/clickroom
   cp /path/to/backup/env.backup ~/clickroom/.env
   curl -fsSL https://raw.githubusercontent.com/room-co/clickroom/main/deploy/selfhost/install.sh | bash -s -- --domain your.domain
   ```

   The installer keeps every value already in `.env`, downloads the stack files, and starts an empty
   stack. Use the same `CLICKROOM_VERSION` as the backup was taken on (it is in `.env`).
   If you had already installed with fresh secrets, run `docker compose down -v` (deletes the empty
   volumes) before copying `env.backup` over `.env` and running `docker compose up -d`.
3. Restore into the running stack (still in `~/clickroom`):

   ```bash
   ./scripts/restore.sh /path/to/backup/20260101T000000Z
   ```

   It asks you to type `restore` (pass `--yes` as the second argument to skip the prompt). It stops
   caddy, api, capture, ingest, query and web; drops and recreates the Postgres database and loads
   the dump; re-runs migrations; truncates and reloads each ClickHouse table (`events` first); restores
   Garage if the backup has it; then runs `docker compose up -d`.

4. Verify: `BASE_URL=https://your.domain ./scripts/smoke-test.sh`, log in, check a project.

**Test a restore before you need one**, on a scratch server.

## Recovery point and time

- RPO: your backup interval plus the NATS in-flight window.
- RTO: provisioning a server, installing, and importing your events. Time scales with data size.
- Single-node ClickHouse has no replica. A backup you never copied off the server is not a backup.
