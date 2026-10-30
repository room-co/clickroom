import { existsSync, readFileSync } from 'node:fs'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { ulid } from 'ulid'

/**
 * ULID generator for application-supplied primary keys.
 * All Postgres PKs are ULID strings; the app supplies them.
 */
export function newId(): string {
  return ulid()
}

// Reuse a single PrismaClient across hot reloads in dev to avoid exhausting
// connections. In prod each process gets exactly one instance.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
}

/**
 * Resolve the Postgres connection URL: a literal `DATABASE_URL` (local dev, CI,
 * seeds) if set, else assembled from the discrete RDS-style vars.
 *
 * The ECS task definitions inject `DB_HOST`/`DB_PORT` as env and `DB_USER`/
 * `DB_PASSWORD` from Secrets Manager, never a composed `DATABASE_URL` — the Rust
 * services have always assembled it themselves (`resolve_database_url` in
 * services/{capture,ingest}/src/config.rs, whose comment claims apps/api does the
 * same). It didn't: without this, `connectionString` was `undefined` in prod and
 * the pg adapter silently fell back to 127.0.0.1:5432, so every query failed with
 * "Can't reach database server at 127.0.0.1:5432" while /health (which touches no
 * database) kept the ALB target green.
 *
 * Throws in production rather than falling back to localhost — a prod process that
 * cannot name its database should die at boot, not serve 500s that look like a
 * network fault.
 */
function resolveDatabaseUrl(): string | undefined {
  const literal = process.env.DATABASE_URL
  if (literal) return literal

  const host = process.env.DB_HOST
  const user = process.env.DB_USER
  const password = process.env.DB_PASSWORD
  if (host && user && password) {
    const port = process.env.DB_PORT ?? '5432'
    const name = process.env.DB_NAME ?? 'clickroom'
    // The password comes from Secrets Manager and can contain URL-significant
    // characters; encode it or the URL parses into a different host entirely.
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'cannot resolve a database connection: set DATABASE_URL, or DB_HOST + DB_USER + DB_PASSWORD',
    )
  }
  return undefined
}

/** Where the image stakes the AWS RDS global CA bundle — see apps/api/Dockerfile. */
const DEFAULT_CA_BUNDLE_PATH = '/etc/ssl/rds/global-bundle.pem'

/** Hosts that are unambiguously a developer's own machine, where no TLS exists at all. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function isLocalHost(url: string): boolean {
  try {
    // `new URL` lowercases the host and strips the port/credentials for us.
    return LOCAL_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * node-postgres resolves `sslmode` from the connection string *after* it merges the
 * explicit `ssl` object, so a stray `?sslmode=require` in the URL replaces our
 * verified config with its own (unverified) one and silently discards the CA. Strip
 * it: the `ssl` object below is the single source of truth for how we negotiate TLS.
 */
function stripSslMode(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('sslmode')
    return parsed.toString()
  } catch {
    return url
  }
}

type TlsConfig = { ca: string; rejectUnauthorized: true }

/**
 * Prod RDS runs with `rds.force_ssl=1`, so the server refuses any plaintext session.
 * `@prisma/adapter-pg` is node-postgres underneath, and node-postgres defaults to *no*
 * TLS — which is why prod surfaced as Prisma P1010 ("User was denied access on the
 * database") rather than anything that mentions SSL.
 *
 * We fix that by verifying against Amazon's RDS global CA bundle, which the api image
 * bakes in at DEFAULT_CA_BUNDLE_PATH. Deliberately *not* the `rejectUnauthorized: false`
 * shortcut some codebases use: that encrypts the wire but authenticates nobody, so anything that
 * can answer on the DB host's port can read our credentials. Hostname verification is left
 * on (no `checkServerIdentity` override) — the RDS cert's CN is the endpoint we dial.
 *
 * Local dev and the test DB speak no TLS at all, so TLS is opt-in by the CA file's
 * existence and never forced at localhost. In production the absence of that file is fatal:
 * fail at boot rather than quietly downgrade to plaintext or to unverified TLS.
 */
function resolveTls(connectionString: string | undefined): TlsConfig | undefined {
  // Explicit opt-out for a Postgres on a private network that speaks no TLS (the self-host
  // compose stack). Never implied: production without this AND without a CA bundle still throws.
  if (process.env.DB_TLS === 'disable') return undefined

  const caPath = process.env.DB_CA_BUNDLE_PATH ?? DEFAULT_CA_BUNDLE_PATH

  if (connectionString && isLocalHost(connectionString)) return undefined

  if (existsSync(caPath)) {
    return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true }
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `cannot establish a verified TLS connection to Postgres: no CA bundle at ${caPath}. ` +
        'Set DB_CA_BUNDLE_PATH, or rebuild the image so it ships the RDS global CA bundle.',
    )
  }
  return undefined
}

// Prisma 7 connects the runtime client through a driver adapter rather than a
// schema-level `url`. The adapter takes a node-postgres PoolConfig, so TLS is
// configured here rather than through the URL.
function createPrisma(): PrismaClient {
  const connectionString = resolveDatabaseUrl()
  const ssl = resolveTls(connectionString)

  const adapter = new PrismaPg({
    connectionString: ssl && connectionString ? stripSslMode(connectionString) : connectionString,
    ...(ssl ? { ssl } : {}),
  })
  return new PrismaClient({ adapter })
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrisma()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

// Tenant auto-scoping (orgId/projectId query injection) lives in
// ./scoped-client.ts — see `createScopedClient`.
