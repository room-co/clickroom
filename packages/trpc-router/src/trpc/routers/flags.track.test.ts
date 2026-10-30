import { requestContextStorage } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// This package's vitest config runs PURE unit tests only (see vitest.config.ts) —
// the live-Postgres router suites live in `apps/api`. So `track` pin
// logic is exercised here against a tiny in-memory Prisma stand-in: `@clickroom/db`
// is stubbed so `createScopedClient` returns a store-backed fake, and the Redis
// blob/pubsub writes (rebuildFlagCache / recordFlagAudit) are stubbed to no-ops.
// The real router code — create/update pin guard, experiment launch — runs
// unchanged, which is the point.

interface FlagRow {
  id: string
  projectId: string
  key: string
  name: string | null
  active: boolean
  track: boolean
  environmentId: string
  tags: string[]
  filters: unknown
  version: number
  deletedAt: Date | null
}

interface ExperimentRow {
  id: string
  projectId: string
  featureFlagId: string
  status: string
  deletedAt: Date | null
}

const ENV = { id: 'env_1', key: 'production' }
const store: { flags: FlagRow[]; experiments: ExperimentRow[] } = { flags: [], experiments: [] }

/** Scalar/`null`-equality matcher over a `where`; object values (relations,
 * increments) are ignored — the fakes below only query on scalar columns. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v === null) {
      if (row[k] != null) return false
    } else if (typeof v !== 'object') {
      if (row[k] !== v) return false
    }
  }
  return true
}

/** Apply a Prisma `data` payload, honouring `{ increment }` on numeric fields. */
function applyData(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as object)) {
      row[k] = (row[k] as number) + (v as { increment: number }).increment
    } else {
      row[k] = v
    }
  }
}

function withEnv(flag: FlagRow) {
  return { ...flag, environment: { ...ENV } }
}

const fakeClient = {
  project: {
    findFirst: async () => ({ id: 'proj_1', orgId: 'org_1' }),
  },
  featureFlag: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const f = store.flags.find((r) => matches(r, where))
      return f ? withEnv(f) : null
    },
    findFirstOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
      const f = store.flags.find((r) => matches(r, where))
      if (!f) throw new Error('not found')
      return withEnv(f)
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      store.flags.filter((r) => matches(r, where)).map(withEnv),
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }) => {
      const hits = store.flags.filter((r) => matches(r, where))
      for (const h of hits) applyData(h as unknown as Record<string, unknown>, data)
      return { count: hits.length }
    },
  },
  experiment: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      store.experiments.find((r) => matches(r, where)) ?? null,
    findFirstOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
      const e = store.experiments.find((r) => matches(r, where))
      if (!e) throw new Error('not found')
      return e
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }) => {
      const hits = store.experiments.filter((r) => matches(r, where))
      for (const h of hits) applyData(h as unknown as Record<string, unknown>, data)
      return { count: hits.length }
    },
  },
  flagAudit: {
    create: async () => ({}),
  },
}

vi.mock('@clickroom/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clickroom/db')>()
  return {
    ...actual,
    prisma: {} as unknown,
    createScopedClient: () => fakeClient,
  }
})

// Redis blob/pubsub writes are irrelevant to the pin logic — stub them so no
// connection is attempted in the pure-unit environment.
vi.mock('../../lib/redis.js', () => ({
  redis: { publish: async () => 0 },
  cacheSetJson: async () => {},
  cacheGetJson: async () => null,
  cacheBust: async () => {},
}))

const { flagsRouter, TRACK_PIN_ERROR_MESSAGE } = await import('./flags.router.js')
const { experimentsRouter } = await import('./experiments.router.js')
const { router } = await import('../trpc.js')

const appRouter = router({ flags: flagsRouter, experiments: experimentsRouter })
type Ctx = Parameters<typeof appRouter.createCaller>[0]

function caller() {
  const c = appRouter.createCaller({
    tokenPayload: { sub: 'user_1', sessionId: 'test', orgId: 'org_1' },
  } as unknown as Ctx)
  return {
    run: <T>(fn: (caller: typeof c) => Promise<T>) =>
      requestContextStorage.run(
        { userId: 'user_1', orgId: 'org_1', orgRole: 'org_admin', authSource: 'jwt' },
        () => fn(c),
      ),
  }
}

function seedFlag(overrides: Partial<FlagRow> = {}): FlagRow {
  const flag: FlagRow = {
    id: 'flag_1',
    projectId: 'proj_1',
    key: 'exp-flag',
    name: 'Exp',
    active: true,
    track: true,
    environmentId: ENV.id,
    tags: [],
    filters: { groups: [] },
    version: 1,
    deletedAt: null,
    ...overrides,
  }
  store.flags.push(flag)
  return flag
}

function seedExperiment(overrides: Partial<ExperimentRow> = {}): ExperimentRow {
  const exp: ExperimentRow = {
    id: 'exp_1',
    projectId: 'proj_1',
    featureFlagId: 'flag_1',
    status: 'draft',
    deletedAt: null,
    ...overrides,
  }
  store.experiments.push(exp)
  return exp
}

beforeEach(() => {
  store.flags = []
  store.experiments = []
})

describe('experiment launch pins track', () => {
  it('sets the linked flag track = true on launch', async () => {
    const flag = seedFlag({ active: false, track: false })
    seedExperiment({ status: 'draft' })

    await caller().run((c) => c.experiments.launch({ projectId: 'proj_1', id: 'exp_1' }))

    expect(flag.track).toBe(true)
    expect(flag.active).toBe(true)
    // A version bump is what carries the flip to the evaluator (gate).
    expect(flag.version).toBe(2)
  })
})

describe('flag update track pin', () => {
  it('rejects track:false while a running experiment references the flag', async () => {
    const flag = seedFlag({ track: true })
    seedExperiment({ status: 'running' })

    const err = await caller()
      .run((c) => c.flags.update({ projectId: 'proj_1', id: 'flag_1', patch: { track: false } }))
      .catch((e) => e)

    expect(err).toBeInstanceOf(TRPCError)
    expect((err as TRPCError).code).toBe('CONFLICT')
    expect((err as TRPCError).message).toBe(TRACK_PIN_ERROR_MESSAGE)
    // The rejected write must not have flipped the column.
    expect(flag.track).toBe(true)
  })

  it('allows track:false once the experiment is stopped', async () => {
    const flag = seedFlag({ track: true })
    // complete = the experiment was stopped; the pin is released.
    seedExperiment({ status: 'complete' })

    await caller().run((c) =>
      c.flags.update({ projectId: 'proj_1', id: 'flag_1', patch: { track: false } }),
    )

    expect(flag.track).toBe(false)
  })
})
