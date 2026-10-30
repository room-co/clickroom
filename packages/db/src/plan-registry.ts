// Plan entitlements.
//
// Entitlements are a CODE registry keyed by `Plan.key`, not Boolean columns on
// `model Plan`. Adding a feature is one interface field + four map entries,
// reviewable in a diff, with no Prisma migration. See for the
// rejected alternatives (a column per feature; a registry + per-org override
// table).
//
// This file is pure data + types: no Prisma, no I/O. `entitlement.service.ts`
// is the only thing that resolves an org against it.

/**
 * The plan tiers that exist. MUST equal the keys of `PLAN_SEEDS` (`seed.ts`) —
 * `Plan.key` is a `String` column, not a Postgres enum, so the type system
 * cannot enforce that. `plan-registry.test.ts` does.
 */
export type PlanKey = 'free' | 'pro' | 'enterprise' | 'unlimited'

/** One Boolean per product surface that pricing might gate. */
export interface PlanFeatures {
  sqlExplorer: boolean
  sso: boolean
  askAi: boolean
  mcp: boolean
  experiments: boolean
  insights: boolean
  segments: boolean
  funnels: boolean
  webAnalytics: boolean
  dataExport: boolean
  surveys: boolean
  support: boolean
  overage: boolean
}

/**
 * The intended feature matrix per tier.
 *
 * PROVISIONAL: every value whose key is NOT in {@link ENFORCED_FEATURES} states
 * pricing *intent*, not behavior — nothing in the codebase reads it, and the
 * surface is in fact reachable on every plan today. `free: { sso: false }` here
 * does not mean SSO is off for free orgs; it means it is meant to be, one day.
 * `ENFORCED_FEATURES` is the honest list of what is actually gated.
 */
export const PLAN_FEATURES: Record<PlanKey, PlanFeatures> = {
  // Core analytics only.
  free: {
    sqlExplorer: false,
    sso: false,
    askAi: true,
    mcp: false,
    experiments: true,
    insights: true,
    segments: true,
    funnels: true,
    webAnalytics: true,
    dataExport: false,
    surveys: false,
    support: false,
    overage: false,
  },
  // Adds SQL Explorer, MCP, data export, overage. SSO stays enterprise-only.
  pro: {
    sqlExplorer: true,
    sso: false,
    askAi: true,
    mcp: true,
    experiments: true,
    insights: true,
    segments: true,
    funnels: true,
    webAnalytics: true,
    dataExport: true,
    surveys: true,
    support: true,
    overage: true,
  },
  enterprise: {
    sqlExplorer: true,
    sso: true,
    askAi: true,
    mcp: true,
    experiments: true,
    insights: true,
    segments: true,
    funnels: true,
    webAnalytics: true,
    dataExport: true,
    surveys: true,
    support: true,
    overage: true,
  },
  // Not a sellable tier — the first-party escape hatch (`seed.ts`). Short-
  // circuited in `EntitlementService` before this row is ever read; the row
  // exists as belt-and-braces so a caller that reads the map directly still
  // gets the right answer.
  unlimited: {
    sqlExplorer: true,
    sso: true,
    askAi: true,
    mcp: true,
    experiments: true,
    insights: true,
    segments: true,
    funnels: true,
    webAnalytics: true,
    dataExport: true,
    surveys: true,
    support: true,
    overage: true,
  },
}

/**
 * The features that are ACTUALLY gated in code today. Everything else in
 * {@link PlanFeatures} is declared-but-unenforced (see the note on
 * `PLAN_FEATURES`).
 *
 * `overage` is declared for DOCUMENTATION only. `Plan.allowsOverage` +
 * `canSelfEnableOverage()` (`limits.ts`) remain the runtime truth for overage
 * self-service; retiring that duplication would touch `usage.router.ts`,
 * `quota.cache.ts` and the seed, and is deliberately not.
 */
export const ENFORCED_FEATURES: ReadonlySet<keyof PlanFeatures> = new Set<keyof PlanFeatures>([
  'sqlExplorer',
  'surveys',
  'support',
])

/** The action strings accepted by `EntitlementService.check()`. */
export type EntitlementAction =
  | 'feature:sql_explorer'
  | 'feature:sso'
  | 'feature:ask_ai'
  | 'feature:mcp'
  | 'feature:experiments'
  | 'feature:insights'
  | 'feature:segments'
  | 'feature:funnels'
  | 'feature:web_analytics'
  | 'feature:data_export'
  | 'feature:surveys'
  | 'feature:support'
  | 'feature:overage'

/**
 * action → `PlanFeatures` key. Built ONCE at module scope (the reference implementation rebuilds the
 * equivalent map on every `featureAllowed()` call).
 */
export const FEATURE_BY_ACTION: Record<EntitlementAction, keyof PlanFeatures> = {
  'feature:sql_explorer': 'sqlExplorer',
  'feature:sso': 'sso',
  'feature:ask_ai': 'askAi',
  'feature:mcp': 'mcp',
  'feature:experiments': 'experiments',
  'feature:insights': 'insights',
  'feature:segments': 'segments',
  'feature:funnels': 'funnels',
  'feature:web_analytics': 'webAnalytics',
  'feature:data_export': 'dataExport',
  'feature:surveys': 'surveys',
  'feature:support': 'support',
  'feature:overage': 'overage',
}

/**
 * Where a denied org is told to go next. `enterprise` is the top sellable tier
 * and `unlimited` is not sellable at all, so both terminate.
 */
export const UPGRADE_PATH: Record<PlanKey, PlanKey | undefined> = {
  free: 'pro',
  pro: 'enterprise',
  enterprise: undefined,
  unlimited: undefined,
}

/** Narrow an arbitrary `Plan.key` string (a `String` column) to a known tier. */
export function isPlanKey(key: string | null | undefined): key is PlanKey {
  return key != null && Object.hasOwn(PLAN_FEATURES, key)
}

/** Every feature key, derived from the `free` row (which lists them all). */
export function featureKeys(): (keyof PlanFeatures)[] {
  return Object.keys(PLAN_FEATURES.free) as (keyof PlanFeatures)[]
}

/** Every feature off — the fail-closed posture for an absent/unknown plan. */
export function noFeatures(): PlanFeatures {
  const off = {} as PlanFeatures
  for (const feature of featureKeys()) {
    off[feature] = false
  }
  return off
}

/**
 * Every feature on — what `unlimited` gets. Built from the key list rather than
 * read out of `PLAN_FEATURES.unlimited`, so the first-party escape hatch cannot
 * be narrowed by an edit to the registry's `unlimited` row.
 */
export function allFeatures(): PlanFeatures {
  const on = {} as PlanFeatures
  for (const feature of featureKeys()) {
    on[feature] = true
  }
  return on
}
