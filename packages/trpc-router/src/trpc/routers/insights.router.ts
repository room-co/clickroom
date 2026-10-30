import {
  buildActiveUsers,
  buildBreakdown,
  buildFunnel,
  buildFunnelStats,
  buildTrend,
  clickhouse,
} from '@clickroom/clickhouse'
import { newId } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { requirePermission, router, scopedForProject } from '../trpc.js'
import { type InsightConfigInput, insightConfigSchema } from './insights.schema.js'
import { buildWebRetention } from './web-analytics.queries.js'

/**
 * ClickHouse's DateTime64 param parser accepts the `T` separator but rejects a
 * trailing `Z`, while insight configs store `range` as zod `.datetime()` UTC ISO
 * strings (with `Z`). Same normalization as events.router.ts's toChRange —
 * duplicated locally rather than imported (that helper isn't exported).
 */
function toChRange(range: { from: string; to: string }): { from: string; to: string } {
  const fmt = (iso: string) => new Date(iso).toISOString().replace('T', ' ').replace('Z', '')
  return { from: fmt(range.from), to: fmt(range.to) }
}

/** ISO string for `daysAgo` days before now, formatted for zod's `.datetime()`. */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

/** `{ from, to }` spanning the last `days` days, ending now. */
function lastNDaysRange(days: number): { from: string; to: string } {
  return { from: isoDaysAgo(days), to: new Date().toISOString() }
}

type ChRange = { from: string; to: string }
type RangeOverride = { range: ChRange; interval?: 'hour' | 'day' }

/** Number of days a generic `rangeKey` preset covers. */
const RANGE_KEY_DAYS: Record<'24h' | '7d' | '14d' | '30d', number> = {
  '24h': 1,
  '7d': 7,
  '14d': 14,
  '30d': 30,
}

/**
 * Resolves the effective `{ range, interval }` a generic (non-`users`) insight
 * config should be queried with. Precedence: explicit `override` > the
 * config's `rangeKey` (relative preset, recomputed to "now") > the config's
 * stored absolute `range`/`interval` (untouched legacy behaviour).
 */
function resolveGenericRange(
  config: { range: ChRange; rangeKey?: '24h' | '7d' | '14d' | '30d'; interval?: 'hour' | 'day' },
  override?: RangeOverride,
): { range: ChRange; interval?: 'hour' | 'day' } {
  if (override) {
    return { range: override.range, interval: override.interval ?? config.interval }
  }
  if (config.rangeKey) {
    const days = RANGE_KEY_DAYS[config.rangeKey]
    const interval =
      config.interval === undefined ? undefined : config.rangeKey === '24h' ? 'hour' : 'day'
    return { range: lastNDaysRange(days), interval }
  }
  return { range: config.range, interval: config.interval }
}

/** Minimum span (ms) an active-users query must cover for `window` to be meaningful — 1 bucket.
 * (Was 2 buckets — but that made the board's default `7d` filter always widen a `week`-window
 * widget, firing the "range widened" note on the common path instead of genuinely-too-narrow
 * picks like `24h` on a WAU widget.) */
function minSpanForWindow(window: 'day' | 'week' | 'month'): number {
  const DAY_MS = 86_400_000
  if (window === 'day') return DAY_MS
  if (window === 'week') return 7 * DAY_MS
  return 30 * DAY_MS
}

/**
 * Ensures a `users` range spans at least 1 bucket of `window` (day/week/month)
 * so DAU/WAU/MAU is never computed over a sub-window range (e.g. a same-day MAU
 * query, which would only ever produce 0 buckets). Pushes `from` back
 * when the resolved span is narrower than the minimum; leaves wider ranges
 * untouched.
 */
function snapUsersRange(
  range: ChRange,
  window: 'day' | 'week' | 'month',
): { range: ChRange; widened: boolean } {
  const fromMs = new Date(range.from).getTime()
  const toMs = new Date(range.to).getTime()
  const minSpan = minSpanForWindow(window)
  if (toMs - fromMs >= minSpan) return { range, widened: false }
  return { range: { from: new Date(toMs - minSpan).toISOString(), to: range.to }, widened: true }
}

