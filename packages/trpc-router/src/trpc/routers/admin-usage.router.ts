// `admin.usage`: per-org and cross-org event/flag-call volume
// against `Plan` limits, for the internal admin console.
//
// Explicitly NOT a billing/invoice screen — clickroom has
// no payments provider anywhere in this repo. "Usage" here means the same
// thing `usage.router.ts` already shows a tenant admin for their own org
// (event/flag-call volume vs. effective plan limits, `overagePolicy` state),
// just readable cross-tenant by a platform operator instead of scoped to
// `ctx.orgId`.
//
// Data sources, no new ones added:
//   - ClickHouse volume counters (`packages/clickhouse`'s existing
//     `buildOrgEventUsage`/`buildOrgFlagCallUsage` builders, plus two new
//     day-bucketed trend variants added alongside them in this phase —
//     `buildOrgEventUsageTrend`/`buildOrgFlagCallUsageTrend` — same table,
//     same tenant filter, same `created_at` (ingest time, not client
//     `timestamp`) rationale, just grouped by day instead of collapsed to a
//     single total). No new ClickHouse table or migration.
//   - `packages/db/src/limits.ts`'s `effectiveLimits`/`canSelfEnableOverage`
//     — the exact same override-resolution logic the tenant-facing
//     `usage.router.ts` and the quota-enforcement hot path share.
//
// Every procedure reads through the raw `prisma` singleton (not `ctx.db`) —
// the deliberate cross-tenant read pattern fenced to `adminProcedure` alone.
// `adminProcedure` itself never consults `ctx.tokenPayload`,
// so a tenant JWT cannot reach anything in this file.

import {
  type BuiltQuery,
  buildOrgEventUsage,
  buildOrgEventUsageTrend,
  buildOrgFlagCallUsage,
  buildOrgFlagCallUsageTrend,
  clickhouse,
} from '@clickroom/clickhouse'
import { canSelfEnableOverage, effectiveLimits, prisma } from '@clickroom/db'
import type { Org, Plan } from '@prisma/client'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { adminProcedure, router } from '../trpc.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * [monthStart, monthEnd) for the UTC calendar month containing `at` (defaults
 * to now). Same convention as `usage.router.ts`'s `currentUtcMonthRange`, but
 * parameterized so an admin can look at a past month's volume — plan limits
 * are always evaluated against the CURRENT effective limits regardless of
 * which month's volume is being viewed, matching how the quota gate itself
 * has no concept of a limit changing retroactively.
 */
function utcMonthRange(at: Date): { monthStart: Date; monthEnd: Date } {
  const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
  const monthEnd = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))
  return { monthStart, monthEnd }
}

async function chCount(builtQuery: BuiltQuery): Promise<number> {
  const rs = await clickhouse.query({ ...builtQuery, format: 'JSONEachRow' })
  const rows = await rs.json<{ count: string }>()
  return Number(rows[0]?.count ?? 0)
}

async function chTrend(builtQuery: BuiltQuery): Promise<Map<string, number>> {
  const rs = await clickhouse.query({ ...builtQuery, format: 'JSONEachRow' })
  const rows = await rs.json<{ bucket: string; count: string }>()
  return new Map(rows.map((r) => [r.bucket.slice(0, 10), Number(r.count)]))
}

// tRPC has no superjson transformer configured for this router (see
// taxonomy.router.ts for the same note) — BigInt plan-limit columns are
// coerced to `number` before leaving this file, same as usage.router.ts.

export interface AdminUsageMetric {
  used: number
  limit: number
  /** used/limit * 100, to 2 decimal places. Not capped — over-limit metrics report >100. */
  percent: number
  overLimit: boolean
  /** max(0, used - limit). Only meaningful for the monthly-metered metrics. */
  overageUnits: number
}

