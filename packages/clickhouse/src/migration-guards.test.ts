import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { splitStatements } from './migrate.js'

// ── Why this test exists ────────────────────────────────────────────────────────────────
// ClickHouse has no transactional DDL, and `runMigrations` records a file in
// `schema_migrations` only AFTER all of its statements succeed. So a migration that dies
// partway through leaves its earlier statements applied but the file UNRECORDED — and the next
// run replays it from the top. Replay is therefore not an edge case, it is the normal recovery
// path, and every statement has to survive being executed a second time.
//
// Nothing in the runner enforces that. It was a convention held only by whoever wrote each file,
// and `008_events_uuid_dedup.sql` had already broken it with a bare `CREATE TABLE events`. This
// test makes the convention mechanical.
//
// Static by design: it reads the .sql files and needs no ClickHouse. (`migrate.test.ts` is the
// one that talks to a real server.) It uses the runner's own `splitStatements` so it lints
// exactly the statements the runner executes.

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/** Object kinds that `CREATE`/`DROP` can name. Multi-word kinds must precede their prefixes. */
const OBJECT_KINDS = [
  'MATERIALIZED VIEW',
  'LIVE VIEW',
  'SETTINGS PROFILE',
  'ROW POLICY',
  'NAMED COLLECTION',
  'DICTIONARY',
  'DATABASE',
  'FUNCTION',
  'QUOTA',
  'TABLE',
  'VIEW',
  'USER',
  'ROLE',
]
  .map((k) => k.replace(/ /g, '\\s+'))
  .join('|')

const CREATE_RE = new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:${OBJECT_KINDS})\\b`, 'i')
const CREATE_GUARDED_RE = new RegExp(
  // `CREATE OR REPLACE x` is idempotent by construction and needs no IF NOT EXISTS.
  `^CREATE\\s+(?:(?:OR\\s+REPLACE\\s+)(?:${OBJECT_KINDS})\\b|(?:${OBJECT_KINDS})\\s+IF\\s+NOT\\s+EXISTS\\b)`,
  'i',
)
const DROP_RE = new RegExp(`^DROP\\s+(?:${OBJECT_KINDS})\\b`, 'i')
const DROP_GUARDED_RE = new RegExp(`^DROP\\s+(?:${OBJECT_KINDS})\\s+IF\\s+EXISTS\\b`, 'i')

/** Inherently idempotent in ClickHouse — re-running is a no-op, no guard clause exists. */
const IDEMPOTENT_BY_NATURE_RE = /^(GRANT|REVOKE|SET|OPTIMIZE|SYSTEM|ATTACH|DETACH)\b/i

/**
 * `ALTER TABLE` carries multiple comma-separated clauses in one statement
 * (`006_events_schema_validation.sql` has two `ADD COLUMN`s), and the commas can also appear
 * inside DEFAULT/MATERIALIZED expressions — so we scan for the clause keywords rather than
 * trying to split on commas.
 */
function alterClauseViolations(stmt: string): string[] {
  const problems: string[] = []
  if (/\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(stmt)) {
    problems.push('ADD COLUMN without IF NOT EXISTS')
  }
  if (/\bDROP\s+COLUMN\s+(?!IF\s+EXISTS\b)/i.test(stmt)) {
    problems.push('DROP COLUMN without IF EXISTS')
  }
  if (/\bADD\s+INDEX\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(stmt)) {
    problems.push('ADD INDEX without IF NOT EXISTS')
  }
  if (/\bDROP\s+INDEX\s+(?!IF\s+EXISTS\b)/i.test(stmt)) {
    problems.push('DROP INDEX without IF EXISTS')
  }
  return problems
}

/** Returns a human-readable reason the statement is NOT replay-safe, or null if it is. */
function replaySafetyViolation(stmt: string): string | null {
  const s = stmt.trim()

  if (/^ALTER\s+TABLE\b/i.test(s)) {
    const problems = alterClauseViolations(s)
    return problems.length > 0 ? problems.join('; ') : null
  }
  if (CREATE_RE.test(s)) {
    return CREATE_GUARDED_RE.test(s) ? null : 'CREATE without IF NOT EXISTS (or OR REPLACE)'
  }
  if (DROP_RE.test(s)) {
    return DROP_GUARDED_RE.test(s) ? null : 'DROP without IF EXISTS'
  }
  if (IDEMPOTENT_BY_NATURE_RE.test(s)) return null

  // Fail closed. An unrecognized statement kind is not silently blessed — if a migration needs
  // one, add it to the rules above and state why re-running it is safe.
  return 'unrecognized statement kind — extend migration-guards.test.ts and justify its replay safety'
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

describe('clickhouse migrations are replay-safe', () => {
  it('finds the migration files', () => {
    expect(migrationFiles().length).toBeGreaterThan(0)
  })

  it.each(migrationFiles())('%s — every statement is idempotent', (file) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    const violations = splitStatements(sql).flatMap((stmt) => {
      const reason = replaySafetyViolation(stmt)
      if (!reason) return []
      const head = stmt.split('\n')[0].slice(0, 80)
      return [`  ${reason}\n    → ${head}`]
    })

    expect(
      violations,
      `${file} has statement(s) that would fail or destroy data if the migration is replayed ` +
        `after a partial failure:\n${violations.join('\n')}\n\n` +
        'ClickHouse has no transactional DDL, so a migration that fails partway is re-run from ' +
        'the top. Guard every statement (CREATE ... IF NOT EXISTS / DROP ... IF EXISTS / ' +
        'ALTER TABLE ADD COLUMN IF NOT EXISTS).',
    ).toEqual([])
  })
})

describe('replaySafetyViolation', () => {
  it.each([
    'CREATE TABLE IF NOT EXISTS events (a String)',
    'CREATE MATERIALIZED VIEW IF NOT EXISTS mv TO t AS SELECT 1',
    'CREATE SETTINGS PROFILE IF NOT EXISTS p SETTINGS readonly = 1',
    'CREATE OR REPLACE VIEW v AS SELECT 1',
    'DROP TABLE IF EXISTS events',
    'ALTER TABLE events ADD COLUMN IF NOT EXISTS a String',
    'ALTER TABLE events ADD COLUMN IF NOT EXISTS a String, ADD COLUMN IF NOT EXISTS b String',
    'GRANT SELECT ON db.events TO clickroom_query',
  ])('accepts %s', (stmt) => {
    expect(replaySafetyViolation(stmt)).toBeNull()
  })

  it.each([
    // The exact shape 008_events_uuid_dedup.sql shipped with.
    ['CREATE TABLE events (a String)', /CREATE without IF NOT EXISTS/],
    ['DROP TABLE events', /DROP without IF EXISTS/],
    ['ALTER TABLE events ADD COLUMN a String', /ADD COLUMN without IF NOT EXISTS/],
    ['ALTER TABLE events DROP COLUMN a', /DROP COLUMN without IF EXISTS/],
    // Guarded first clause must not excuse an unguarded second one.
    [
      'ALTER TABLE events ADD COLUMN IF NOT EXISTS a String, ADD COLUMN b String',
      /ADD COLUMN without IF NOT EXISTS/,
    ],
    ['TRUNCATE TABLE events', /unrecognized statement kind/],
  ])('rejects %s', (stmt, expected) => {
    expect(replaySafetyViolation(stmt as string)).toMatch(expected as RegExp)
  })
})
