import { describe, expect, it } from 'vitest'
import {
  isSelfHost,
  resolveAdminPasswordSink,
  resolveDeployment,
  resolveSignupMode,
} from './deployment.js'
import { EntitlementService } from './entitlement.service.js'
import { defaultPlanKey, effectiveLimits } from './limits.js'
import type { ScopedPrismaClient } from './scoped-client.js'

describe('deployment resolution', () => {
  it('defaults to self_host / first_user_only / stdout', () => {
    expect(resolveDeployment({})).toBe('self_host')
    expect(isSelfHost({})).toBe(true)
    expect(resolveSignupMode({})).toBe('first_user_only')
    expect(resolveAdminPasswordSink({})).toBe('stdout')
  })

  it('cloud defaults the admin sink to ssm', () => {
    expect(resolveAdminPasswordSink({ CLICKROOM_DEPLOYMENT: 'cloud' })).toBe('ssm')
  })

  it('explicit ADMIN_PASSWORD_SINK wins in either mode', () => {
    expect(resolveAdminPasswordSink({ ADMIN_PASSWORD_SINK: 'env' })).toBe('env')
    expect(
      resolveAdminPasswordSink({ CLICKROOM_DEPLOYMENT: 'cloud', ADMIN_PASSWORD_SINK: 'stdout' }),
    ).toBe('stdout')
  })

  it('rejects unknown values instead of degrading to a permissive default', () => {
    expect(() => resolveDeployment({ CLICKROOM_DEPLOYMENT: 'saas' })).toThrow(
      /CLICKROOM_DEPLOYMENT/,
    )
    expect(() => resolveSignupMode({ SIGNUP_MODE: 'opne' })).toThrow(/SIGNUP_MODE/)
    expect(() => resolveAdminPasswordSink({ ADMIN_PASSWORD_SINK: 'file' })).toThrow(
      /ADMIN_PASSWORD_SINK/,
    )
  })
})

describe('self_host limits and entitlements', () => {
  const freePlan = {
    maxSeats: 3,
    maxFlags: 5,
    maxEventsPerMonth: 10_000n,
    maxFlagCallsPerMonth: 50_000n,
  }

  function withDeployment<T>(mode: string, fn: () => T): T {
    const prev = process.env.CLICKROOM_DEPLOYMENT
    process.env.CLICKROOM_DEPLOYMENT = mode
    const restore = () => {
      if (prev === undefined) delete process.env.CLICKROOM_DEPLOYMENT
      else process.env.CLICKROOM_DEPLOYMENT = prev
    }
    try {
      const out = fn()
      // Async bodies must finish before the env is restored.
      if (out instanceof Promise) return out.finally(restore) as T
      restore()
      return out
    } catch (err) {
      restore()
      throw err
    }
  }

  it('effectiveLimits is unlimited in self_host even on the free plan with no plan at all', () => {
    withDeployment('self_host', () => {
      for (const plan of [freePlan, null]) {
        const limits = effectiveLimits({}, plan)
        expect(limits.maxSeats).toBeGreaterThan(100_000)
        expect(limits.maxFlags).toBeGreaterThan(100_000)
        expect(limits.maxEventsPerMonth).toBeGreaterThan(10n ** 12n)
        expect(limits.maxFlagCallsPerMonth).toBeGreaterThan(10n ** 12n)
        // Stays below 2^53: capture's Lua counter and usage.router read these as doubles.
        expect(limits.maxEventsPerMonth).toBeLessThan(2n ** 53n)
      }
    })
  })

  it('effectiveLimits keeps plan/override resolution in cloud', () => {
    withDeployment('cloud', () => {
      expect(effectiveLimits({}, freePlan).maxEventsPerMonth).toBe(10_000n)
      expect(effectiveLimits({}, null).maxSeats).toBe(0)
      expect(effectiveLimits({ maxSeatsOverride: 9 }, freePlan).maxSeats).toBe(9)
    })
  })

  it('default plan is unlimited in self_host and free in cloud', () => {
    expect(withDeployment('self_host', defaultPlanKey)).toBe('unlimited')
    expect(withDeployment('cloud', defaultPlanKey)).toBe('free')
  })

  it('entitlements allow everything in self_host, even on free or no plan', async () => {
    const svc = (planKey: string | null) =>
      new EntitlementService(
        {
          org: { findUnique: async () => ({ plan: planKey ? { key: planKey } : null }) },
        } as unknown as ScopedPrismaClient,
        'org_1',
      )
    await withDeployment('self_host', async () => {
      expect((await svc('free').check({ action: 'feature:sso' })).allowed).toBe(true)
      expect((await svc(null).check({ action: 'feature:sql_explorer' })).allowed).toBe(true)
      expect(Object.values(await svc('free').getFeatures()).every(Boolean)).toBe(true)
    })
  })
})
