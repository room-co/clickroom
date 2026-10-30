// Plan entitlements.
//
// Resolves ONE org against the code registry in `plan-registry.ts`. Feature
// half only: quotas (`maxSeats`, `maxEventsPerMonth`, …) are a different layer
// with per-org overrides and are resolved by `effectiveLimits()` (`limits.ts`).
//
// Posture:
//   - `unlimited` short-circuits every check, WITHOUT reading PLAN_FEATURES —
//     the first-party escape hatch must never be throttled by a registry edit.
//   - `planId = null`, or a `Plan.key` that is not in the registry, FAILS
//     CLOSED (all features false). Same reasoning as `effectiveLimits()`
//     returning 0 for a missing plan rather than infinity.
//   - An unknown *action* string THROWS: that is a programming error (a typo in
//     a middleware call site), not a plan decision, and a 500 is the correct
//     answer.
//
// No caching: one `org` lookup per `check()`. The row is small and hot in PG's
// cache; single-flight-per-request is a follow-up.

import { isSelfHost } from './deployment.js'

import {
  allFeatures,
  type EntitlementAction,
  FEATURE_BY_ACTION,
  isPlanKey,
  noFeatures,
  PLAN_FEATURES,
  type PlanFeatures,
  type PlanKey,
  UPGRADE_PATH,
} from './plan-registry.js'
import type { ScopedPrismaClient } from './scoped-client.js'

export interface EntitlementResult {
  allowed: boolean
  /** Human-readable denial reason. Absent when `allowed`. */
  reason?: string
  /** The org's `Plan.key`, or `null` when the org has no plan. */
  planKey: string | null
  /** The tier that would grant the feature, when one exists. Absent when `allowed`. */
  upgradeTo?: PlanKey
}

export class EntitlementService {
  constructor(
    private readonly prisma: ScopedPrismaClient,
    private readonly orgId: string,
  ) {}

  /** Is this org entitled to `action`? */
  async check({ action }: { action: EntitlementAction }): Promise<EntitlementResult> {
    // Action validation runs BEFORE the org load and before the `unlimited`
    // short-circuit, deliberately: a bad action string is a programming error
    // and must throw for every org, not silently return `allowed: true` for the
    // one tier that skips the map. It reads FEATURE_BY_ACTION, never
    // PLAN_FEATURES, so the "unlimited never consults the registry" rule holds.
    const feature = featureForAction(action)
    const planKey = await this.loadOrgPlan()

    // Self-host: nothing is plan-gated, whatever plan the org holds.
    if (isSelfHost() || planKey === 'unlimited') {
      return { allowed: true, planKey }
    }

    const features = resolveFeatures(planKey)
    if (features[feature]) {
      return { allowed: true, planKey }
    }

    return denyResult(planKey, feature)
  }

  /** The whole feature map for this org — for the `entitlements.summary` procedure. */
  async getFeatures(): Promise<PlanFeatures> {
    const planKey = await this.loadOrgPlan()
    if (isSelfHost() || planKey === 'unlimited') {
      return allFeatures()
    }
    return resolveFeatures(planKey)
  }

  /** The org's `Plan.key`, or `null` when it has no plan (`planId = null`). */
  private async loadOrgPlan(): Promise<string | null> {
    const org = await this.prisma.org.findUnique({
      where: { id: this.orgId },
      select: { plan: { select: { key: true } } },
    })
    return org?.plan?.key ?? null
  }
}

/** action → feature key. Throws on an action the registry does not know. */
function featureForAction(action: EntitlementAction): keyof PlanFeatures {
  const feature = FEATURE_BY_ACTION[action]
  if (!feature) {
    throw new Error(`EntitlementService: unknown entitlement action "${action}"`)
  }
  return feature
}

/** Fail closed: an absent or unseeded plan key gets no features at all. */
export function resolveFeatures(planKey: string | null): PlanFeatures {
  if (!isPlanKey(planKey)) {
    return noFeatures()
  }
  return { ...PLAN_FEATURES[planKey] }
}

/** The denial, carrying the next tier up so the client can render an upsell. */
export function denyResult(planKey: string | null, feature: keyof PlanFeatures): EntitlementResult {
  const upgradeTo = isPlanKey(planKey) ? UPGRADE_PATH[planKey] : 'pro'
  return {
    allowed: false,
    reason: `Your plan does not include ${feature}.`,
    planKey,
    ...(upgradeTo ? { upgradeTo } : {}),
  }
}
