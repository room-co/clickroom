// apps/api/trpc/routers — Web Analytics dashboard.
//
// PostHog-style "how is my website doing" screen: KPI overview, visitors trend, top
// paths, traffic sources, devices, retention cohorts, and an active-hours heatmap — all
// plain column scans over the.1 MATERIALIZED columns (referring_domain,
// channel_type, utm_*, device_type, browser, os, path, host). See
// web-analytics.queries.ts for the pure query builders and events.router.ts for the
// router/procedure conventions this mirrors (requirePermission + scopedForProject +
// the prev-window comparison pattern).
//
// `host` (31.5) is threaded through every procedure's WHERE clause when present —
// an optional exact-match filter on the MATERIALIZED `host` column, omitted
// entirely (not `host = NULL`/`''`) when the client doesn't select one. The
// `hosts` procedure below powers the page's host Select.

import { clickhouse } from '@clickroom/clickhouse'
import { z } from 'zod'
import { requirePermission, router, scopedForProject } from '../trpc.js'
import {
  buildWebActiveHours,
  buildWebDevices,
  buildWebHosts,
  buildWebOverview,
  buildWebRetention,
  buildWebSources,
  buildWebTopPaths,
  buildWebTrend,
  type DevicesGroupBy,
  type SourcesGroupBy,
  type WebAnalyticsInterval,
} from './web-analytics.queries.js'

/** Lookback window for the `hosts` procedure — matches the spec's "roughly last
 * 90 days" bound so the Select doesn't scan the table's full history. */
const HOSTS_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000

// Shared base input across every procedure. `host` (31.5) optionally filters every
// query to a single domain — see file header.
//
// `z.coerce.date()` (not `z.date()`): there is no superjson/devalue transformer
// configured on this tRPC instance (see trpc.ts / events.router.ts's
// `z.string().datetime()` precedent for the same constraint), so a `Date` sent
// from the browser round-trips over the wire as a plain ISO string. `z.date()`
// would reject that string outright; `z.coerce.date()` accepts both a `Date`
// instance and a date-like string/number and normalizes to a `Date`.
const baseInputSchema = z.object({
  projectId: z.string(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  interval: z.enum(['day', 'week']).default('day'),
  host: z.string().optional(),
})

/** Format a JS Date as `YYYY-MM-DD HH:mm:ss.SSS` (UTC) for CH's DateTime64 param parser. */
function toChDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '')
}

/** Shared current-range formatting used by every procedure. */
function toChRange(input: { from: Date; to: Date }): { from: string; to: string } {
  return { from: toChDateTime(input.from), to: toChDateTime(input.to) }
}

/**
 * Lower bound of the previous comparison window: a same-length span immediately
 * before `from`. Mirrors events.router.ts's topPages/overview prev-window shape.
 */
function toPrevFrom(input: { from: Date; to: Date }): string {
  const fromMs = input.from.getTime()
  const toMs = input.to.getTime()
  return toChDateTime(new Date(fromMs - (toMs - fromMs)))
}

