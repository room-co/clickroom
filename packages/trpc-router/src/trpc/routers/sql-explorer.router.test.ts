import type { Permission } from '@clickroom/auth'
import { requestContextStorage } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pure unit test — no Postgres, no ClickHouse, no services/query (the
// live-Postgres router suites live in `apps/api`; see vitest.config.ts). What's
// under test is the *gate order* on `sqlExplorer.*`: RBAC -> entitlement. So the
// only stubs are the org/project lookups, `can()`, and the remote query call.
// The real `EntitlementService` + `PLAN_FEATURES` make the plan decision.
let currentPlanKey: string | null = null
let grantedPermissions: Set<Permission> = new Set()

vi.mock('@clickroom/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clickroom/db')>()
  return {
    ...actual,
    prisma: {} as unknown,
    createScopedClient: () => ({
      org: {
        findUnique: async () => orgRow(),
        findFirst: async () => orgRow(),
      },
      project: { findFirst: async () => ({ id: 'proj_1', orgId: 'org_1' }) },
      dataSource: { findFirst: async () => ({ id: 'src_1', projectId: 'proj_1' }) },
    }),
  }
})

vi.mock('@clickroom/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clickroom/auth')>()
  return {
    ...actual,
    can: (_role: string, perm: Permission) => grantedPermissions.has(perm),
  }
})

const runQuery = vi.fn(async () => ({ columns: ['n'], rows: [[1]] }))
vi.mock('../../lib/query-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/query-service.js')>()
  return { ...actual, runQuery: (...args: unknown[]) => runQuery(...(args as [])) }
})

function orgRow() {
  return { plan: currentPlanKey ? { key: currentPlanKey } : null }
}

// Imported AFTER the mock factories are registered (vi.mock is hoisted).
const { appRouter } = await import('../app.router.js')

type AppContext = Parameters<typeof appRouter.createCaller>[0]

function callRun() {
  const caller = appRouter.createCaller({
    tokenPayload: { sub: 'user_1', sessionId: 'test', orgId: 'org_1' },
  } as unknown as AppContext)

  return requestContextStorage.run(
    { userId: 'user_1', orgId: 'org_1', orgRole: 'org_admin', authSource: 'jwt' },
    () =>
      caller.sqlExplorer.run({
        projectId: 'proj_1',
        sourceId: 'src_1',
        sql: 'select 1',
      }),
  )
}

beforeEach(() => {
  currentPlanKey = null
  grantedPermissions = new Set<Permission>(['projects:read'])
  runQuery.mockClear()
})

describe('sqlExplorer.run entitlement gate', () => {
  it('denies a free org with not_entitled / sqlExplorer', async () => {
    currentPlanKey = 'free'

    const err = await callRun().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(TRPCError)
    const trpcErr = err as TRPCError
    expect(trpcErr.code).toBe('FORBIDDEN')
    expect(trpcErr.cause).toMatchObject({
      code: 'not_entitled',
      feature: 'sqlExplorer',
      planKey: 'free',
      upgradeTo: 'pro',
    })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('passes the middleware on a pro org', async () => {
    currentPlanKey = 'pro'

    const result = await callRun()

    expect(runQuery).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ columns: ['n'], rows: [[1]] })
  })

  // RBAC -> entitlement order: a user who may not read projects is told so,
  // rather than being sold an upgrade for a feature their org already has.
  it('returns the permissions error, not the entitlement error, without projects:read', async () => {
    currentPlanKey = 'pro'
    grantedPermissions = new Set<Permission>()

    const err = await callRun().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(TRPCError)
    const trpcErr = err as TRPCError
    expect(trpcErr.code).toBe('FORBIDDEN')
    expect(trpcErr.message).toBe('Insufficient permissions.')
    expect(trpcErr.cause).toBeUndefined()
    expect(runQuery).not.toHaveBeenCalled()
  })
})
