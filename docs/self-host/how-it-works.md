# How self-hosting works, and its limits

This page explains what the installer does, what is running on your server, where your data lives,
and what a single-node setup can and cannot do. For the product-level architecture see
[explanation/architecture.md](../explanation/architecture.md).

## What `install.sh` does

The installer is one idempotent Bash script. Re-running it is safe and is also one way to upgrade.

1. **Checks the machine.** Needs `docker`, the `docker compose` plugin, a reachable Docker daemon
   and `openssl`. Refuses to continue below about 3.5 GB RAM unless `CLICKROOM_FORCE=1`. Notes if you
   have less than 8 GB RAM or less than 10 GB free disk.
2. **Picks the install directory**: `--dir`, else `CLICKROOM_DIR`, else the directory the script
   lives in (if run from a checkout), else `~/clickroom`.
3. **Downloads the stack files** (on a re-run, refreshes them to the target version, keeping the old
   ones in `.bak/`; your `.env` and `docker-compose.override.yml` are never touched):
   `install.sh` (so `./install.sh` works for later re-runs), `docker-compose.yml`,
   `docker-compose.build.yml`, `Caddyfile`, `.env.example`,
   `clickhouse/memory.xml`, `nats/nats-server.conf`, `garage/garage.toml`, `garage/init.sh` and
   `scripts/{backup,restore,upgrade,smoke-test}.sh`.
4. **Writes `.env`** from `.env.example` (first run only, mode 600) and generates any secret that is
   empty. It never overwrites an existing value.
5. **Applies your domain** (only if you passed `--domain` or answered the prompt): sets
   `CADDY_SITE_ADDRESS` and `CLICKROOM_PUBLIC_URL` (the admin console's address is only set with
   `--with-admin`). `localhost` gives plain HTTP; anything else gives
   `https://` with automatic certificates.
6. **Checks ports** 80 and 443 (or your `HTTP_PORT` / `HTTPS_PORT`) are free, unless this stack is
   already running.
7. **Validates** the compose file, **pulls images**, **runs `migrate`** (Postgres and ClickHouse
   schema), then **starts everything** and waits for `caddy` and `api` to report healthy.

If migration fails, nothing is restarted.

### What it leaves on disk

```text
~/clickroom/
  .env                  secrets and settings (mode 600). BACK THIS UP.
  docker-compose.yml    the stack
  Caddyfile             routing / TLS
  clickhouse/memory.xml ClickHouse memory limits
  nats/nats-server.conf JetStream limits
  garage/               bundled S3 config + bootstrap (only used by the storage profile)
  scripts/              backup.sh restore.sh upgrade.sh smoke-test.sh
```

Generated secrets (all random hex): `POSTGRES_PASSWORD`, `CLICKHOUSE_PASSWORD`,
`CLICKHOUSE_QUERY_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET`, `ADMIN_JWT_SECRET`,
`SSO_RELAY_STATE_SECRET`, `SSO_SECRETS_KEY`, `AI_ENCRYPTION_KEY`, `MCP_OAUTH_STATE_SECRET`,
`INTERNAL_QUERY_SECRET`, `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`. Nothing is sent anywhere; Clickroom has no telemetry.

## What runs

Compose project name: `clickroom-selfhost`.

| Service | Role | Default |
|---|---|---|
| `postgres` (16) | Config, users, orgs, projects, flags | on |
| `clickhouse` (24.8) | Event storage and analytics queries | on |
| `nats` (2.10, JetStream) | Buffer between capture and ClickHouse | on |
| `redis` (7.4) | Cache, rate limits | on |
| `migrate` | One-shot: Postgres + ClickHouse migrations, reference data. Exits 0. | on |
| `api` | NestJS control plane (auth, projects, flags, insights, MCP) | on |
| `capture` | Rust hot path: receives SDK events, flag evaluation | on |
| `ingest` | Rust: NATS to ClickHouse in batches | on |
| `query` | Rust: read-only SQL explorer service | on |
| `web` | Dashboard static app | on |
| `caddy` | TLS and routing on ports 80/443 | on |
| `admin` | Admin console | profile `admin` |
| `garage`, `garage-init` | Bundled S3 for support attachments | profile `storage` |
| `cli` | One-off commands container | profile `tools` |

