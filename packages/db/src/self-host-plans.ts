// Data-level guarantee that self_host orgs resolve to unlimited.
//
// `effectiveLimits` short-circuits to unlimited in self_host, but capture-rs's
// Postgres fallback (services/capture/src/quota.rs) reads `Org` JOIN `Plan` and
// the per-org `*Override` columns directly. An org created while the instance
// was `cloud`, or before (still on `free`, or carrying overrides),
// would therefore keep stale limits there. Rather than duplicating the
// self_host rule in Rust, normalise the rows so every reader agrees.

import type { PrismaClient } from '@prisma/client'
import { isSelfHost } from './deployment.js'
import { SELF_HOST_PLAN_KEY } from './limits.js'

/**
 * Point every org at the `unlimited` plan and drop its quota overrides.
 * No-op outside self_host, and when the `unlimited` Plan row has not been
 * seeded yet (returns 0; `seed:plans` creates it). Idempotent.
 * Returns the number of orgs updated.
 */
export async function enforceSelfHostPlans(client: PrismaClient): Promise<number> {
  if (!isSelfHost()) return 0
  const plan = await client.plan.findUnique({ where: { key: SELF_HOST_PLAN_KEY } })
  if (!plan) return 0
  const { count } = await client.org.updateMany({
    where: {
      OR: [
        { planId: null },
        { planId: { not: plan.id } },
        { maxSeatsOverride: { not: null } },
        { maxFlagsOverride: { not: null } },
        { maxEventsPerMonthOverride: { not: null } },
        { maxFlagCallsPerMonthOverride: { not: null } },
      ],
    },
    data: {
      planId: plan.id,
      maxSeatsOverride: null,
      maxFlagsOverride: null,
      maxEventsPerMonthOverride: null,
      maxFlagCallsPerMonthOverride: null,
    },
  })
  return count
}
