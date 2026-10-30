import { PLAN_FEATURES, type PlanKey, requestContextStorage } from '@clickroom/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// This package's vitest config runs PURE unit tests only — the live-Postgres
// router suites live in `apps/api` (see vitest.config.ts). `entitlements.summary`
// is pure decision logic over the code registry once the org's plan key is
// known, so the org lookup is the only thing stubbed here: `createScopedClient`
// returns a fake `ctx.db` whose `org` reads answer with `currentPlanKey`. The
// real `EntitlementService` + `PLAN_FEATURES` do the actual work, which is the
// point of the test.
let currentPlanKey: string | null = null

vi.mock('@clickroom/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clickroom/db')>()
  const org = {
    findUnique: async () => orgRow(),
    findFirst: async () => orgRow(),
  }
  return {
    ...actual,
    prisma: {} as unknown,
    createScopedClient: () => ({ org }),
  }
})

function orgRow() {
  return { plan: currentPlanKey ? { key: currentPlanKey } : null }
}

// Imported AFTER the mock factory is registered (vi.mock is hoisted, so the
// static import below already sees the stubbed `createScopedClient`).
const { appRouter } = await import('../app.router.js')

type AppContext = Parameters<typeof appRouter.createCaller>[0]

function callSummary() {
  const caller = appRouter.createCaller({
    tokenPayload: { sub: 'user_1', sessionId: 'test', orgId: 'org_1' },
  } as unknown as AppContext)

  return requestContextStorage.run(
    { userId: 'user_1', orgId: 'org_1', orgRole: 'org_admin', authSource: 'jwt' },
    () => caller.entitlements.summary(),
  )
}

beforeEach(() => {
  currentPlanKey = null
})

describe('entitlements.summary', () => {
  const cases: { planKey: PlanKey; upgradeTo: PlanKey | null }[] = [
    { planKey: 'free', upgradeTo: 'pro' },
    { planKey: 'pro', upgradeTo: 'enterprise' },
    { planKey: 'enterprise', upgradeTo: null },
    { planKey: 'unlimited', upgradeTo: null },
  ]

  for (const { planKey, upgradeTo } of cases) {
    it(`returns the ${planKey} PLAN_FEATURES row`, async () => {
      currentPlanKey = planKey

      const summary = await callSummary()

      expect(summary).toEqual({
        planKey,
        features: PLAN_FEATURES[planKey],
        upgradeTo,
      })
    })
  }

  it('fails closed for an org with no plan', async () => {
    currentPlanKey = null

    const summary = await callSummary()

    expect(summary.planKey).toBeNull()
    expect(summary.upgradeTo).toBeNull()
    expect(Object.values(summary.features).every((v) => v === false)).toBe(true)
  })

  it('fails closed for a plan key that is not in the registry', async () => {
    currentPlanKey = 'startup'

    const summary = await callSummary()

    expect(summary.planKey).toBe('startup')
    expect(summary.upgradeTo).toBeNull()
    expect(summary.features.sqlExplorer).toBe(false)
  })
})
