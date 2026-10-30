import {
  type EntitlementAction,
  type EntitlementService,
  FEATURE_BY_ACTION,
  type PlanFeatures,
} from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { middleware, orgScopedProcedure } from '../trpc.js'

/**
 * Plan-entitlement gate. Denies a procedure when the caller's org is on a plan
 * whose {@link PlanFeatures} row has the backing feature off.
 *
 * ## Composition order: RBAC -> entitlement. Always.
 *
 * Chain this AFTER `requirePermission(...)`, never before:
 *
 * ```ts
 * const sqlProcedure = requirePermission('projects:read')
 *   .use(entitlementMiddleware('feature:sql_explorer'))
 * ```
 *
 * A user who lacks `projects:read` must get the *permissions* error — they are
 * not allowed to see this data at any price, and answering them with an upsell
 * ("upgrade to Pro!") would be both wrong and a small information leak about
 * what the org could buy. The entitlement check is about what the *org bought*;
 * the permission check is about what the *user may do*. The user question comes
 * first.
 *
 * This is the hard, unbypassable gate: it covers the tRPC path, the MCP/agent
 * path, and Ask AI alike. The web's `useEntitlement` hook and the nav/route
 * gates are hints for a nicer UI — this is the enforcement.
 *
 * Requires an org-scoped context (`ctx.entitlements`, injected by
 * `orgScopedProcedure`), which `requirePermission(...)` already chains off.
 */
export function entitlementMiddleware(action: EntitlementAction) {
  return middleware(async ({ ctx, next }) => {
    const entitlements = (ctx as { entitlements?: EntitlementService }).entitlements
    if (!entitlements) {
      // Chained onto a non-org-scoped builder. A programming error, not a plan
      // decision — fail loudly rather than silently allowing.
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'entitlementMiddleware requires an org-scoped procedure.',
      })
    }

    const result = await entitlements.check({ action })
    if (!result.allowed) {
      const feature: keyof PlanFeatures = FEATURE_BY_ACTION[action]
      // `cause.code` follows the convention set by `usage.router.ts`'s
      // `overage_not_entitled`, so the web can branch on a stable code instead
      // of string-matching the message. `feature` is the PlanFeatures key
      // (e.g. 'sqlExplorer'), not the action string.
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: result.reason,
        cause: {
          code: 'not_entitled',
          feature,
          planKey: result.planKey,
          upgradeTo: result.upgradeTo,
        },
      })
    }

    return next()
  })
}

/**
 * Org-scoped procedure gated purely on a plan feature, with no RBAC requirement
 * of its own. If the procedure also needs a permission, build it as
 * `requirePermission(...).use(entitlementMiddleware(action))` instead — see the
 * ordering note above.
 */
export function requireEntitlement(action: EntitlementAction) {
  return orgScopedProcedure.use(entitlementMiddleware(action))
}