Startup order: data stores healthy, then `migrate` must exit 0, then `api`, `capture`, `ingest`,
`query`, then `web`, then `caddy`.

Event path: SDK, then `https://<domain>/capture`, then `capture` (checks the write key, rate limits,
validates) which publishes to NATS JetStream and returns quickly, then `ingest` batches into
ClickHouse (roughly every 500 ms or 1000 events). Dashboards read ClickHouse through `api` and
`query`. If ClickHouse is down briefly, events wait in NATS and are ingested when it returns.

## Where data lives

All state is in named Docker volumes (prefix `clickroom-selfhost_`):

| Volume | Holds | Backed up by `backup.sh` |
|---|---|---|
| `postgres-data` | accounts, orgs, projects, keys, flags | yes (`pg_dump`) |
| `clickhouse-data` | all events | yes (per-table export) |
| `garage-meta`, `garage-data` | support attachments | yes, if Garage is running |
| `nats-data` | events accepted but not yet written to ClickHouse | **no** |
| `redis-data` | cache, rate-limit counters | no (rebuildable) |
| `caddy-data`, `caddy-config` | TLS certificates | no (re-issued automatically) |
| `.env` file (not a volume) | all secrets | yes (copied as `env.backup`) |

## Resource use and sizing

- Measured idle: about **800 MiB RAM across the ten default services**. Under load, ClickHouse is
  what grows.
- ClickHouse is capped to 60% of the RAM it can see and a single query to 3 GiB
  (`clickhouse/memory.xml`). On an 8 GB machine that leaves room for everything else.
- NATS JetStream is capped at 20 GB on disk; `capture` caps the events stream at 15 GiB
  (`CAPTURE_STREAM_MAX_BYTES`) and 72 hours (`CAPTURE_STREAM_MAX_AGE_SECS`). When the cap trips,
  capture answers 503 (backpressure) instead of filling the disk.
- Event storage grows with traffic. The shipped migrations set no retention (TTL) on events, so
  they are kept until you delete them. Watch `df -h` and `docker system df`.
- Recommended: **4 vCPU / 8 GB RAM / 40 GB SSD**. Treat that as the floor for production. We have
  not published a verified events-per-month ceiling; size by watching your own usage and keep headroom.

## Limits, stated honestly

- **Single node.** One of each database. No replication, no automatic failover, no horizontal
  scaling. If the server is lost, you restore from your last backup on a new one.
- **Recovery point** is your backup interval, plus events still in NATS at backup time (normally
  seconds) which are lost on restore. Nightly backups mean up to 24 hours of loss.
- **Downtime during upgrades**: services restart after migration; expect a short outage.
- **No Helm chart, no Kubernetes manifests, no multi-node guide.** For larger scale use Clickroom
  Cloud or design your own deployment.
- **No email.** There is no mailer: invites are copy-and-paste links and password resets are done
  from the command line.
- **Backups use full exports** (not incremental). Large ClickHouse datasets make backups slow and big.
- **Stack file updates are manual.** `install.sh` and `upgrade.sh` update images, not
  `docker-compose.yml` or `Caddyfile` once they exist. See [Upgrade](upgrade.md#updating-the-stack-files).
- **Plan limits do not apply**: self-host runs the unlimited plan (`CLICKROOM_DEPLOYMENT=self_host`).
  Billing features of the cloud product are not part of self-host.

## Design choices worth knowing

- **One public origin.** Dashboard, API, capture and attachments share one hostname and are routed
  by path, so cookies work without any cross-domain settings. See the table in
  [reference/self-host.md](../reference/self-host.md#caddy-routes).
- **Images are versioned together.** All images share `CLICKROOM_VERSION`; migrations ship in the
  `migrate` image and always run before new services start.
- **Web config at runtime.** The `web` and `admin` images read `/config.js`, generated when the
  container starts, so you never rebuild images to change hosts.
