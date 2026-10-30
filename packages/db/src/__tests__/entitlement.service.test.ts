// EntitlementService. Pure unit test: the only DB touch is
// `org.findUnique`, so the scoped client is faked with a single vi.fn() rather
// than reaching for the live Postgres the integration suites here use. The
// decision logic is what is under test, not Prisma.
import { describe, expect, it, vi } from 'vitest'
import { EntitlementService } from '../entitlement.service.js'
import type { EntitlementAction } from '../plan-registry.js'
import { PLAN_FEATURES } from '../plan-registry.js'
import type { ScopedPrismaClient } from '../scoped-client.js'

const ORG_ID = 'org_test'

/** A scoped client whose `org.findUnique` returns an org on `planKey`. */
function fakeDb(planKey: string | null) {
  const findUnique = vi.fn().mockResolvedValue({ plan: planKey ? { key: planKey } : null })
  return {
    db: { org: { findUnique } } as unknown as ScopedPrismaClient,
    findUnique,
  }
}

function serviceOn(planKey: string | null) {
  const { db, findUnique } = fakeDb(planKey)
  return { svc: new EntitlementService(db, ORG_ID), findUnique }
}

describe('EntitlementService.check', () => {
  it('denies sql_explorer on a free org and points at pro', async () => {
    const { svc } = serviceOn('free')
    const result = await svc.check({ action: 'feature:sql_explorer' })

    expect(result.allowed).toBe(false)
    expect(result.planKey).toBe('free')
    expect(result.upgradeTo).toBe('pro')
    expect(result.reason).toBeTruthy()
  })

  it('allows sql_explorer on a pro org', async () => {
    const { svc } = serviceOn('pro')
    const result = await svc.check({ action: 'feature:sql_explorer' })

    expect(result).toEqual({ allowed: true, planKey: 'pro' })
  })

  it('denies sso on a pro org and points at enterprise', async () => {
    const { svc } = serviceOn('pro')
    const result = await svc.check({ action: 'feature:sso' })

    expect(result.allowed).toBe(false)
    expect(result.upgradeTo).toBe('enterprise')
  })

  it('denies without an upgradeTo when the org is already on the top tier', async () => {
    const { svc } = serviceOn('enterprise')
    // enterprise is all-true, so force a denial through the registry itself.
    PLAN_FEATURES.enterprise.sqlExplorer = false
    try {
      const result = await svc.check({ action: 'feature:sql_explorer' })
      expect(result.allowed).toBe(false)
      expect(result.planKey).toBe('enterprise')
      expect(result.upgradeTo).toBeUndefined()
      expect('upgradeTo' in result).toBe(false)
    } finally {
      PLAN_FEATURES.enterprise.sqlExplorer = true
    }
  })

  it('scopes the org lookup to the constructor orgId', async () => {
    const { svc, findUnique } = serviceOn('pro')
    await svc.check({ action: 'feature:sql_explorer' })
    expect(findUnique).toHaveBeenCalledTimes(1)
    expect(findUnique.mock.calls[0][0]).toMatchObject({ where: { id: ORG_ID } })
  })

  describe('unlimited', () => {
    it('is allowed without consulting PLAN_FEATURES', async () => {
      const { svc } = serviceOn('unlimited')
      // Poison the registry row: a true short-circuit never reads it.
      const original = { ...PLAN_FEATURES.unlimited }
      for (const key of Object.keys(PLAN_FEATURES.unlimited) as (keyof typeof original)[]) {
        PLAN_FEATURES.unlimited[key] = false
      }
      try {
        const result = await svc.check({ action: 'feature:sql_explorer' })
        expect(result).toEqual({ allowed: true, planKey: 'unlimited' })

        // getFeatures takes the same short-circuit.
        const features = await svc.getFeatures()
        expect(Object.values(features).every(Boolean)).toBe(true)
      } finally {
        Object.assign(PLAN_FEATURES.unlimited, original)
      }
    })
  })

  describe('fail closed', () => {
    it('denies an org with planId = null and reports planKey: null', async () => {
      const { svc } = serviceOn(null)
      const result = await svc.check({ action: 'feature:sql_explorer' })

      expect(result.allowed).toBe(false)
      expect(result.planKey).toBeNull()
    })

    it('denies an org whose plan key is not in the registry — without throwing', async () => {
      const { svc } = serviceOn('legacy_startup')
      const result = await svc.check({ action: 'feature:ask_ai' })

      expect(result.allowed).toBe(false)
      expect(result.planKey).toBe('legacy_startup')
    })

    it('denies even features the free tier has, when the plan is unknown', async () => {
      const { svc } = serviceOn('legacy_startup')
      expect(PLAN_FEATURES.free.webAnalytics).toBe(true)
      const result = await svc.check({ action: 'feature:web_analytics' })
      expect(result.allowed).toBe(false)
    })

    it('denies when the org row itself is missing', async () => {
      const findUnique = vi.fn().mockResolvedValue(null)
      const db = { org: { findUnique } } as unknown as ScopedPrismaClient
      const result = await new EntitlementService(db, ORG_ID).check({
        action: 'feature:sql_explorer',
      })
      expect(result.allowed).toBe(false)
      expect(result.planKey).toBeNull()
    })
  })

  it('throws on an unknown action string (programming error, not a plan decision)', async () => {
    const { svc } = serviceOn('free')
    await expect(svc.check({ action: 'feature:time_travel' as EntitlementAction })).rejects.toThrow(
      /unknown entitlement action/i,
    )
  })

  it('throws on an unknown action even for an unlimited org', async () => {
    const { svc } = serviceOn('unlimited')
    await expect(svc.check({ action: 'quota:seats' as EntitlementAction })).rejects.toThrow(
      /unknown entitlement action/i,
    )
  })
})

describe('EntitlementService.getFeatures', () => {
  it('returns the registry row for each seeded tier', async () => {
    for (const planKey of ['free', 'pro', 'enterprise'] as const) {
      const { svc } = serviceOn(planKey)
      await expect(svc.getFeatures()).resolves.toEqual(PLAN_FEATURES[planKey])
    }
  })

  it('returns all-false for a null or unknown plan', async () => {
    for (const planKey of [null, 'legacy_startup']) {
      const { svc } = serviceOn(planKey)
      const features = await svc.getFeatures()
      expect(Object.values(features).some(Boolean)).toBe(false)
      expect(Object.keys(features).sort()).toEqual(Object.keys(PLAN_FEATURES.free).sort())
    }
  })

  it('hands back a copy — mutating the result cannot corrupt the registry', async () => {
    const { svc } = serviceOn('pro')
    const features = await svc.getFeatures()
    features.sqlExplorer = false
    expect(PLAN_FEATURES.pro.sqlExplorer).toBe(true)
  })
})
