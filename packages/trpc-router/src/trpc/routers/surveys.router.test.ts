import type { Permission } from '@clickroom/auth'
import { requestContextStorage } from '@clickroom/db'
import type { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Unit test — no Postgres, no ClickHouse. The scoped Prisma client is stubbed
// with in-memory tables so we can assert the linked-flag auto-create runs in
// one transaction, CRUD works, and the RBAC->entitlement gate order holds.
// The real `EntitlementService` + `PLAN_FEATURES` make the plan decision.
let currentPlanKey: string | null = null
let grantedPermissions: Set<Permission> = new Set()

// In-memory stores rebuilt each test.
type Row = Record<string, unknown>
let surveys: Row[] = []
let flags: Row[] = []
let flagAudits: Row[] = []

function makeTable(store: () => Row[]) {
  return {
    create: async ({ data }: { data: Row }) => {
      const row = { ...data, version: (data.version as number) ?? 1 }
      store().push(row)
      return row
    },
    findFirst: async ({ where }: { where: Row }) => matchOne(store(), where),
    findFirstOrThrow: async ({ where }: { where: Row }) => {
      const row = matchOne(store(), where)
      if (!row) throw new Error('not found')
      return row
    },
    findMany: async ({ where }: { where?: Row } = {}) =>
      store().filter((r) => matches(r, where ?? {})),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const targets = store().filter((r) => matches(r, where))
      for (const r of targets) applyData(r, data)
      return { count: targets.length }
    },
  }
}

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Row)) {
      row[k] = (row[k] as number) + (v as { increment: number }).increment
    } else {
      row[k] = v
    }
  }
}

function matchOne(rows: Row[], where: Row) {
  return rows.find((r) => matches(r, where))
}

function matches(row: Row, where: Row) {
  return Object.entries(where).every(([k, v]) => {
    if (v === null) return row[k] === null || row[k] === undefined
    return row[k] === v
  })
}

// A survey's linked flag now lives in EVERY environment (one row per env sharing
// a key), so the stub project has two: the default (production) plus development.
const ENVIRONMENTS = [
  { id: 'env_1', key: 'production', isDefault: true },
  { id: 'env_2', key: 'development', isDefault: false },
]
const envForRow = (row: Row) =>
  ENVIRONMENTS.find((e) => e.id === row.environmentId) ?? ENVIRONMENTS[0]

const scopedClient = () => {
  const survey = makeTable(() => surveys)
  const flagAudit = makeTable(() => flagAudits)
  const flagTable = makeTable(() => flags)
  // The survey paths select `environment: { select: { id, key } }` on the flag
  // — the stub ignores `select`, so synthesize the joined relation on reads
  // (both findFirst and findMany) from the row's `environmentId`.
  const featureFlag = {
    ...flagTable,
    findFirst: async (args: { where: Row }) => {
      const row = await flagTable.findFirst(args)
      return row ? { ...row, environment: envForRow(row) } : row
    },
    findMany: async (args?: { where?: Row }) => {
      const rows = await flagTable.findMany(args)
      return rows.map((r) => ({ ...r, environment: envForRow(r) }))
    },
  }
  return {
    org: { findUnique: async () => orgRow(), findFirst: async () => orgRow() },
    project: { findFirst: async () => ({ id: 'proj_1', orgId: 'org_1' }) },
    environment: {
      findFirst: async ({ where }: { where?: Row } = {}) =>
        where?.isDefault ? ENVIRONMENTS.find((e) => e.isDefault) : ENVIRONMENTS[0],
      findFirstOrThrow: async () => ENVIRONMENTS[0],
      findMany: async () => ENVIRONMENTS.map((e) => ({ ...e })),
    },
    survey,
    featureFlag,
    flagAudit,
    // Sequential in-memory transaction — the callback runs against the same
    // stubbed tables, so a failure would surface synchronously in the test.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ survey, featureFlag, flagAudit }),
  }
}

vi.mock('@clickroom/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clickroom/db')>()
  return {
    ...actual,
    prisma: {} as unknown,
    createScopedClient: () => scopedClient(),
  }
})

vi.mock('@clickroom/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clickroom/auth')>()
  return {
    ...actual,
    can: (_role: string, perm: Permission) => grantedPermissions.has(perm),
  }
})

// Redis-backed cache helpers are no-ops here — we assert on the Postgres writes.
vi.mock('../../lib/redis.js', () => ({
  redis: { publish: async () => 0 },
  cacheSetJson: async () => undefined,
}))

function orgRow() {
  return { plan: currentPlanKey ? { key: currentPlanKey } : null }
}

const { appRouter } = await import('../app.router.js')

type AppContext = Parameters<typeof appRouter.createCaller>[0]

