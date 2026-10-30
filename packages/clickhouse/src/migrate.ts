import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ClickHouseClient, createClient } from '@clickhouse/client'
import { clickhouseConfig, createServerClient } from './client.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/**
 * Dev-only fallback values for `{{VAR_NAME}}` tokens (see `substituteEnvTokens`) when the
 * corresponding env var isn't set. Production is expected to set these explicitly; add an
 * entry here whenever a migration introduces a new `{{VAR_NAME}}` token.
 */
const ENV_TOKEN_DEV_DEFAULTS: Record<string, string> = {
  CLICKHOUSE_QUERY_PASSWORD: 'clickroom_query_dev',
  // Mirrors clickhouseConfig's own default (client.ts) — a dev fallback for the
  // `{{CLICKHOUSE_DATABASE}}` token used by migration 007's GRANT statements so the
  // grants target whichever database migrations are actually applied against
  // (`clickroom` in dev, `clickroom_e2e` for the isolated e2e stack) rather than a
  // hardcoded name.
  CLICKHOUSE_DATABASE: 'clickroom',
}

/**
 * Replace `{{VAR_NAME}}` placeholder tokens in migration SQL with `process.env.VAR_NAME`.
 * Generic (not tied to any single migration) so any future file can reference env-provided
 * secrets (e.g. RBAC user passwords) without hardcoding them in version control. Unresolved
 * env vars fall back to a known dev default (with a warning) so local/dev migrations still
 * run; there's no `NODE_ENV=production` in this repo's env conventions, so a token with no
 * registered dev default throws rather than silently applying a guessed value.
 */
function substituteEnvTokens(sql: string): string {
  return sql.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, name: string) => {
    const value = process.env[name]
    if (value !== undefined) return value

    const devDefault = ENV_TOKEN_DEV_DEFAULTS[name]
    if (devDefault === undefined) {
      throw new Error(`[clickhouse] env var ${name} is not set and has no registered dev default`)
    }
    console.warn(`[clickhouse] env var ${name} not set, using dev default for {{${name}}}`)
    return devDefault
  })
}

/**
 * Split a .sql file into individual statements on `;` boundaries.
 * Strips `--` line comments first so semicolons inside comments don't break the split.
 *
 * Exported for `migration-guards.test.ts`, which lints every migration for replay-safety and
 * must tokenize statements EXACTLY the way the runner executes them — a second, drifting copy
 * of this logic in the test would lint statements that never actually run.
 *
 * Note this splits naively on `;` and has no notion of string literals, so a `;` inside a
 * quoted value would split a statement in half. That constrains substituted values:
 * `007_query_user.sql` interpolates `{{CLICKHOUSE_QUERY_PASSWORD}}` into a single-quoted SQL
 * literal, which is why that password must stay alphanumeric.
 */
export function splitStatements(sql: string): string[] {
  const stripped = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
  return stripped
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0)
}

/**
 * Tracking table recording which migration files have already been applied to this
 * database, so `runMigrations` only ever executes each `.sql` file once per database
 * (mirrors how `packages/db`/Prisma tracks applied migrations for Postgres). Without
 * this, every invocation replayed every file from scratch — including migrations
 * whose bodies are only safe to run once (e.g. a `DROP TABLE` + recreate), which
 * previously wiped real data on a second `migrate` run.
 */
const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations'

/** Ensure the schema_migrations tracking table exists on `client`'s bound database. */
async function ensureSchemaMigrationsTable(client: ClickHouseClient): Promise<void> {
  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
        name String,
        applied_at DateTime64(3, 'UTC') DEFAULT now64()
      ) ENGINE = MergeTree ORDER BY name
    `,
  })
}

/** Names of migration files already recorded as applied in schema_migrations. */
async function getAppliedMigrations(client: ClickHouseClient): Promise<Set<string>> {
  const rs = await client.query({
    query: `SELECT name FROM ${SCHEMA_MIGRATIONS_TABLE}`,
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ name: string }>()
  return new Set(rows.map((r) => r.name))
}

/** Record `file` as applied in schema_migrations. */
async function recordMigrationApplied(client: ClickHouseClient, file: string): Promise<void> {
  await client.insert({
    table: SCHEMA_MIGRATIONS_TABLE,
    values: [{ name: file }],
    format: 'JSONEachRow',
  })
}

/**
 * Apply every migrations/*.sql in sorted order against the target database
 * (default: CLICKHOUSE_DATABASE / clickhouseConfig — pass `overrides.database`
 * to target a different one, e.g. an isolated test database, from the same
 * process/config). Ensures the database exists first, then ensures a
 * `schema_migrations` tracking table exists and only executes files that
 * aren't already recorded there — each `.sql` file runs at most once per
 * database, so a migration whose body isn't actually safe to replay (e.g. a
 * destructive `DROP TABLE`) can never fire twice. Builds its own scoped
 * client rather than the singleton `clickhouse` export, so it can safely
 * target any database.
 */
export async function runMigrations(overrides?: Partial<typeof clickhouseConfig>): Promise<void> {
  const config = { ...clickhouseConfig, ...overrides }
  const { database } = config

  const server = createServerClient()
  try {
    await server.command({
      query: `CREATE DATABASE IF NOT EXISTS ${database}`,
    })
    console.log(`[clickhouse] database ready: ${database}`)
  } finally {
    await server.close()
  }

  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort()

  if (files.length === 0) {
    console.log('[clickhouse] no migrations found')
    return
  }

  const client = createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
  })
  try {
    await ensureSchemaMigrationsTable(client)
    const applied = await getAppliedMigrations(client)

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[clickhouse] skipped ${file} (already applied)`)
        continue
      }

      const sql = substituteEnvTokens(await readFile(join(MIGRATIONS_DIR, file), 'utf8'))
      const statements = splitStatements(sql)
      for (const query of statements) {
        await client.command({ query })
      }
      await recordMigrationApplied(client, file)
      console.log(`[clickhouse] applied ${file} (${statements.length} statement(s))`)
    }
  } finally {
    await client.close()
  }

  console.log(`[clickhouse] migrations complete (${files.length} file(s))`)
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  runMigrations().catch((err) => {
    console.error('[clickhouse] migration failed:', err)
    process.exit(1)
  })
}
