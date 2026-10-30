// Effective quota resolution — usage tracking + quotas).
//
// Limit source is a `Plan` tiers table plus nullable per-org override columns
// on `Org`. The override always wins when present; otherwise the org's plan
// value applies. Shared by the tRPC quota gates and the usage router
// so the "override ?? plan.value" logic lives in exactly one place.

import { isSelfHost } from './deployment.js'

/** Key of the plan every newly bootstrapped org starts on in `cloud`. */
export const DEFAULT_PLAN_KEY = 'free'

/** Plan every org starts on in `self_host` — the seeded `unlimited` tier. */
export const SELF_HOST_PLAN_KEY = 'unlimited'

/** Default plan key for the current deployment mode. */
export function defaultPlanKey(): string {
  return isSelfHost() ? SELF_HOST_PLAN_KEY : DEFAULT_PLAN_KEY
}

// Mirrors the `unlimited` PLAN_SEEDS row. Must stay under 2^53 (see seed.ts).
const SELF_HOST_UNLIMITED = {
  maxSeats: 1_000_000,
  maxFlags: 1_000_000,
  maxEventsPerMonth: 1_000_000_000_000_000n,
  maxFlagCallsPerMonth: 1_000_000_000_000_000n,
} as const

/** The subset of `Plan` needed to decide overage entitlement. */
export interface PlanEntitlements {
  allowsOverage: boolean
}

/**
 * May this org flip its own `overagePolicy` to `allow`?
 *
 * `allow` means capture-rs accepts events and flag calls *past* the monthly
 * limit and records the excess as overage (`apply_policy_gate` in
 * `services/capture/src/quota.rs`: `allowed = !enforce || !over || policy ==
 * Allow`). That is only sound when someone is going to be invoiced for the
 * excess — otherwise it is a self-serve toggle for unmetered ingest.
 *
 * `usage.setOveragePolicy` is gated `org:update`, and every self-signup user is
 * `org_admin` of the org `bootstrapOrg` creates for them. So without this check
 * anyone could sign up, open Settings, and lift their own event/flag-call cap
 * for free. Billing does not exist yet, so nothing would ever reconcile it.
 *
 * Entitlement is read from `Plan.allowsOverage` rather than inferred from the
 * plan's key. Keying off the name (`!== 'free'`) would be fail-OPEN: every
 * future tier — `trial`, `starter`, `community` — would silently inherit
 * overage just by not being called "free". The column defaults to `false`, so a
 * new plan has to opt in deliberately. A missing plan fails closed for the same
 * reason `effectiveLimits` does: no plan means no allowance, and certainly no
 * entitlement.
 *
 * This gates only *self-service*: an operator can still set `Org.overagePolicy`
 * directly, and an org already on `allow` stays there. Seats and flags are
 * unaffected either way — `assertUnderQuota` never consults the policy, so they
 * stay hard caps on every plan.
 */
export function canSelfEnableOverage(plan: PlanEntitlements | null | undefined): boolean {
  return plan?.allowsOverage === true
}

/** The subset of `Org` fields needed to resolve effective limits. */
export interface OrgLimitOverrides {
  maxSeatsOverride?: number | null
  maxFlagsOverride?: number | null
  maxEventsPerMonthOverride?: bigint | null
  maxFlagCallsPerMonthOverride?: bigint | null
  overagePolicy?: 'block' | 'allow'
}

/** The subset of `Plan` fields needed to resolve effective limits. */
export interface PlanLimits {
  maxSeats: number
  maxFlags: number
  maxEventsPerMonth: bigint
  maxFlagCallsPerMonth: bigint
}

export interface EffectiveLimits {
  maxSeats: number
  maxFlags: number
  maxEventsPerMonth: bigint
  maxFlagCallsPerMonth: bigint
  overagePolicy: 'block' | 'allow'
}

/**
 * Resolve the effective quota for an org: per-org override wins over the
 * plan's default value for each of the four metrics.
 *
 * `plan` is nullable to cover orgs that (transiently, or pre-migration) have
 * no `planId` set — in that case only overrides apply and any metric without
 * an override falls back to 0 (fail-closed: no plan means no allowance).
 *
 * `overagePolicy` is a plain passthrough of the org column — it has
 * no plan-derived counterpart (`Plan` has no overage policy of its own).
 */
export function effectiveLimits(org: OrgLimitOverrides, plan: PlanLimits | null): EffectiveLimits {
  // Self-host: quotas exist to price a hosted product. There is no
  // one to bill, so nothing is ever capped — regardless of plan or overrides.
  if (isSelfHost()) {
    return { ...SELF_HOST_UNLIMITED, overagePolicy: org.overagePolicy ?? 'block' }
  }
  return {
    maxSeats: org.maxSeatsOverride ?? plan?.maxSeats ?? 0,
    maxFlags: org.maxFlagsOverride ?? plan?.maxFlags ?? 0,
    maxEventsPerMonth: org.maxEventsPerMonthOverride ?? plan?.maxEventsPerMonth ?? 0n,
    maxFlagCallsPerMonth: org.maxFlagCallsPerMonthOverride ?? plan?.maxFlagCallsPerMonth ?? 0n,
    overagePolicy: org.overagePolicy ?? 'block',
  }
}