/** `limit <= 0` (unlimited-sentinel or misconfigured plan) reports 0% to avoid a divide-by-zero. */
function toUsageMetric(used: number, limit: number): AdminUsageMetric {
  const percent = limit > 0 ? Math.round((used / limit) * 10000) / 100 : 0
  return { used, limit, percent, overLimit: used >= limit, overageUnits: Math.max(0, used - limit) }
}

export interface AdminOrgUsage {
  orgId: string
  orgName: string
  orgSlug: string
  planKey: string | null
  planName: string | null
  overagePolicy: 'block' | 'allow'
  canSelfEnableOverage: boolean
  eventsThisMonth: AdminUsageMetric
  flagCallsThisMonth: AdminUsageMetric
  /** ISO instant (UTC calendar-month boundary) when the viewed month's counters roll over. */
  monthlyResetsAt: string
}

export interface AdminOrgUsageTrendPoint {
  /** UTC calendar date, `YYYY-MM-DD`. */
  date: string
  events: number
  flagCalls: number
}

export interface AdminOrgUsageDetail extends AdminOrgUsage {
  trend: AdminOrgUsageTrendPoint[]
}

type OrgWithPlan = Org & { plan: Plan | null }

/**
 * Resolve one org's volume + effective limits for the UTC month containing
 * `at`. Shared by `perOrg` (single org) and `topByVolume` (looped per org,
 * same shape as the tenant-facing `usage.router.ts`'s single-org query,
 * fanned out — see that router's own module comment for why this whole repo
 * has no cross-org aggregate ClickHouse query yet).
 */
async function loadOrgUsage(org: OrgWithPlan, at: Date): Promise<AdminOrgUsage> {
  const { monthStart, monthEnd } = utcMonthRange(at)
  const limits = effectiveLimits(org, org.plan)

  const projects = await prisma.project.findMany({
    where: { orgId: org.id },
    select: { id: true },
  })
  const projectIds = projects.map((p) => p.id)

  const [eventsUsed, flagCallsUsed] =
    projectIds.length === 0
      ? [0, 0]
      : await Promise.all([
          chCount(buildOrgEventUsage({ projectIds, monthStart, monthEnd })),
          chCount(buildOrgFlagCallUsage({ projectIds, monthStart, monthEnd })),
        ])

  return {
    orgId: org.id,
    orgName: org.name,
    orgSlug: org.slug,
    planKey: org.plan?.key ?? null,
    planName: org.plan?.name ?? null,
    overagePolicy: limits.overagePolicy,
    canSelfEnableOverage: canSelfEnableOverage(org.plan),
    eventsThisMonth: toUsageMetric(eventsUsed, Number(limits.maxEventsPerMonth)),
    flagCallsThisMonth: toUsageMetric(flagCallsUsed, Number(limits.maxFlagCallsPerMonth)),
    monthlyResetsAt: monthEnd.toISOString(),
  }
}

const orgIdInput = z.object({
  orgId: z.string().min(1),
  /** Anchors which UTC calendar month to view; defaults to the current month. */
  at: z.coerce.date().optional(),
})