/** Round to `decimals` places, guarding against -0 and NaN. */
function round(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function pctTrend(cur: number, prev: number): number | null {
  return prev > 0 ? round((100 * (cur - prev)) / prev) : null
}

// ── retention pivot ──────────────────────────────────────────────────────────
// Turns the flat { cohort_week, week_offset, visitors } rows from
// buildWebRetention into a grid: one row per cohort week, with a `retention`
// array of fractions (week_offset 0 is always 1.0 — the cohort itself).
interface RetentionRow {
  cohort_week: string
  week_offset: string
  visitors: string
}

export interface RetentionCohort {
  cohortWeek: string
  size: number
  retention: number[]
}

function pivotRetention(rows: RetentionRow[]): RetentionCohort[] {
  const byWeek = new Map<string, Map<number, number>>()
  for (const r of rows) {
    const offset = Number(r.week_offset)
    const visitors = Number(r.visitors)
    if (!byWeek.has(r.cohort_week)) byWeek.set(r.cohort_week, new Map())
    byWeek.get(r.cohort_week)?.set(offset, visitors)
  }
  const cohorts: RetentionCohort[] = []
  for (const [cohortWeek, offsets] of byWeek) {
    const size = offsets.get(0) ?? 0
    const maxOffset = Math.max(...offsets.keys())
    const retention: number[] = []
    for (let i = 0; i <= maxOffset; i++) {
      const seen = offsets.get(i) ?? 0
      retention.push(size > 0 ? round(seen / size) : 0)
    }
    cohorts.push({ cohortWeek, size, retention })
  }
  // Most recent cohort first — matches the query's ORDER BY cohort_week DESC.
  return cohorts.sort((a, b) => (a.cohortWeek < b.cohortWeek ? 1 : -1))
}

export const webAnalyticsRouter = router({
  overview: requirePermission('projects:read')
    .input(baseInputSchema)
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildWebOverview({
          projectId: input.projectId,
          range: toChRange(input),
          prevFrom: toPrevFrom(input),
          host: input.host,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{
        visitors: string
        prev_visitors: string
        pageviews: string
        prev_pageviews: string
        sessions: string
        prev_sessions: string
      }>()
      const r = rows[0]
      const visitors = Number(r?.visitors ?? 0)
      const prevVisitors = Number(r?.prev_visitors ?? 0)
      const pageviews = Number(r?.pageviews ?? 0)
      const prevPageviews = Number(r?.prev_pageviews ?? 0)
      const sessions = Number(r?.sessions ?? 0)
      const prevSessions = Number(r?.prev_sessions ?? 0)
      return {
        visitors: { value: visitors, trend: pctTrend(visitors, prevVisitors) },
        pageviews: { value: pageviews, trend: pctTrend(pageviews, prevPageviews) },
        sessions: { value: sessions, trend: pctTrend(sessions, prevSessions) },
      }
    }),

  trend: requirePermission('projects:read')
    .input(baseInputSchema)
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildWebTrend({
          projectId: input.projectId,
          range: toChRange(input),
          interval: input.interval as WebAnalyticsInterval,
          host: input.host,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ bucket: string; visitors: string; pageviews: string }>()
      return {
        visitors: rows.map((r) => ({ bucket: r.bucket, value: Number(r.visitors) })),
        pageviews: rows.map((r) => ({ bucket: r.bucket, value: Number(r.pageviews) })),
      }
    }),

  topPaths: requirePermission('projects:read')
    .input(baseInputSchema.extend({ limit: z.number().int().positive().max(100).default(20) }))
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildWebTopPaths({
          projectId: input.projectId,
          range: toChRange(input),
          limit: input.limit,
          host: input.host,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{
        path: string
        visitors: string
        views: string
        bounce_sessions: string
        total_sessions: string
      }>()
      return rows.map((r) => {
        const totalSessions = Number(r.total_sessions)
        const bounceSessions = Number(r.bounce_sessions)
        const bounceRate = totalSessions > 0 ? round((100 * bounceSessions) / totalSessions) : 0
        return {
          path: r.path,
          visitors: Number(r.visitors),
          views: Number(r.views),
          bounceRate,
        }
      })
    }),

  sources: requirePermission('projects:read')
    .input(
      baseInputSchema.extend({
        groupBy: z.enum(['channel', 'utm_source']).default('channel'),
        limit: z.number().int().positive().max(100).default(20),
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildWebSources({
          projectId: input.projectId,
          range: toChRange(input),
          groupBy: input.groupBy as SourcesGroupBy,
          limit: input.limit,
          host: input.host,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ value: string; visitors: string; views: string }>()
      return rows.map((r) => ({
        value: r.value || '(none)',
        visitors: Number(r.visitors),
        views: Number(r.views),
      }))
    }),

  devices: requirePermission('projects:read')
    .input(
      baseInputSchema.extend({
        groupBy: z.enum(['device', 'browser', 'os']).default('device'),
        limit: z.number().int().positive().max(100).default(20),
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildWebDevices({
          projectId: input.projectId,
          range: toChRange(input),
          groupBy: input.groupBy as DevicesGroupBy,
          limit: input.limit,
          host: input.host,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ value: string; visitors: string; views: string }>()
      return rows.map((r) => ({
        value: r.value || '(unknown)',
        visitors: Number(r.visitors),
        views: Number(r.views),
      }))
    }),

  retention: requirePermission('projects:read')
    .input(baseInputSchema.extend({ cohortWeeks: z.number().int().positive().max(26).default(8) }))
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildWebRetention({
          projectId: input.projectId,
          range: toChRange(input),
          cohortWeeks: input.cohortWeeks,
          host: input.host,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<RetentionRow>()
      return pivotRetention(rows)
    }),

  activeHours: requirePermission('projects:read')
    .input(baseInputSchema)
    .query(async ({ input, ctx }) => {
      const scopedDb = await scopedForProject(ctx, input.projectId)
      const project = await scopedDb.project.findFirst({
        where: { id: input.projectId },
        select: { timezone: true },
      })
      const timezone = project?.timezone ?? 'UTC'

      const rs = await clickhouse.query({
        ...buildWebActiveHours({
          projectId: input.projectId,
          range: toChRange(input),
          timezone,
          host: input.host,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ day_of_week: string; hour: string; visitors: string }>()
      return rows.map((r) => ({
        dayOfWeek: Number(r.day_of_week),
        hour: Number(r.hour),
        visitors: Number(r.visitors),
      }))
    }),

  /**
   * Distinct hosts seen for the project in the last ~90 days (31.5), used to
   * populate the page's host/domain filter Select. Deliberately its own input
   * shape (no `from`/`to`/`interval`) — the lookback is fixed server-side, not
   * tied to the dashboard's date-range picker.
   */
  hosts: requirePermission('projects:read')
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const since = toChDateTime(new Date(Date.now() - HOSTS_LOOKBACK_MS))
      const rs = await clickhouse.query({
        ...buildWebHosts({ projectId: input.projectId, since }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ host: string }>()
      return rows.map((r) => r.host)
    }),
})