/**
 * Resolves the effective `{ range, interval }` for any insight config,
 * dispatching to the `users`-specific window-aware resolution when needed.
 * `users` configs deliberately skip the generic 24h/7d/14d/30d `rangeKey`
 * resolution (that preset ladder isn't meaningful for a windowed DAU/WAU/MAU
 * series) — instead the effective range is just `override?.range ??
 * config.range`, snapped so it always covers at least 2 buckets of
 * `config.window`.
 */
function resolveConfigRange(
  config: InsightConfigInput,
  override?: RangeOverride,
): { range: ChRange; interval?: 'hour' | 'day'; widened?: boolean } {
  if (config.type === 'users') {
    const range = override?.range ?? config.range
    const { range: snapped, widened } = snapUsersRange(range, config.window)
    return { range: snapped, widened }
  }
  return resolveGenericRange(config, override)
}

const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    config: insightConfigSchema.optional(),
  })
  .strict()

// ── retention pivot ──────────────────────────────────────────────────────────
// Mirrors web-analytics.router.ts's pivotRetention (not exported from that
// module) — turns the flat { cohort_week, week_offset, visitors } rows from
// buildWebRetention into a grid, one row per cohort week.
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
      retention.push(size > 0 ? seen / size : 0)
    }
    cohorts.push({ cohortWeek, size, retention })
  }
  return cohorts.sort((a, b) => (a.cohortWeek < b.cohortWeek ? 1 : -1))
}

// ── funnel step-count suffix sum ──────────────────────────────────────────────
// Mirrors events.router.ts's `funnel` procedure: buildFunnel's rows are exact
// "furthest level == L" buckets, so counting users who reached >= step i
// requires summing `reached` over every row with level >= i.
function suffixSumFunnelLevels(
  rows: { level: number; reached: number }[],
  stepCount: number,
): number[] {
  const reachedByLevel = new Map<number, number>()
  for (const r of rows) {
    reachedByLevel.set(Number(r.level), Number(r.reached))
  }
  return Array.from({ length: stepCount }, (_, i) => {
    let sum = 0
    for (const [level, reached] of reachedByLevel) {
      if (level >= i + 1) sum += reached
    }
    return sum
  })
}

/**
 * Loads a saved insight's config and executes the matching ClickHouse builder
 * via the existing shared client, returning rows shaped per type (39.4):
 * trend → time series, funnel → per-step counts, retention → cohort grid,
 * users → count, breakdown → ranked rows.
 */
