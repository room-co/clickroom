import type { EntitlementAction, PlanFeatures, PlanKey } from '@clickroom/db'
import { trpc } from '@/lib/trpc'

/**
 * Client-side mirror of the server's entitlement decision.
 *
 * THE SERVER IS THE AUTHORITY. `entitlementMiddleware(action)` on every gated
 * tRPC procedure (`packages/trpc-router/src/trpc/middleware/entitlement.ts`) is
 * what actually protects the data — it also covers the MCP/agent path, which
 * never runs this code. This hook is a HINT used to hide nav items and swap a
 * page for an upsell; a client that lies about it gains nothing.
 */

/**
 * Mirrors `FEATURE_BY_ACTION` in `packages/db/src/plan-registry.ts`. Declared
 * locally rather than imported as a value: `@clickroom/db`'s entrypoint pulls
 * in Prisma (a Node-only runtime), so the browser bundle must only ever
 * *type*-import from it. The `Record<EntitlementAction, keyof PlanFeatures>`
 * annotation is the safety net — adding an action to the server union, or
 * renaming a `PlanFeatures` field, fails `pnpm --filter @clickroom/web typecheck`
 * here.
 */
const FEATURE_BY_ACTION: Record<EntitlementAction, keyof PlanFeatures> = {
  'feature:sql_explorer': 'sqlExplorer',
  'feature:sso': 'sso',
  'feature:ask_ai': 'askAi',
  'feature:mcp': 'mcp',
  'feature:experiments': 'experiments',
  'feature:insights': 'insights',
  'feature:segments': 'segments',
  'feature:surveys': 'surveys',
  'feature:support': 'support',
  'feature:funnels': 'funnels',
  'feature:web_analytics': 'webAnalytics',
  'feature:data_export': 'dataExport',
  'feature:overage': 'overage',
}

export interface EntitlementResult {
  allowed: boolean
  /** The `PlanFeatures` key this action resolves to — what `UpgradeCard` names. */
  feature: keyof PlanFeatures
  planKey: string | null
  upgradeTo: PlanKey | null
  /**
   * True while the summary query is in flight. `allowed` is `true` in that
   * window (see below) — a route guard that wants a skeleton instead of a
   * flash of content should branch on this first.
   */
  isLoading: boolean
}

export function useEntitlement(action: EntitlementAction): EntitlementResult {
  const { data, isPending } = trpc.entitlements.summary.useQuery(undefined, {
    staleTime: 60_000,
  })

  const feature = FEATURE_BY_ACTION[action]

  // FAIL OPEN while loading. A paywall that flashes on every page load is
  // worse than half a second of a nav item the server would refuse anyway.
  if (!data) {
    return { allowed: true, feature, planKey: null, upgradeTo: null, isLoading: isPending }
  }

  return {
    allowed: data.features[feature],
    feature,
    planKey: data.planKey,
    upgradeTo: data.upgradeTo,
    isLoading: false,
  }
}
