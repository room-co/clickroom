import {
  type BuiltQuery,
  buildOrgEventUsage,
  buildOrgFlagCallUsage,
  clickhouse,
} from '@clickroom/clickhouse'
import { canSelfEnableOverage, effectiveLimits, prisma } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { writeQuotaLimitsMirror } from '../../lib/quota.cache.js'
import { requirePermission, router } from '../trpc.js'

// tRPC has no superjson transformer here (see taxonomy.router.ts), so BigInt
// is not JSON-safe — every limit/usage number is coerced to `number` before
// leaving this router. ClickHouse's monthly counts fit comfortably in a JS
// number at MVP scale; Postgres `BigInt` limit columns are the only other
// BigInt source and are coerced the same way.

/** [monthStart, monthEnd) for the CURRENT UTC calendar month. */
function currentUtcMonthRange(now = new Date()): { monthStart: Date; monthEnd: Date } {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { monthStart, monthEnd }
}

async function chCount(builtQuery: BuiltQuery): Promise<number> {
  const rs = await clickhouse.query({ ...builtQuery, format: 'JSONEachRow' })
  const rows = await rs.json<{ count: string }>()
  return Number(rows[0]?.count ?? 0)
}

export interface UsageMetric {
  used: number
  limit: number
  /** used/limit * 100, to 2 decimal places. Not capped — over-limit metrics report >100. */
  percent: number
  overLimit: boolean
}

/** `limit <= 0` (unlimited-sentinel or misconfigured plan) reports 0% to avoid a divide-by-zero. */
function toMetric(used: number, limit: number): UsageMetric {
  const percent = limit > 0 ? Math.round((used / limit) * 10000) / 100 : 0
  return { used, limit, percent, overLimit: used >= limit }
}

/**
 * The two monthly-metered metrics (events, flag-calls) additionally report
 * `overageUnits` — allow-vs-block overage policy is decided from
 * this number (`max(0, used - limit)`). Seats/flags (lifetime) have no
 * overage concept earlier Decisions, hence a separate type rather
 * than adding an always-zero field to `UsageMetric` for all four metrics.
 */
export interface MonthlyUsageMetric extends UsageMetric {
  overageUnits: number
}

function toMonthlyMetric(used: number, limit: number): MonthlyUsageMetric {
  return { ...toMetric(used, limit), overageUnits: Math.max(0, used - limit) }
}

export interface UsageSummary {
  planKey: string | null
  seats: UsageMetric
  flags: UsageMetric
  eventsThisMonth: MonthlyUsageMetric
  flagCallsThisMonth: MonthlyUsageMetric
  /** ISO instant (UTC calendar-month boundary) when eventsThisMonth/flagCallsThisMonth roll over to 0. */
  monthlyResetsAt: string
  /*hat happens once a monthly metric goes over its limit — 'block' (402, default) or 'allow' (accept + record overage). */
  overagePolicy: 'block' | 'allow'
  /** Whether this org's plan entitles it to switch `overagePolicy` to 'allow' itself (see `canSelfEnableOverage`). Drives the UI control's enabled state; the mutation enforces it server-side regardless. */
  canSelfEnableOverage: boolean
}

export const usageRouter = router({
  summary: requirePermission('projects:read').query(async ({ ctx }): Promise<UsageSummary> => {
    const org = await ctx.db.org.findFirst({ include: { plan: true } })
    const limits = effectiveLimits(org ?? {}, org?.plan ?? null)

    const projects = await ctx.db.project.findMany({ select: { id: true } })
    const projectIds = projects.map((p) => p.id)

    // Lifetime counts (seats + flags) live in Postgres, source of truth per
    // Flags are counted across the WHOLE ORG the same way
    // flags.router.ts's create-time quota gate does — `featureFlag` is a
    // PROJECT-scoped tenant model (scoped-client.ts), so an org-wide count
    // goes through the raw (unscoped) client with an explicit
    // `project.orgId` filter rather than `ctx.db`.
    const [seatCount, flagCount] = await Promise.all([
      ctx.db.orgMembership.count(),
      prisma.featureFlag.count({ where: { deletedAt: null, project: { orgId: ctx.orgId } } }),
    ])

    // Monthly counts (events + flag-calls) are ClickHouse's job — the source
    // of truth for the usage dashboard (Decisions). Empty project
    // list (brand-new org, no projects yet) short-circuits to zero without
    // querying CH with an empty IN list.
    const { monthStart, monthEnd } = currentUtcMonthRange()
    const [eventsThisMonth, flagCallsThisMonth] =
      projectIds.length === 0
        ? [0, 0]
        : await Promise.all([
            chCount(buildOrgEventUsage({ projectIds, monthStart, monthEnd })),
            chCount(buildOrgFlagCallUsage({ projectIds, monthStart, monthEnd })),
          ])

    const maxSeats = limits.maxSeats
    const maxFlags = limits.maxFlags
    const maxEventsPerMonth = Number(limits.maxEventsPerMonth)
    const maxFlagCallsPerMonth = Number(limits.maxFlagCallsPerMonth)

    return {
      planKey: org?.plan?.key ?? null,
      seats: toMetric(seatCount, maxSeats),
      flags: toMetric(flagCount, maxFlags),
      eventsThisMonth: toMonthlyMetric(eventsThisMonth, maxEventsPerMonth),
      flagCallsThisMonth: toMonthlyMetric(flagCallsThisMonth, maxFlagCallsPerMonth),
      monthlyResetsAt: monthEnd.toISOString(),
      overagePolicy: limits.overagePolicy,
      canSelfEnableOverage: canSelfEnableOverage(org?.plan),
    }
  }),

  // Org-scoped overage policy toggle. Matches org.router.ts's
  // `update` permission (org-settings write) and re-derives + re-mirrors
  // effective limits into Redis immediately so capture-rs's hot path never
  // reads a stale policy longer than one write (27.B's rebuild-after-write
  // hook, same pattern as auth.service.ts's signup mirror).
  setOveragePolicy: requirePermission('org:update')
    .input(z.object({ policy: z.enum(['block', 'allow']) }))
    .mutation(async ({ input, ctx }) => {
      // `org:update` is held by every `org_admin`, and self-signup makes the
      // signing-up user the `org_admin` of their own org — so this mutation is
      // reachable by anyone with an account. Switching to 'allow' lifts the
      // monthly event/flag-call cap (capture-rs's `apply_policy_gate`), which
      // is only sound on a plan someone is billed for. Gate it on the plan
      // BEFORE the write, not in the UI: the UI hint (`canSelfEnableOverage`
      // on `usage.summary`) is a convenience, this is the enforcement.
      //
      // 'block' is always permitted — tightening your own quota back down is
      // never a privilege escalation, and refusing it could strand an org that
      // an operator had previously moved to 'allow'.
      const current = await ctx.db.org.findFirst({ include: { plan: true } })
      if (input.policy === 'allow' && !canSelfEnableOverage(current?.plan)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            'Your plan does not include overage. Upgrade to accept events and flag calls beyond your monthly limit.',
          cause: { code: 'overage_not_entitled', planKey: current?.plan?.key ?? null },
        })
      }

      await ctx.db.org.update({
        where: { id: ctx.orgId },
        data: { overagePolicy: input.policy },
      })

      const org = await ctx.db.org.findFirst({ include: { plan: true } })
      const limits = effectiveLimits(org ?? {}, org?.plan ?? null)
      await writeQuotaLimitsMirror(ctx.orgId, limits)

      return { ok: true }
    }),
})