async function computeInsightResults(
  projectId: string,
  config: InsightConfigInput,
  override?: RangeOverride,
) {
  const {
    range: effectiveRange,
    interval: effectiveInterval,
    widened: effectiveWidened,
  } = resolveConfigRange(config, override)

  switch (config.type) {
    case 'trend': {
      const rs = await clickhouse.query({
        ...buildTrend({
          projectId,
          event: config.event,
          interval: effectiveInterval ?? config.interval,
          range: toChRange(effectiveRange),
          filters: config.filters,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ bucket: string; count: string }>()
      return {
        type: 'trend' as const,
        series: rows.map((r) => ({ bucket: r.bucket, value: Number(r.count) })),
      }
    }

    case 'users': {
      const rs = await clickhouse.query({
        ...buildActiveUsers({ projectId, range: toChRange(effectiveRange), window: config.window }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ bucket: string; count: string }>()
      return {
        type: 'users' as const,
        window: config.window,
        series: rows.map((r) => ({ bucket: r.bucket, value: Number(r.count) })),
        rangeWidened: effectiveWidened,
      }
    }

    case 'funnel': {
      const chRange = toChRange(effectiveRange)
      const [funnelRs, statsRs] = await Promise.all([
        clickhouse.query({
          ...buildFunnel({
            projectId,
            steps: config.steps,
            window: config.window,
            range: chRange,
          }),
          format: 'JSONEachRow',
        }),
        clickhouse.query({
          ...buildFunnelStats({
            projectId,
            steps: config.steps,
            window: config.window,
            range: chRange,
            prevFrom: chRange.from,
          }),
          format: 'JSONEachRow',
        }),
      ])
      const levelRows = await funnelRs.json<{ level: number; reached: number }>()
      const countAtStep = suffixSumFunnelLevels(levelRows, config.steps.length)
      const entered = countAtStep[0] ?? 0
      const steps = config.steps.map((step, i) => {
        const count = countAtStep[i] ?? 0
        const conversionPct = entered === 0 ? 0 : (count / entered) * 100
        return { step: i + 1, label: step.event, alias: step.alias, count, conversionPct }
      })
      const statsRows = await statsRs.json<{ medianMs: string }>()
      const medianMs = statsRows.length > 0 ? Number(statsRows[0].medianMs) : 0
      return { type: 'funnel' as const, steps, medianMs }
    }

    case 'retention': {
      const rs = await clickhouse.query({
        ...buildWebRetention({
          projectId,
          range: toChRange(effectiveRange),
          cohortWeeks: config.cohortWeeks,
          host: config.host,
          // Product-analytics retention counts every user, not just browser traffic.
          // The Web Analytics page keeps the default 'web' scope; here, dropping
          // server-side (sdk-node) users would render them as churn rather than as
          // the retained users they are.
          scope: 'all',
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<RetentionRow>()
      return { type: 'retention' as const, cohorts: pivotRetention(rows) }
    }

    case 'breakdown': {
      const rs = await clickhouse.query({
        ...buildBreakdown({
          projectId,
          event: config.event,
          dimension: config.dimension,
          range: toChRange(effectiveRange),
          limit: config.limit,
          filters: config.filters,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ value: string; count: string }>()
      return {
        type: 'breakdown' as const,
        rows: rows.map((r) => ({ value: r.value, count: Number(r.count) })),
      }
    }
  }
}

// ── 39.9 default insights ──────────────────────────────────────────────────
// Idempotent seed: skipped entirely if the project already has any (non
// soft-deleted) insight, so "Quick start" is safe to invoke more than once
// and never duplicates rows if the user has already created their own.
function defaultInsightConfigs(): {
  name: string
  description?: string
  config: InsightConfigInput
}[] {
  const last7 = lastNDaysRange(7)
  const last30 = lastNDaysRange(30)
  const last1 = lastNDaysRange(1)

  return [
    {
      name: 'Visit to interaction funnel',
      description: 'Conversion from first pageview to a follow-up interaction event.',
      config: {
        type: 'funnel',
        steps: [
          { event: '$pageview', alias: undefined, filters: [] },
          { event: 'click', alias: undefined, filters: [] },
        ],
        window: 86_400,
        range: last30,
      },
    },
    {
      name: 'Top referrers',
      description: 'Referring domains driving the most traffic.',
      config: {
        type: 'breakdown',
        dimension: 'referring_domain',
        event: '$pageview',
        range: last30,
      },
    },
    {
      name: 'Retention',
      description: 'Weekly cohort retention.',
      config: { type: 'retention', range: last30 },
    },
    {
      name: 'Weekly active users (WAUs)',
      config: { type: 'users', window: 'week', range: last7 },
    },
    {
      name: 'Daily active users (DAUs)',
      config: { type: 'users', window: 'day', range: last1 },
    },
    {
      name: 'Pageviews (last 7 days)',
      config: { type: 'trend', event: '$pageview', interval: 'day', range: last7 },
    },
    {
      name: 'Sessions (last 7 days)',
      description: 'Active users as a proxy for sessions over the last 7 days.',
      config: { type: 'users', window: 'week', range: last7 },
    },
    {
      name: 'Active users (last 30 days)',
      config: { type: 'users', window: 'month', range: last30 },
    },
  ]
}

export const insightsRouter = router({
  list: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        favoritesOnly: z.boolean().optional(),
        tag: z.string().optional(),
        search: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      return pdb.insight.findMany({
        where: {
          deletedAt: null,
          ...(input.favoritesOnly && { isFavorite: true }),
          ...(input.tag && { tags: { has: input.tag } }),
          ...(input.search && {
            OR: [
              { name: { contains: input.search, mode: 'insensitive' } },
              { description: { contains: input.search, mode: 'insensitive' } },
            ],
          }),
        },
        orderBy: { name: 'asc' },
      })
    }),

  get: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const insight = await pdb.insight.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!insight) throw new TRPCError({ code: 'NOT_FOUND', message: 'Insight not found.' })
      return insight
    }),

  create: requirePermission('projects:manage')
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        config: insightConfigSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      return pdb.insight.create({
        data: {
          id: newId(),
          projectId: input.projectId,
          name: input.name,
          description: input.description ?? null,
          type: input.config.type,
          config: input.config,
          tags: input.tags ?? [],
          createdBy: ctx.tokenPayload?.sub ?? '',
        },
      })
    }),

  update: requirePermission('projects:manage')
    .input(z.object({ projectId: z.string(), id: z.string(), patch: patchSchema }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.insight.updateMany({
        where: { id: input.id, deletedAt: null },
        data: {
          ...(input.patch.name !== undefined && { name: input.patch.name }),
          ...(input.patch.description !== undefined && { description: input.patch.description }),
          ...(input.patch.tags !== undefined && { tags: input.patch.tags }),
          ...(input.patch.config !== undefined && {
            type: input.patch.config.type,
            config: input.patch.config,
          }),
        },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Insight not found.' })
      }
      return pdb.insight.findFirstOrThrow({ where: { id: input.id } })
    }),

  delete: requirePermission('projects:manage')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.insight.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { deletedAt: new Date() },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Insight not found.' })
      }
      return { id: input.id, deleted: true }
    }),

  toggleFavorite: requirePermission('projects:manage')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const existing = await pdb.insight.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Insight not found.' })

      const { count } = await pdb.insight.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { isFavorite: !existing.isFavorite },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Insight not found.' })
      }
      return pdb.insight.findFirstOrThrow({ where: { id: input.id } })
    }),

  results: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        id: z.string(),
        rangeOverride: z
          .object({ from: z.string().datetime(), to: z.string().datetime() })
          .strict()
          .optional(),
        interval: z.enum(['hour', 'day']).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const insight = await pdb.insight.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!insight) throw new TRPCError({ code: 'NOT_FOUND', message: 'Insight not found.' })

      const config = insightConfigSchema.parse(insight.config)
      const override: RangeOverride | undefined = input.rangeOverride
        ? { range: input.rangeOverride, interval: input.interval }
        : undefined
      return computeInsightResults(input.projectId, config, override)
    }),

  // Same builder dispatch as `results`, fed from an in-progress unsaved
  // config instead of a loaded row — mirrors events.router.ts's `funnel`
  // procedure, which lets FunnelBuilderPage preview before saving. Also
  // resolves `config.rangeKey` (or a `users` config's window snap) the same
  // way as `results` so the live preview matches saved behaviour.
  previewResults: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), config: insightConfigSchema }))
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      return computeInsightResults(input.projectId, input.config)
    }),

  seedDefaults: requirePermission('projects:manage')
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const existingCount = await pdb.insight.count({ where: { deletedAt: null } })
      if (existingCount > 0) {
        return { seeded: false as const, count: 0 }
      }

      const defaults = defaultInsightConfigs()
      const createdBy = ctx.tokenPayload?.sub ?? ''
      await pdb.insight.createMany({
        data: defaults.map((d) => ({
          id: newId(),
          projectId: input.projectId,
          name: d.name,
          description: d.description ?? null,
          type: d.config.type,
          config: d.config,
          tags: [],
          createdBy,
        })),
      })
      return { seeded: true as const, count: defaults.length }
    }),
})
