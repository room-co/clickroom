// The `add_support_unread` migration must add the
// two unread counters additively (NOT NULL DEFAULT 0) so existing SupportTicket
// rows backfill to 0. No DB is available in this test env, so we assert on the
// migration SQL + Prisma schema text directly rather than round-tripping through
// Postgres.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationSql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260724130000_add_support_unread/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

const schema = readFileSync(
  fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)),
  'utf8',
)

describe('add_support_unread migration', () => {
  it('adds both unread counters as NOT NULL DEFAULT 0 (existing rows backfill to 0)', () => {
    expect(migrationSql).toContain(
      'ALTER TABLE "SupportTicket" ADD COLUMN "unreadForUser" INTEGER NOT NULL DEFAULT 0;',
    )
    expect(migrationSql).toContain(
      'ALTER TABLE "SupportTicket" ADD COLUMN "unreadForAgent" INTEGER NOT NULL DEFAULT 0;',
    )
  })

  it('is additive only — no destructive DDL', () => {
    expect(migrationSql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i)
    expect(migrationSql).not.toMatch(/\bTRUNCATE\b/i)
  })
})

describe('SupportTicket schema', () => {
  it('declares both counters with a default of 0', () => {
    expect(schema).toMatch(/unreadForUser\s+Int\s+@default\(0\)/)
    expect(schema).toMatch(/unreadForAgent\s+Int\s+@default\(0\)/)
  })

  it("documents the 'ai' author type on SupportTicketMessage", () => {
    expect(schema).toContain("// 'user' | 'agent' | 'ai' | 'system'")
  })
})
