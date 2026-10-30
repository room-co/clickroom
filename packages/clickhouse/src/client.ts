import { type ClickHouseClient, createClient } from '@clickhouse/client'

/**
 * CLICKHOUSE_PASSWORD has no safe default: the dev literal is only usable when NODE_ENV is
 * development/test (same rule as `resolveSecret` in @clickroom/auth, inlined to avoid a dep).
 */
export function resolveClickhousePassword(env: Record<string, string | undefined> = process.env) {
  if (env.CLICKHOUSE_PASSWORD) return env.CLICKHOUSE_PASSWORD
  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') return 'clickroom'
  throw new Error(
    'CLICKHOUSE_PASSWORD is required (the dev default is only usable when NODE_ENV is development or test)',
  )
}

/** Resolved ClickHouse connection config from CLICKHOUSE_* env vars (sane local defaults). */
export const clickhouseConfig = {
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER ?? 'clickroom',
  password: resolveClickhousePassword(),
  database: process.env.CLICKHOUSE_DATABASE ?? 'clickroom',
} as const

/**
 * Shared, configured ClickHouse client. Reused by other packages (ingest, query builders).
 * Bound to the configured database.
 */
export const clickhouse: ClickHouseClient = createClient({
  url: clickhouseConfig.url,
  username: clickhouseConfig.username,
  password: clickhouseConfig.password,
  database: clickhouseConfig.database,
})

/** Create a fresh client not bound to any database (used to CREATE DATABASE during migration). */
export function createServerClient(): ClickHouseClient {
  return createClient({
    url: clickhouseConfig.url,
    username: clickhouseConfig.username,
    password: clickhouseConfig.password,
  })
}