function caller() {
  return appRouter.createCaller({
    tokenPayload: { sub: 'user_1', sessionId: 'test', orgId: 'org_1' },
  } as unknown as AppContext)
}

function run<T>(fn: () => Promise<T>) {
  return requestContextStorage.run(
    { userId: 'user_1', orgId: 'org_1', orgRole: 'org_admin', authSource: 'jwt' },
    fn,
  )
}

const DEFINITION = {
  version: 1 as const,
  questions: [
    {
      type: 'rating' as const,
      id: 'q1',
      question: 'How satisfied are you?',
      scale: 5 as const,
      display: 'number' as const,
      preset: 'csat' as const,
    },
  ],
  appearance: { position: 'bottom_right' as const },
  triggers: { frequency: 'once' as const },
}

beforeEach(() => {
  currentPlanKey = 'pro'
  grantedPermissions = new Set<Permission>(['projects:read', 'projects:manage'])
  surveys = []
  flags = []
  flagAudits = []
})

describe('surveys.create', () => {
  it('auto-creates a linked boolean flag per environment in one transaction', async () => {
    const survey = await run(() =>
      caller().surveys.create({ projectId: 'proj_1', name: 'CSAT', definition: DEFINITION }),
    )

    expect(survey).toMatchObject({ name: 'CSAT', status: 'draft', version: 1 })
    expect(survey.createdBy).toBe('user_1')

    // One linked flag PER environment (production + development), all sharing a
    // single key, all off by default, boolean kind.
    expect(flags).toHaveLength(2)
    const keys = new Set(flags.map((f) => String(f.key)))
    expect(keys.size).toBe(1)
    const [onlyKey] = [...keys]
    expect(onlyKey).toMatch(/^survey-csat-/)
    const envIds = new Set(flags.map((f) => f.environmentId))
    expect(envIds).toEqual(new Set(['env_1', 'env_2']))
    for (const flag of flags) {
      expect(flag.active).toBe(false)
      expect(flag.track).toBe(false)
      expect((flag.filters as { kind: string }).kind).toBe('boolean')
    }

    // The survey points at the DEFAULT environment's (env_1) row.
    const defaultFlag = flags.find((f) => f.environmentId === 'env_1')
    expect(survey.featureFlagId).toBe(defaultFlag?.id)

    // An audit row recorded for each created flag.
    expect(flagAudits).toHaveLength(2)
    expect(flagAudits.every((a) => a.action === 'created')).toBe(true)
    expect(new Set(flagAudits.map((a) => a.flagId))).toEqual(new Set(flags.map((f) => f.id)))
  })
})

describe('surveys CRUD', () => {
  it('lists, gets, and filters by status', async () => {
    await run(() =>
      caller().surveys.create({ projectId: 'proj_1', name: 'A', definition: DEFINITION }),
    )
    const list = await run(() => caller().surveys.list({ projectId: 'proj_1' }))
    expect(list).toHaveLength(1)

    const got = await run(() => caller().surveys.get({ projectId: 'proj_1', id: list[0].id }))
    expect(got.name).toBe('A')

    const active = await run(() => caller().surveys.list({ projectId: 'proj_1', status: 'active' }))
    expect(active).toHaveLength(0)
  })

  it('bumps version on a definition edit and allows status transitions', async () => {
    const created = await run(() =>
      caller().surveys.create({ projectId: 'proj_1', name: 'A', definition: DEFINITION }),
    )
    expect(created.version).toBe(1)

    const activated = await run(() =>
      caller().surveys.update({
        projectId: 'proj_1',
        id: created.id,
        patch: { status: 'active' },
      }),
    )
    // Status-only edit does NOT bump version.
    expect(activated).toMatchObject({ status: 'active', version: 1 })

    const edited = await run(() =>
      caller().surveys.update({
        projectId: 'proj_1',
        id: created.id,
        patch: { definition: DEFINITION },
      }),
    )
    expect(edited.version).toBe(2)
  })

  it("drives EVERY environment's linked flag active from a status change", async () => {
    const created = await run(() =>
      caller().surveys.create({ projectId: 'proj_1', name: 'A', definition: DEFINITION }),
    )
    // Both env flags ship off.
    expect(flags.every((f) => f.active === false)).toBe(true)

    // Activating the survey enables ALL its flags, records an `updated` audit
    // per flag, and bumps every flag version.
    await run(() =>
      caller().surveys.update({ projectId: 'proj_1', id: created.id, patch: { status: 'active' } }),
    )
    expect(flags.every((f) => f.active === true)).toBe(true)
    expect(flags.every((f) => f.version === 2)).toBe(true)
    for (const f of flags) {
      expect(flagAudits.some((a) => a.action === 'updated' && a.flagId === f.id)).toBe(true)
    }

    // Back to draft disables every flag again.
    await run(() =>
      caller().surveys.update({ projectId: 'proj_1', id: created.id, patch: { status: 'draft' } }),
    )
    expect(flags.every((f) => f.active === false)).toBe(true)

    // Archiving keeps every flag off.
    await run(() =>
      caller().surveys.update({
        projectId: 'proj_1',
        id: created.id,
        patch: { status: 'archived' },
      }),
    )
    expect(flags.every((f) => f.active === false)).toBe(true)
  })

  it('does not churn the linked flag on a non-status edit', async () => {
    const created = await run(() =>
      caller().surveys.create({ projectId: 'proj_1', name: 'A', definition: DEFINITION }),
    )
    const flagVersion = flags[0].version
    const auditCount = flagAudits.length

    await run(() =>
      caller().surveys.update({ projectId: 'proj_1', id: created.id, patch: { name: 'B' } }),
    )
    // Flag untouched: no version bump, no new audit.
    expect(flags[0].version).toBe(flagVersion)
    expect(flagAudits).toHaveLength(auditCount)
  })

  it('soft-deletes the survey and its linked flag', async () => {
    const created = await run(() =>
      caller().surveys.create({ projectId: 'proj_1', name: 'A', definition: DEFINITION }),
    )

    const res = await run(() => caller().surveys.delete({ projectId: 'proj_1', id: created.id }))
    expect(res).toEqual({ id: created.id, deleted: true })

    expect(surveys[0].deletedAt).toBeInstanceOf(Date)
    // Every environment's linked flag is soft-deleted, each with a delete audit.
    expect(flags.every((f) => f.deletedAt instanceof Date)).toBe(true)
    for (const f of flags) {
      expect(flagAudits.some((a) => a.action === 'deleted' && a.flagId === f.id)).toBe(true)
    }
  })

  it('throws NOT_FOUND getting a missing survey', async () => {
    const err = await run(() =>
      caller()
        .surveys.get({ projectId: 'proj_1', id: 'nope' })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).code).toBe('NOT_FOUND')
  })
})

