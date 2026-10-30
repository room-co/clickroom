import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

export async function setup() {
  const dbUrl = process.env.TEST_DATABASE_URL
  if (!dbUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Add it to .env to run integration tests against an isolated database.',
    )
  }
  const dbPackageDir = resolve(process.cwd(), '../../packages/db')
  const prismaPath = resolve(dbPackageDir, 'node_modules/.bin/prisma')
  // Prisma 7 auto-discovers prisma.config.ts (which holds datasource.url) from
  // cwd — must run from packages/db, not apps/api, for it to be found.
  execSync(`${prismaPath} migrate deploy`, {
    cwd: dbPackageDir,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'inherit',
  })

  const chDatabase = process.env.TEST_CLICKHOUSE_DATABASE
  if (!chDatabase) {
    throw new Error(
      'TEST_CLICKHOUSE_DATABASE is not set. Add it to .env to run integration tests against an isolated ClickHouse database.',
    )
  }
  const { runMigrations } = await import('@clickroom/clickhouse')
  await runMigrations({ database: chDatabase })
}
