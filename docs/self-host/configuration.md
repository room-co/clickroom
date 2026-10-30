# Configuration

All configuration is environment variables in `~/clickroom/.env` (the directory `install.sh` made).
Every variable is documented in [reference/env.md](../reference/env.md).

## Change a setting

```bash
cd ~/clickroom
nano .env                 # edit
docker compose up -d      # recreates only the services whose settings changed
```

Check the result with `docker compose ps`.

## Only some variables do anything

The compose file passes a fixed list of variables from `.env` to the containers. Putting a variable
in `.env` that the compose file does not reference has **no effect**. The reference page marks each
variable as "in `.env`" (works) or "compose edit needed". In particular, `COOKIE_DOMAIN`,
`CORS_ORIGINS` and the `CAPTURE_*` / `INGEST_*` tuning knobs are not wired through by the shipped
compose file; to use them, add them under the relevant service's `environment:` in
`docker-compose.override.yml` (see [below](#override-file)).

## The settings you will actually change

| Variable | Purpose |
|---|---|
| `CLICKROOM_VERSION` | Image tag for every service. Change via [upgrade](upgrade.md). |
| `CLICKROOM_PUBLIC_URL` | The one public origin, with scheme (`https://analytics.example.com`). Cookies, OAuth/SSO links and CORS derive from it. |
| `CADDY_SITE_ADDRESS` | What Caddy serves: a bare domain (automatic HTTPS) or `http://localhost`. Keep it in step with `CLICKROOM_PUBLIC_URL`. |
| `SIGNUP_MODE` | `first_user_only` (default), `open` or `closed`. See [Accounts](accounts.md). |
| `HTTP_PORT`, `HTTPS_PORT` | Host ports for Caddy (default 80 and 443). Needed when something else holds them or you sit behind a proxy. |
| `COMPOSE_PROFILES` | Optional features: `admin`, `storage`, `tools`. See [Optional features](optional-features.md). |
| `ADMIN_SITE_ADDRESS`, `ADMIN_PUBLIC_URL` | Hostname of the admin console; set by `install.sh --with-admin`. |
| `CADDY_TRUSTED_PROXIES` | CIDRs of a proxy in front of Caddy whose `X-Forwarded-For` is trusted. Default trusts none. See [Reverse proxy](reverse-proxy.md). |

### Changing the domain

Edit both together, then `docker compose up -d`:

```text
CADDY_SITE_ADDRESS=analytics.example.com
CLICKROOM_PUBLIC_URL=https://analytics.example.com
```

If you use the bundled S3 storage and `S3_PUBLIC_ENDPOINT` equalled the old public URL, change it
too. (Re-running `install.sh --domain new.example.com` does all of this for you.)

## Secrets

`install.sh` generates every secret. Keep `.env` private (mode 600) and back it up.

- `AI_ENCRYPTION_KEY` encrypts AI provider keys you enter in the dashboard. `SSO_SECRETS_KEY`
  encrypts SSO configuration. **Changing or losing either makes the stored values unreadable**; you
  would have to re-enter them.
- `JWT_SECRET` signs user sessions. Changing it signs everyone out.
- `POSTGRES_PASSWORD` and `CLICKHOUSE_PASSWORD` are applied when each database first initialises
  its volume. Editing them later in `.env` does **not** change the password inside an existing
  database, and the services will then fail to connect. Change the password inside the database
  first, or do not rotate. (`REDIS_PASSWORD` is read by Redis at every start, so it can be changed
  with `docker compose up -d`.)

## AI features

AI features use your own provider keys, entered in the dashboard and stored encrypted with
`AI_ENCRYPTION_KEY`. Nothing is configured in `.env` for them.

## Dashboard self-analytics

`CLICKROOM_WRITE_KEY` (optional) makes the dashboard itself send usage events to the project that key
belongs to. Empty means off, and nothing leaves your server.

## Override file

For anything the compose file does not expose, do not edit `docker-compose.yml` (it is a download,
and a future refresh would overwrite your edit). Create `docker-compose.override.yml` next to it;
`docker compose` merges it automatically:

```yaml
services:
  capture:
    environment:
      CAPTURE_RATE_LIMIT_BURST: "10000"
  ingest:
    environment:
      INGEST_BATCH_MAX_SIZE: "2000"
```

Run `docker compose config` to see the merged result, then `docker compose up -d`.

## Runtime web configuration

`web` and `admin` render `/config.js` at container start. For single-domain installs the dashboard
calls same-origin paths and the SDK snippet uses `<public url>/capture`. You do not rebuild images
to change hosts.
