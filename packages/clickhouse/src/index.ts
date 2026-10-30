// @clickroom/clickhouse — CH client + migrations. Query builders added earlier.
export const PACKAGE_NAME = '@clickroom/clickhouse'

export { clickhouse, clickhouseConfig, createServerClient } from './client.js'
export { runMigrations } from './migrate.js'
export * from './queries.js'
