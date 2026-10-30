// the registry's invariants. Pure, no DB.
//
// The whole entitlement layer rests on `PLAN_FEATURES` being keyed by exactly
// the tiers that get seeded. A fifth plan key landing in `PLAN_SEEDS` without a
// features row would otherwise fail CLOSED at runtime for every org on it —
// silently, in production. It fails here instead.
import { describe, expect, it } from 'vitest'
import {
  allFeatures,
  ENFORCED_FEATURES,
  type EntitlementAction,
  FEATURE_BY_ACTION,
  featureKeys,
  isPlanKey,
  noFeatures,
  PLAN_FEATURES,
  type PlanFeatures,
  type PlanKey,
  UPGRADE_PATH,
} from '../plan-registry.js'
import { PLAN_SEEDS } from '../seed.js'

describe('PLAN_FEATURES', () => {
  it('is keyed by exactly the PLAN_SEEDS keys', () => {
    const seeded = PLAN_SEEDS.map((p) => p.key).sort()
    const declared = Object.keys(PLAN_FEATURES).sort()
    expect(declared).toEqual(seeded)
  })

  it('gives every tier a value for every feature key', () => {
    const keys = featureKeys()
    expect(keys.length).toBeGreaterThan(0)
    for (const [planKey, features] of Object.entries(PLAN_FEATURES)) {
      expect(Object.keys(features).sort(), `plan ${planKey}`).toEqual([...keys].sort())
      for (const key of keys) {
        expect(typeof features[key], `${planKey}.${key}`).toBe('boolean')
      }
    }
  })

  it('encodes the intended matrix', () => {
    expect(PLAN_FEATURES.free.sqlExplorer).toBe(false)
    expect(PLAN_FEATURES.pro.sqlExplorer).toBe(true)
    expect(PLAN_FEATURES.enterprise.sqlExplorer).toBe(true)
    expect(PLAN_FEATURES.unlimited.sqlExplorer).toBe(true)

    // SSO is enterprise-and-up; overage mirrors `Plan.allowsOverage`.
    expect(PLAN_FEATURES.free.sso).toBe(false)
    expect(PLAN_FEATURES.pro.sso).toBe(false)
    expect(PLAN_FEATURES.enterprise.sso).toBe(true)

    // Support is pro-and-up, off on free (and therefore gated).
    expect(PLAN_FEATURES.free.support).toBe(false)
    expect(PLAN_FEATURES.pro.support).toBe(true)
    expect(PLAN_FEATURES.enterprise.support).toBe(true)
    expect(PLAN_FEATURES.unlimited.support).toBe(true)

    // enterprise + unlimited are all-true.
    for (const key of featureKeys()) {
      expect(PLAN_FEATURES.enterprise[key], `enterprise.${key}`).toBe(true)
      expect(PLAN_FEATURES.unlimited[key], `unlimited.${key}`).toBe(true)
    }
  })

  // The declared `overage` column must agree with the runtime truth
  // (`Plan.allowsOverage` in PLAN_SEEDS) — it is documentation, and documentation
  // that contradicts the code is worse than none.
  it('keeps the provisional `overage` flag in step with Plan.allowsOverage', () => {
    for (const seed of PLAN_SEEDS) {
      expect(isPlanKey(seed.key)).toBe(true)
      if (!isPlanKey(seed.key)) continue
      expect(PLAN_FEATURES[seed.key].overage, `${seed.key}.overage`).toBe(seed.allowsOverage)
    }
  })
})

