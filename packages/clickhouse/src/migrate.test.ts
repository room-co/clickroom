import { createClient } from '@clickhouse/client'
import { afterAll, describe, expect, it } from 'vitest'
import { clickhouseConfig } from './client.js'
import { runMigrations } from './migrate.js'

// Isolated database so this test never touches dev/CI-shared data, and can be safely
// dropped/recreated across runs. Applying every migration against a real ClickHouse
// instance (rather than mocking) is the only way to actually prove migration 008's
// `DROP TABLE events` doesn't fire again on a second `runMigrations` call.
const TEST_DB = 'clickroom_migrate_test'

async function dropTestDatabase() {
  const server = createClient({
    url: clickhouseConfig.url,
    username: clickhouseConfig.username,
    password: clickhouseConfig.password,
  })
  try {
    await server.command({ query: `DROP DATABASE IF EXISTS ${TEST_DB}` })
  } finally {
    await server.close()
  }
}

describe('runMigrations', () => {
  afterAll(async () => {
    await dropTestDatabase()
  })

  it('applies each migration file at most once per database, recording it in schema_migrations', async () => {
    await dropTestDatabase()

    // First run: fresh database, every migration file should apply.
    const firstRunLogs: string[] = []
    const logSpy = (msg: string) => firstRunLogs.push(msg)
    const originalLog = console.log
    console.log = logSpy
    try {
      await runMigrations({ database: TEST_DB })
    } finally {
      console.log = originalLog
    }
    const appliedOnFirstRun = firstRunLogs.filter((l) => l.includes('applied '))
    expect(appliedOnFirstRun.length).toBeGreaterThan(0)
    expect(firstRunLogs.some((l) => l.includes('skipped '))).toBe(false)

    const client = createClient({
      url: clickhouseConfig.url,
      username: clickhouseConfig.username,
      password: clickhouseConfig.password,
      database: TEST_DB,
    })
    try {
      const rs = await client.query({
        query: 'SELECT name FROM schema_migrations ORDER BY name',
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ name: string }>()
      expect(rows.length).toBe(appliedOnFirstRun.length)
      expect(rows.some((r) => r.name === '008_events_uuid_dedup.sql')).toBe(true)

      // Insert a sentinel row into `events` so we can prove a second `runMigrations`
      // call does not re-run migration 008's `DROP TABLE IF EXISTS events`.
      await client.command({
        query: `
          INSERT INTO events (uuid, event, project_id, timestamp)
          VALUES (generateUUIDv4(), 'sentinel', 'p_test', now64())
        `,
      })
    } finally {
      await client.close()
    }

    // Second run: every file should now be skipped, and the sentinel row must survive.
    const secondRunLogs: string[] = []
    console.log = (msg: string) => secondRunLogs.push(msg)
    try {
      await runMigrations({ database: TEST_DB })
    } finally {
      console.log = originalLog
    }
    expect(secondRunLogs.some((l) => l.includes('applied '))).toBe(false)
    const skippedOnSecondRun = secondRunLogs.filter((l) => l.includes('skipped '))
    expect(skippedOnSecondRun.length).toBe(appliedOnFirstRun.length)

    const verifyClient = createClient({
      url: clickhouseConfig.url,
      username: clickhouseConfig.username,
      password: clickhouseConfig.password,
      database: TEST_DB,
    })
    try {
      const rs = await verifyClient.query({
        query: "SELECT count() AS c FROM events WHERE event = 'sentinel'",
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ c: string }>()
      expect(Number(rows[0]?.c)).toBe(1)
    } finally {
      await verifyClient.close()
    }
  })
})
