# Environment variable reference

Self-host configuration lives in `~/clickroom/.env` (created by `install.sh` from
`deploy/selfhost/.env.example`). How to edit it: [Configuration](../self-host/configuration.md).

Read this first: **`.env` is not passed to containers wholesale.** `docker-compose.yml` reads a fixed
set of variables from `.env` and maps them onto each service. The **Where** column says which:

- **.env**: set it in `.env`; the shipped compose file uses it.
- **fixed**: hard-coded by the compose file for the bundled stack; changing `.env` does nothing.
- **override**: the application reads it and it has a default, but the compose file does not
  forward it. Set it under the service's `environment:` in a `docker-compose.override.yml`
  ([how](../self-host/configuration.md#override-file)).

"Generated" means `install.sh` creates it (random hex) when empty and never overwrites it.
If this page and `deploy/selfhost/.env.example` / `apps/api/src/env.ts` ever disagree, those win.

## Deployment and public address

| Variable | Where | Default | Description |
|---|---|---|---|
| `CLICKROOM_REGISTRY` | .env | `ghcr.io/room-co` | Image registry prefix. Images are `<registry>/clickroom-<name>:<version>`. |
| `CLICKROOM_VERSION` | .env | `latest` | Image tag for every service. Pin an exact release tag (`v0.2.1`) for production. |
| `CLICKROOM_PUBLIC_URL` | .env, required | `http://localhost` (set by installer) | The one public origin, scheme included, no trailing slash. Becomes `WEB_PUBLIC_URL`, `MCP_OAUTH_ISSUER` and `CORS_ORIGINS` for the API and the capture host the dashboard hands to SDK snippets (`<url>/capture`). Its scheme decides cookie `Secure`. |
| `CADDY_SITE_ADDRESS` | .env | `http://localhost` | What Caddy serves. A bare domain gives automatic HTTPS; `http://...` gives plain HTTP with no certificate. |
| `HTTP_PORT` | .env | `80` | Host port mapped to Caddy's 80. |
| `HTTPS_PORT` | .env | `443` | Host port mapped to Caddy's 443 (TCP and UDP). Published even when TLS is off, so it must be free. |
| `ADMIN_SITE_ADDRESS` | .env | `http://admin.localhost` (`install.sh --with-admin` sets `admin.<domain>`) | Hostname Caddy serves the admin console on. The default is plain HTTP, so Caddy requests no certificate for it. |
| `CADDY_TRUSTED_PROXIES` | .env | `127.0.0.1/32` (trust nobody) | Space-separated CIDRs of proxies in front of Caddy (for example Cloudflare's ranges, or `private_ranges`) whose `X-Forwarded-For` is trusted for the real client IP. See [Reverse proxy](../self-host/reverse-proxy.md). |
| `ADMIN_PUBLIC_URL` | .env | `http://admin.localhost` (`--with-admin` sets `https://admin.<domain>`) | Admin console origin used by the API. |
| `COMPOSE_PROFILES` | .env | unset | Comma list of optional profiles: `admin`, `storage`, `tools`. |
| `CLICKROOM_DEPLOYMENT` | fixed (`self_host`) | `self_host` | `self_host` or `cloud`. Self-host means the unlimited plan, no hosted-only dependencies. Do not change. |
| `NODE_ENV` | fixed (`production`) | | Set by compose for application services. |
| `QUOTA_ENFORCE` | .env | `false` | Plan quota enforcement in api and capture. Leave `false` on self-host. |
| `CLICKROOM_WRITE_KEY` | .env | empty | Optional write key so the dashboard reports its own usage to that project. Empty = off; nothing leaves your server. |

## Accounts and admin

| Variable | Where | Default | Description |
|---|---|---|---|
| `SIGNUP_MODE` | .env | `first_user_only` | `first_user_only`, `open` or `closed`. An invalid value stops the API from starting. See [Accounts](../self-host/accounts.md). |
| `ADMIN_PASSWORD_SINK` | .env | `stdout` | Where `admin:create` delivers the password: `stdout` (printed once), `env` (uses `CLICKROOM_ADMIN_PASSWORD`, prints nothing), `ssm` (AWS SSM, hosted service only). |
| `CLICKROOM_ADMIN_EMAIL` | .env | unset | With `CLICKROOM_ADMIN_PASSWORD`, creates that admin at API boot if absent. Must be set together with the password. |
| `CLICKROOM_ADMIN_PASSWORD` | .env | unset | At least 12 characters. Less secure than the CLI; remove after first boot. TOTP still required. |
| `ADMIN_DEV_DISABLE_2FA` | n/a | | Development only; blocked in production builds. Do not use. |

## Secrets (generated)

All required; the API refuses to start in production without the first four.

| Variable | Format | Used for |
|---|---|---|
| `JWT_SECRET` | hex | Signing user sessions. |
| `ADMIN_JWT_SECRET` | hex | Signing admin tokens (separate from user sessions). |
| `MCP_OAUTH_STATE_SECRET` | hex | HMAC for the MCP OAuth authorize flow state. |
| `INTERNAL_QUERY_SECRET` | hex | Bearer shared by `api` and `query`. |
| `SSO_RELAY_STATE_SECRET` | hex | Signing the SSO relay-state cookie. |
| `SSO_SECRETS_KEY` | 32 bytes, hex or base64 | Encrypting stored SSO configuration. Changing it loses that data. |
| `AI_ENCRYPTION_KEY` | exactly 64 hex chars | Encrypting AI provider keys entered in the dashboard. Changing it loses them. Also passed to `ingest`. |
| `POSTGRES_PASSWORD` | hex | Postgres user `clickroom`. Applied at first volume init. |
| `CLICKHOUSE_PASSWORD` | hex | ClickHouse user `clickroom` (read/write). Applied at first volume init. |
| `CLICKHOUSE_QUERY_PASSWORD` | hex | ClickHouse read-only user `clickroom_query` for the SQL explorer. |
| `REDIS_PASSWORD` | hex | Redis `requirepass`. |

## Data stores (fixed by the bundled stack)

These are built by the compose file for the bundled containers. To use external services you must
override them ([External services](../self-host/external-services.md)).

| Variable | Where | Bundled value | Description |
|---|---|---|---|
| `DATABASE_URL` | fixed | `postgresql://clickroom:<POSTGRES_PASSWORD>@postgres:5432/clickroom?schema=public` | Postgres (api, migrate, cli; capture and ingest get the same without `?schema`). |
| `DB_TLS` | fixed | `disable` | Node services only. `disable` = no TLS to Postgres. Any other value = verified TLS using `DB_CA_BUNDLE_PATH`. |
| `DB_CA_BUNDLE_PATH` | override | image's RDS CA bundle | CA file to verify Postgres TLS. |
| `CLICKHOUSE_URL` | fixed | `http://clickhouse:8123` | ClickHouse HTTP endpoint. |
| `CLICKHOUSE_USER` | fixed | `clickroom` | |
| `CLICKHOUSE_PASSWORD` | .env | see Secrets | |
| `CLICKHOUSE_DATABASE` | fixed | `clickroom` | |
| `CLICKHOUSE_QUERY_USER` | fixed | `clickroom_query` | Read-only user created by migrations. |
| `CLICKHOUSE_QUERY_PASSWORD` | .env | see Secrets | |
| `NATS_URL` | fixed | `nats://nats:4222` | NATS with JetStream. |
| `REDIS_URL` | fixed | `redis://:<REDIS_PASSWORD>@redis:6379` | |
| `QUERY_SERVICE_URL` | fixed | `http://query:3002` | Where `api` reaches the query service. |
| `API_PORT` | fixed | `3000` | |
| `CAPTURE_PORT` | fixed | `3001` | |
| `QUERY_PORT` | fixed | `3002` | |

## Support attachments and S3

Off unless `SUPPORT_ATTACHMENTS_BUCKET` is set. `install.sh --with-storage` sets this and the other S3 values; bundled Garage needs `COMPOSE_PROFILES=storage`.

| Variable | Where | Default | Description |
|---|---|---|---|
| `SUPPORT_ATTACHMENTS_BUCKET` | .env | empty (feature off) | Bucket name. Must equal `S3_BUCKET` for bundled Garage. |
| `S3_BUCKET` | .env | `clickroom-attachments` | Bucket created by `garage-init` and routed by Caddy at `/<S3_BUCKET>/*`. |
| `S3_ENDPOINT` | .env | empty | Where capture talks to S3. `http://garage:3900` for bundled Garage; empty for AWS. |
| `S3_PUBLIC_ENDPOINT` | .env | empty | Origin browsers use for presigned URLs. For bundled Garage: your `CLICKROOM_PUBLIC_URL`. |
| `S3_ACCESS_KEY_ID` | .env | generated (`GK` + 24 hex) | Becomes `AWS_ACCESS_KEY_ID` in capture; imported into Garage. |
| `S3_SECRET_ACCESS_KEY` | .env | generated (64 hex) | Becomes `AWS_SECRET_ACCESS_KEY` in capture. |
| `AWS_REGION` | .env | `us-east-1` | Must equal `s3_region` in `garage/garage.toml` for Garage. |
| `S3_FORCE_PATH_STYLE` | .env | `true` | `true` for Garage/MinIO-style stores; `false` for AWS S3. |
| `GARAGE_RPC_SECRET` | .env | generated | Garage inter-node secret (32-byte hex). Required for Garage to start. |
| `GARAGE_ADMIN_TOKEN` | .env | generated | Garage admin API token, used by `garage-init`. |
| `CAPTURE_STREAM_MAX_BYTES` | .env | `16106127360` (15 GiB) | Cap on the NATS events stream, in bytes. Keep below `max_file_store` (20 GB) in `nats/nats-server.conf`. |

## Capture and ingest tuning (override)

Defaults below are the application defaults documented in the repo's root `.env.example`. Only
`CAPTURE_STREAM_MAX_BYTES` (above) is forwarded by the compose file; set the others via an
override file.

| Variable | Service | Default | Meaning |
|---|---|---|---|
| `CAPTURE_KEY_CACHE_TTL_SECS` | capture | `60` | Cache time for valid write keys. |
| `CAPTURE_KEY_NEG_CACHE_TTL_SECS` | capture | `10` | Cache time for unknown/revoked keys. |
| `CAPTURE_RATE_LIMIT_BURST` | capture | `5000` | Per-project token-bucket capacity. |
| `CAPTURE_RATE_LIMIT_REFILL_PER_SEC` | capture | `2000` | Per-project refill rate. |
| `CAPTURE_STREAM_MAX_AGE_SECS` | capture | `259200` (72 h) | Retention of un-ingested events in NATS. |
| `CAPTURE_NATS_PUBLISH_TIMEOUT_MS` | capture | `5000` | Wait for JetStream acks before returning 503. |
| `CAPTURE_NATS_MAX_CONCURRENT_PUBLISHES` | capture | `500` | Cap on in-flight publishes. |
| `INGEST_DURABLE_NAME` | ingest | `ingest` | JetStream consumer name. |
| `INGEST_BATCH_MAX_SIZE` | ingest | `1000` | Max messages per ClickHouse insert. |
| `INGEST_BATCH_MAX_WAIT_MS` | ingest | `500` | Max wait to fill a batch. |
| `INGEST_MAX_DELIVER` | ingest | `5` | Deliveries before an event goes to the dead-letter stream. |
| `INGEST_ACK_WAIT_SECS` | ingest | `30` | Redelivery timeout. |
| `INGEST_DLQ_SUBJECT_PREFIX` | ingest | `events.dlq` | Dead-letter subject prefix. |
| `INGEST_DLQ_STREAM_MAX_AGE_SECS` | ingest | `604800` (7 d) | Dead-letter retention. |
| `INGEST_VOLUME_JOB_INTERVAL_SECS` | ingest | `3600` | Event-name volume/last-seen job interval. |
| `INGEST_VOLUME_JOB_ENABLED` | ingest | `true` | Toggle that job. |
| `INGEST_WEBHOOK_ALLOW_PRIVATE_TARGETS` | ingest | `false` | Allow support webhooks to private/loopback addresses. Never enable on a networked host. |
| `QUERY_MAX_CONCURRENCY` | query | `6` | In-flight SQL-explorer queries before 429. |
| `COOKIE_DOMAIN` | api | unset | Cookie domain for split-subdomain setups. Not a supported layout ([why](../self-host/reverse-proxy.md#subdomain-splits-are-not-wired-up)). |
| `CORS_ORIGINS` | api | `CLICKROOM_PUBLIC_URL` (fixed by compose) | Allowed origins; the compose file sets it from `CLICKROOM_PUBLIC_URL`, so `.env` edits are ignored. |

## Development only

Not used by the self-host stack: `TEST_DATABASE_URL`, `TEST_CLICKHOUSE_DATABASE`, `VITE_API_ORIGIN`,
`VITE_CLICKROOM_WRITE_KEY`, `VITE_CLICKROOM_API_HOST`, `DOGFOOD_ORG_SLUG`, `DOGFOOD_FLAG_ENV`,
`NATS_PORT`, `NATS_MONITOR_PORT`. See the repo-root `.env.example` and `CONTRIBUTING.md`.

## Web container runtime config

Set by compose, not by you: `CLICKROOM_API_ORIGIN` (empty = same origin), `CLICKROOM_CAPTURE_HOST`
(`<CLICKROOM_PUBLIC_URL>/capture`), `CLICKROOM_DEPLOYMENT`, `CLICKROOM_WRITE_KEY`. They are rendered
into `/config.js` when the container starts.
