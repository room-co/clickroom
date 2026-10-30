# Using external services

The default stack bundles Postgres, ClickHouse, NATS and Redis (plus optional Garage for S3). You
can point Clickroom at managed equivalents instead.

> **Not a turnkey path.** The shipped `docker-compose.yml` builds connection strings from
> `POSTGRES_PASSWORD`, `CLICKHOUSE_PASSWORD` and `REDIS_PASSWORD` and hard-codes the bundled hostnames
> (`postgres`, `clickhouse`, `nats`, `redis`). Putting `DATABASE_URL` in `.env` does **not** change
> anything. To use external services you must override the environment in
> `docker-compose.override.yml`. This path is supported by the application (it only reads URLs) but
> has not been end-to-end tested by the maintainers with every provider. Back up first.

## What each service must provide

| Service | Requirement | Variables the apps read |
|---|---|---|
| Postgres | 16+, a database and user that can create tables | `DATABASE_URL` (api, capture, ingest, migrate, cli); `DB_TLS` (the stack sets `disable`; see TLS note below) |
| ClickHouse | 24.x over HTTP(S), a read-write user and a database; the migrations also create a read-only user | `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE`, `CLICKHOUSE_QUERY_USER`, `CLICKHOUSE_QUERY_PASSWORD` |
| NATS | JetStream **enabled** with file storage | `NATS_URL` (api, capture, ingest) |
| Redis | Any Redis 6+ | `REDIS_URL` |
| S3 | Any S3-compatible store, reachable from browsers for presigned PUT/GET | `SUPPORT_ATTACHMENTS_BUCKET`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_FORCE_PATH_STYLE` |

The ClickHouse migrations use `CLICKHOUSE_USER` to create tables and a restricted read-only
`CLICKHOUSE_QUERY_USER` (used by the SQL explorer), so the main user needs access-management rights
(the bundled image sets `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1`).

## Procedure (example: managed Postgres)

1. Create `docker-compose.override.yml` next to `docker-compose.yml`. `DATABASE_URL` appears in
   `migrate`, `api`, `capture`, `ingest` and `cli`; set it on each:

   ```yaml
   services:
     migrate:
       environment:
         DATABASE_URL: postgresql://user:pass@db.example.com:5432/clickroom?schema=public
         DB_TLS: ""   # see TLS note
     api:
       environment:
         DATABASE_URL: postgresql://user:pass@db.example.com:5432/clickroom?schema=public
         DB_TLS: ""
     capture:
       environment:
         DATABASE_URL: postgresql://user:pass@db.example.com:5432/clickroom
     ingest:
       environment:
         DATABASE_URL: postgresql://user:pass@db.example.com:5432/clickroom
     cli:
       environment:
         DATABASE_URL: postgresql://user:pass@db.example.com:5432/clickroom?schema=public
         DB_TLS: ""
   ```

   **TLS note.** The Node services (`api`, `migrate`, `cli`) only recognise `DB_TLS=disable`
   (no TLS, for a private network). With any other value they use TLS and verify the server against
   the CA file at `DB_CA_BUNDLE_PATH` (default: the Amazon RDS global bundle baked into the image);
   in production they refuse to start if no CA file is found. For a provider other than RDS, mount
   its CA file into the containers and set `DB_CA_BUNDLE_PATH`. How the Rust services (`capture`,
   `ingest`) negotiate TLS is controlled by their connection string and has not been verified here.
2. Stop depending on the bundled container. The simplest approach is to leave the bundled `postgres`
   container defined but unused; it costs little memory. To remove it entirely you must also remove it
   from `depends_on` of `migrate`, which needs Compose 2.24+ (`depends_on: !reset {}`).
3. Run `docker compose config` and confirm the merged environment.
4. `docker compose run --rm migrate`, then `docker compose up -d`.

The same pattern applies to ClickHouse, NATS and Redis.

## S3 (support attachments)

Skip the `storage` profile and set, in `.env`:

```text
SUPPORT_ATTACHMENTS_BUCKET=my-bucket
AWS_REGION=eu-west-1
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=...
S3_ENDPOINT=                # empty for AWS S3
S3_PUBLIC_ENDPOINT=         # empty for AWS S3 (browsers use the AWS endpoint)
S3_FORCE_PATH_STYLE=false   # false for AWS; true for MinIO and most self-hosted stores
```

Then `docker compose up -d capture`. You must configure the bucket's CORS yourself to allow `PUT`
and `GET` from your Clickroom origin (the bundled Garage does this in `garage-init`). `.env`'s
`S3_*` names are mapped by the compose file to the `AWS_*` names the capture service reads.

## Backups with external services

`backup.sh` and `restore.sh` talk to the bundled `postgres` and `clickhouse` containers via
`docker compose exec`. With external databases they do **not** back up your data; use your provider's
backups, and keep a copy of `.env`.