describe('surveys entitlement + RBAC gates', () => {
  it('denies a free org with not_entitled / surveys', async () => {
    currentPlanKey = 'free'
    const err = await run(() =>
      caller()
        .surveys.list({ projectId: 'proj_1' })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).code).toBe('FORBIDDEN')
    expect((err as TRPCError).cause).toMatchObject({ code: 'not_entitled', feature: 'surveys' })
  })

  it('returns the permissions error, not the entitlement error, without projects:manage', async () => {
    grantedPermissions = new Set<Permission>(['projects:read'])
    const err = await run(() =>
      caller()
        .surveys.create({ projectId: 'proj_1', name: 'A', definition: DEFINITION })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).code).toBe('FORBIDDEN')
    expect((err as TRPCError).message).toBe('Insufficient permissions.')
    expect(flags).toHaveLength(0)
  })

  it('results.* are entitlement-gated (free org denied before any ClickHouse read)', async () => {
    currentPlanKey = 'free'
    const err = await run(() =>
      caller()
        .surveys.results.responseRate({
          projectId: 'proj_1',
          surveyId: 's1',
          range: { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
        })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).code).toBe('FORBIDDEN')
    expect((err as TRPCError).cause).toMatchObject({ code: 'not_entitled', feature: 'surveys' })
  })

  it('results.* require projects:read (no read permission -> permissions error)', async () => {
    grantedPermissions = new Set<Permission>()
    const err = await run(() =>
      caller()
        .surveys.results.responseRate({
          projectId: 'proj_1',
          surveyId: 's1',
          range: { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
        })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).code).toBe('FORBIDDEN')
    expect((err as TRPCError).message).toBe('Insufficient permissions.')
  })

  const RANGE = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' }

  it('results.openResponses is entitlement-gated (free org denied before ClickHouse)', async () => {
    currentPlanKey = 'free'
    const err = await run(() =>
      caller()
        .surveys.results.openResponses({
          projectId: 'proj_1',
          surveyId: 's1',
          questionId: 'q1',
          range: RANGE,
          limit: 20,
          offset: 0,
        })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).code).toBe('FORBIDDEN')
    expect((err as TRPCError).cause).toMatchObject({ code: 'not_entitled', feature: 'surveys' })
  })

  it('results.respondent is entitlement-gated (free org denied before ClickHouse)', async () => {
    currentPlanKey = 'free'
    const err = await run(() =>
      caller()
        .surveys.results.respondent({
          projectId: 'proj_1',
          surveyId: 's1',
          distinctId: 'user_1',
          range: RANGE,
        })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).code).toBe('FORBIDDEN')
    expect((err as TRPCError).cause).toMatchObject({ code: 'not_entitled', feature: 'surveys' })
  })
})