describe('ENFORCED_FEATURES', () => {
  it('names only real PlanFeatures fields', () => {
    const keys = featureKeys()
    for (const feature of ENFORCED_FEATURES) {
      expect(keys).toContain(feature)
    }
  })

  it('is exactly { sqlExplorer, surveys, support } today', () => {
    expect([...ENFORCED_FEATURES]).toEqual(['sqlExplorer', 'surveys', 'support'])
  })

  // A feature is only really gated if an action string reaches it — an enforced
  // key with no entry in FEATURE_BY_ACTION can never be checked, so it would be
  // silently open despite looking closed here.
  it('is reachable by action — every enforced feature has an action string', () => {
    const mapped = new Set(Object.values(FEATURE_BY_ACTION))
    for (const feature of ENFORCED_FEATURES) {
      expect(mapped.has(feature), `no action maps to enforced ${feature}`).toBe(true)
    }
  })

  // Enforcement without a `false` somewhere gates nothing. Pins that the free
  // tier is denied each enforced surface (fail-closed intent, not just wiring).
  it('is denied on the free tier for every enforced feature', () => {
    for (const feature of ENFORCED_FEATURES) {
      expect(PLAN_FEATURES.free[feature], `free.${feature}`).toBe(false)
    }
  })
})

describe('FEATURE_BY_ACTION', () => {
  it('maps every action to a real PlanFeatures key', () => {
    const keys = featureKeys()
    for (const [action, feature] of Object.entries(FEATURE_BY_ACTION)) {
      expect(keys, `action ${action}`).toContain(feature)
    }
  })

  it('covers every PlanFeatures key (no feature is unreachable by action)', () => {
    const mapped = new Set(Object.values(FEATURE_BY_ACTION))
    for (const key of featureKeys()) {
      expect(mapped.has(key), `no action maps to ${key}`).toBe(true)
    }
  })

  it('is a bijection — one action per feature', () => {
    const actions = Object.keys(FEATURE_BY_ACTION)
    const features = Object.values(FEATURE_BY_ACTION)
    expect(new Set(features).size).toBe(actions.length)
    expect(actions.length).toBe(featureKeys().length)
  })

  it('uses feature:<snake_case> action strings', () => {
    for (const action of Object.keys(FEATURE_BY_ACTION)) {
      expect(action).toMatch(/^feature:[a-z][a-z0-9_]*$/)
    }
  })

  it('is built once at module scope (stable identity)', () => {
    const a: Record<EntitlementAction, keyof PlanFeatures> = FEATURE_BY_ACTION
    expect(a).toBe(FEATURE_BY_ACTION)
  })
})

describe('UPGRADE_PATH', () => {
  it('covers every plan key and terminates at enterprise/unlimited', () => {
    expect(Object.keys(UPGRADE_PATH).sort()).toEqual(Object.keys(PLAN_FEATURES).sort())
    expect(UPGRADE_PATH.free).toBe('pro')
    expect(UPGRADE_PATH.pro).toBe('enterprise')
    expect(UPGRADE_PATH.enterprise).toBeUndefined()
    expect(UPGRADE_PATH.unlimited).toBeUndefined()
  })

  it('never points at a plan that does not exist', () => {
    for (const target of Object.values(UPGRADE_PATH)) {
      if (target !== undefined) expect(isPlanKey(target)).toBe(true)
    }
  })
})

describe('isPlanKey / noFeatures / allFeatures', () => {
  it('accepts seeded keys and rejects everything else', () => {
    for (const key of Object.keys(PLAN_FEATURES) as PlanKey[]) {
      expect(isPlanKey(key)).toBe(true)
    }
    expect(isPlanKey('legacy_unlimited')).toBe(false)
    expect(isPlanKey('')).toBe(false)
    expect(isPlanKey(null)).toBe(false)
    expect(isPlanKey(undefined)).toBe(false)
    // Not fooled by Object.prototype members.
    expect(isPlanKey('toString')).toBe(false)
  })

  it('noFeatures() is all-false and allFeatures() is all-true', () => {
    const off: PlanFeatures = noFeatures()
    const on: PlanFeatures = allFeatures()
    for (const key of featureKeys()) {
      expect(off[key], `off.${key}`).toBe(false)
      expect(on[key], `on.${key}`).toBe(true)
    }
  })
})
