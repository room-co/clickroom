import { isPlanKey, type PlanFeatures, type PlanKey, UPGRADE_PATH } from '@clickroom/db'
import { requirePermission, router } from '../trpc.js'

/**
 * What this org's plan entitles it to, for the web's
 * `useEntitlement` hook / nav + route gates.
 *
 * Deliberately NOT part of `usage.router.ts`: `usage.summary` hits ClickHouse
 * for two monthly counters, so it is expensive and short-lived. This is two
 * small Postgres reads, and the web holds it at `staleTime: 60_000` on every
 * page load — different cost, different cache lifetime, different router.
 *
 * This is a HINT, not a boundary. `entitlementMiddleware` on the gated
 * procedures (./middleware/entitlement.ts) is the enforcement; a client that
 * lies about this response gains nothing.
 */
export interface EntitlementsSummary {
  /** The org's `Plan.key`, or `null` when it has no plan (fails closed: no features). */
  planKey: string | null
  features: PlanFeatures
  /** The next tier up, or `null` at the top of the path (`enterprise`, `unlimited`). */
  upgradeTo: PlanKey | null
}

export const entitlementsRouter = router({
  summary: requirePermission('projects:read').query(
    async ({ ctx }): Promise<EntitlementsSummary> => {
      // `getFeatures()` resolves the whole map (incl. the `unlimited`
      // short-circuit and the fail-closed unknown/absent plan); the org read
      // only supplies the plan key it deliberately does not return. Both are
      // single-row, org-scoped Postgres reads and are issued together.
      const [features, org] = await Promise.all([
        ctx.entitlements.getFeatures(),
        ctx.db.org.findFirst({ select: { plan: { select: { key: true } } } }),
      ])

      const planKey = org?.plan?.key ?? null
      const upgradeTo = isPlanKey(planKey) ? (UPGRADE_PATH[planKey] ?? null) : null

      return { planKey, features, upgradeTo }
    },
  ),
})
