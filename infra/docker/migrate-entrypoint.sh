#!/bin/sh
#
# Schema + reference-data bootstrap. CMD of infra/docker/Dockerfile.migrate. Runs as the
# one-shot `migrate` service in deploy/selfhost/docker-compose.yml (services start only after
# it exits 0) and, for the hosted deployment, as a one-off ECS task that blocks the rollout.
#
# Connection inputs (either form):
#   * DATABASE_URL=postgresql://user:pass@host:5432/db   — portable / self-host. Used verbatim:
#     no TLS is added or removed; put `?sslmode=require` in the URL if you want it.
#   * DB_HOST + DB_USER + DB_PASSWORD [+ DB_PORT, DB_NAME] — hosted/RDS shape. The URL is composed
#     here and TLS defaults to verified (`sslmode=require&sslaccept=strict`); override with
#     DB_SSL_PARAMS (set it to an empty string for plaintext).
#
# The three steps are the same pnpm scripts `make migrate` (Makefile:94-98) and `seed:plans`
# run against the local docker stack — deliberately identical, so dev bootstrap and prod
# bootstrap cannot drift:
#
#   1. prisma migrate deploy                        (Postgres schema — tracked in _prisma_migrations)
#   2. pnpm --filter @clickroom/clickhouse migrate   (ClickHouse schema — tracked in schema_migrations)
#   3. pnpm --filter @clickroom/db seed:plans        (Plan rows + Org.planId backfill — pure upserts)
#
# All three are idempotent, so this runs on EVERY deploy rather than being gated on a "first
# deploy" flag someone has to remember to flip.
#
# Step 2 MUST go through the runner, never `clickhouse-client` with hand-applied SQL:
# `packages/clickhouse/migrations/008_events_uuid_dedup.sql` is a DROP TABLE + recreate, and it
# is safe only because the runner records it in `schema_migrations` and therefore never replays
# it. Hand-applying leaves that table empty and the next legitimate run drops the events table —
# by then with real data in it.

set -eu

fail() {
  echo "[migrate] FATAL: $1" >&2
  exit 1
}

: "${CLICKHOUSE_URL:?}"
if [ -z "${DATABASE_URL:-}" ]; then
  : "${DB_HOST:?set DATABASE_URL, or DB_HOST + DB_USER + DB_PASSWORD}"
  : "${DB_USER:?}"
  : "${DB_PASSWORD:?}"
fi

# Migration 007 creates the read-only `clickroom_query` ClickHouse user with
# `IDENTIFIED BY '{{CLICKHOUSE_QUERY_PASSWORD}}'`. If the var is unset, the runner only
# `console.warn`s and substitutes the dev default `clickroom_query_dev` — a password committed
# to git (packages/clickhouse/src/migrate.ts:37-42). Refuse to run rather than mint a prod user
# with a public password; set it to a strong secret
# of your own (see docs/self-host/configuration.md).
[ -n "${CLICKHOUSE_QUERY_PASSWORD:-}" ] || fail \
  'CLICKHOUSE_QUERY_PASSWORD is empty — refusing to run migration 007 with the committed dev default'

if [ -n "${DATABASE_URL:-}" ]; then
  DB_LABEL="DATABASE_URL"
else
  # TLS to RDS. `sslaccept=strict` is load-bearing and must not be dropped: Prisma's engine
  # defaults to accept_invalid_certs, which would encrypt the wire but authenticate nobody.
  #
  # Deliberately NO `sslcert` here. The engine reads that param with native_tls's single-cert PEM
  # parser, so pointing it at Amazon's multi-cert global bundle makes it trust only the bundle's
  # first root (sa-east-1's) and reject every us-east-1 chain with P1011. The RDS roots are instead
  # installed into the image's system trust store (Dockerfile.migrate, WITH_RDS_CA=true), which the
  # engine adds to rather than replaces. `sslmode=verify-full` is not an option: the engine
  # silently downgrades unknown modes to `prefer`.
  DB_SSL_PARAMS="${DB_SSL_PARAMS-sslmode=require&sslaccept=strict}"
  export DB_SSL_PARAMS

  # Built with node rather than string concatenation because a generated password can contain
  # URL-significant characters, which would otherwise reparse the URL into a different host.
  DATABASE_URL=$(node -e '
    const enc = encodeURIComponent
    const { DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, DB_NAME, DB_SSL_PARAMS } = process.env
    const host = `${DB_HOST}:${DB_PORT || "5432"}`
    const qs = DB_SSL_PARAMS ? `?${DB_SSL_PARAMS}` : ""
    process.stdout.write(
      `postgresql://${enc(DB_USER)}:${enc(DB_PASSWORD)}@${host}/${DB_NAME || "clickroom"}${qs}`,
    )
  ') || fail 'could not compose DATABASE_URL'
  DB_LABEL="${DB_HOST}"
  # Scoped to `prisma migrate deploy` below, NOT exported: step 3 goes through packages/db's
  # PrismaClient, which composes its own URL from DB_* and configures TLS as a node-postgres
  # `ssl` object (src/client.ts). Handing node-postgres a URL carrying `sslcert` would make it
  # read that as a *client* certificate path and break the connection.
  COMPOSED_DATABASE_URL="$DATABASE_URL"
  unset DATABASE_URL
fi

echo "[migrate] 1/3 prisma migrate deploy → ${DB_LABEL}"
DATABASE_URL="${COMPOSED_DATABASE_URL:-${DATABASE_URL:-}}" pnpm --filter @clickroom/db exec prisma migrate deploy

echo "[migrate] 2/3 clickhouse migrate → ${CLICKHOUSE_URL} (db: ${CLICKHOUSE_DATABASE:-clickroom})"
pnpm --filter @clickroom/clickhouse migrate

echo "[migrate] 3/3 seed:plans (Plan upsert + Org.planId backfill)"
pnpm --filter @clickroom/db seed:plans

echo "[migrate] done — all three steps applied"