export const adminUsageRouter = router({
  /**
   * Full usage detail for one org: this month's event/flag-call volume vs.
   * effective plan limits, overage state, and a day-bucketed trend for the
   * same month (`/orgs/:id`'s Usage tab, per spec's page list).
   */
  perOrg: adminProcedure
    .input(orgIdInput)
    .query(async ({ input }): Promise<AdminOrgUsageDetail> => {
      const org = await prisma.org.findUnique({
        where: { id: input.orgId },
        include: { plan: true },
      })
      if (!org) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Org not found.' })
      }

      const at = input.at ?? new Date()
      const { monthStart, monthEnd } = utcMonthRange(at)

      const projects = await prisma.project.findMany({
        where: { orgId: org.id },
        select: { id: true },
      })
      const projectIds = projects.map((p) => p.id)

      const limits = effectiveLimits(org, org.plan)

      const [eventsUsed, flagCallsUsed, eventsTrend, flagCallsTrend] =
        projectIds.length === 0
          ? [0, 0, new Map<string, number>(), new Map<string, number>()]
          : await Promise.all([
              chCount(buildOrgEventUsage({ projectIds, monthStart, monthEnd })),
              chCount(buildOrgFlagCallUsage({ projectIds, monthStart, monthEnd })),
              chTrend(buildOrgEventUsageTrend({ projectIds, monthStart, monthEnd })),
              chTrend(buildOrgFlagCallUsageTrend({ projectIds, monthStart, monthEnd })),
            ])

      // Build one point per calendar day in [monthStart, monthEnd) (capped at
      // "today" for the current month so the chart doesn't trail off into a
      // flat line of future zeros) so the chart's x-axis is dense even on days
      // with zero volume, rather than only the days ClickHouse returned rows for.
      const today = new Date()
      const lastDay =
        monthEnd.getTime() > today.getTime()
          ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
          : new Date(monthEnd.getTime() - 24 * 60 * 60 * 1000)
      const trend: AdminOrgUsageTrendPoint[] = []
      for (
        let day = new Date(monthStart);
        day.getTime() <= lastDay.getTime();
        day.setUTCDate(day.getUTCDate() + 1)
      ) {
        const key = day.toISOString().slice(0, 10)
        trend.push({
          date: key,
          events: eventsTrend.get(key) ?? 0,
          flagCalls: flagCallsTrend.get(key) ?? 0,
        })
      }

      return {
        orgId: org.id,
        orgName: org.name,
        orgSlug: org.slug,
        planKey: org.plan?.key ?? null,
        planName: org.plan?.name ?? null,
        overagePolicy: limits.overagePolicy,
        canSelfEnableOverage: canSelfEnableOverage(org.plan),
        eventsThisMonth: toUsageMetric(eventsUsed, Number(limits.maxEventsPerMonth)),
        flagCallsThisMonth: toUsageMetric(flagCallsUsed, Number(limits.maxFlagCallsPerMonth)),
        monthlyResetsAt: monthEnd.toISOString(),
        trend,
      }
    }),

  /**
   * Cross-org rollup, sorted by this month's event volume descending — the
   * `/usage` page's top table. Fans out one ClickHouse round trip per org
   * (same builders `perOrg`/the tenant `usage.router.ts` use for a single
   * org) rather than a new aggregate query, matching this router's mandate
   * to build on the existing query-builder conventions rather than add a
   * cross-org ClickHouse aggregate. Fine at this repo's admin-console scale;
   * revisit with a single GROUP-BY-project_id query if the org count grows
   * large enough for this to matter.
   */
  topByVolume: adminProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(20),
        at: z.coerce.date().optional(),
      }),
    )
    .query(async ({ input }): Promise<AdminOrgUsage[]> => {
      const at = input.at ?? new Date()
      const orgs = await prisma.org.findMany({ include: { plan: true } })
      const usages = await Promise.all(orgs.map((org) => loadOrgUsage(org, at)))
      return usages
        .sort((a, b) => b.eventsThisMonth.used - a.eventsThisMonth.used)
        .slice(0, input.limit)
    }),

  /**
   * Orgs currently over their monthly event or flag-call quota — the
   * needs-attention feed for `/dashboard` and `/health`'s "orgs over quota"
   * count ('s health-screen decision references this same
   * fact; this procedure is the queryable source of it, `admin.health` reads
   * the count independently since it owns no orgId-level detail).
   */
  overQuota: adminProcedure.query(async (): Promise<AdminOrgUsage[]> => {
    const now = new Date()
    const orgs = await prisma.org.findMany({ include: { plan: true } })
    const usages = await Promise.all(orgs.map((org) => loadOrgUsage(org, now)))
    return usages.filter((u) => u.eventsThisMonth.overLimit || u.flagCallsThisMonth.overLimit)
  }),
})
