import type {
  ActiveUsersArgs,
  BreakdownArgs,
  BreakdownDimension,
  FunnelArgs,
  FunnelStep,
  TrendArgs,
  TrendInterval,
} from '@clickroom/clickhouse'
import { z } from 'zod'
import { funnelStepFilterSchema, funnelStepsSchema } from './events.router.js'
import type { RetentionArgs } from './web-analytics.queries.js'

// Shared ISO date-range input — same shape/parsing contract as events.router.ts's
// rangeSchema/toChRange (the insights.router.ts results procedure normalizes this
// the same way before handing it to a ClickHouse builder).
const rangeSchema = z.object({ from: z.string().datetime(), to: z.string().datetime() }).strict()

// DEVIATION from doc's sketch: `TrendInterval` (packages/clickhouse/src/
// queries.ts:22) is only `'hour' | 'day'` — buildTrend has no week-bucket function
// (bucketFn is toStartOfHour/toStartOfDay only). Restricting to the builder's real
// type here rather than the doc's `'hour'|'day'|'week'`, per the structural-pinning
// requirement below.
const trendIntervalSchema: z.ZodType<TrendInterval> = z.enum(['hour', 'day'])

// Shared optional relative-range preset. When present, the server recomputes
// `range` (and, for trend, `interval`) at query time instead of using the
// stored absolute `range` — see insights.router.ts's `resolveConfigRange`.
const rangeKeySchema = z.enum(['24h', '7d', '14d', '30d'])

const trendInsightSchema = z
  .object({
    type: z.literal('trend'),
    event: z.string().min(1).optional(),
    interval: trendIntervalSchema,
    range: rangeSchema,
    rangeKey: rangeKeySchema.optional(),
    filters: z.array(funnelStepFilterSchema).optional(),
  })
  .strict()

// `window` (day/week/month) determines the bucket granularity of the active-
// users series and is now load-bearing: it's passed through to
// `buildActiveUsers` for real per-bucket (day/week/month) aggregation, not
// just a UI label. See insights.router.ts's `resolveConfigRange`/
// `snapUsersRange` for how `window` also governs the minimum range span.
const usersInsightSchema = z
  .object({
    type: z.literal('users'),
    window: z.enum(['day', 'week', 'month']),
    range: rangeSchema,
    rangeKey: rangeKeySchema.optional(),
  })
  .strict()

const funnelInsightSchema = z
  .object({
    type: z.literal('funnel'),
    // Reuses events.router.ts's funnelStepsSchema (2..8 steps, event + filters)
    // rather than redefining the step/condition shape.
    steps: funnelStepsSchema,
    window: z.number().int().positive(),
    range: rangeSchema,
    rangeKey: rangeKeySchema.optional(),
  })
  .strict()

const retentionInsightSchema = z
  .object({
    type: z.literal('retention'),
    range: rangeSchema,
    rangeKey: rangeKeySchema.optional(),
    cohortWeeks: z.number().int().positive().max(52).optional(),
    host: z.string().optional(),
  })
  .strict()

const breakdownDimensionSchema: z.ZodType<BreakdownDimension> = z.enum([
  'elements_chain_text',
  'elements_chain_href',
  'current_url',
  'path',
  'referring_domain',
])

// DEVIATION from doc's sketch: `event` is REQUIRED, not optional —
// buildBreakdown's BreakdownArgs (queries.ts:436) requires it (the query filters
// `AND event = {event:String}`), so making it optional here would let a config
// pass zod validation but blow up at query time.
const breakdownInsightSchema = z
  .object({
    type: z.literal('breakdown'),
    dimension: breakdownDimensionSchema,
    event: z.string().min(1),
    range: rangeSchema,
    rangeKey: rangeKeySchema.optional(),
    limit: z.number().int().positive().max(100).optional(),
    filters: z.array(funnelStepFilterSchema).optional(),
  })
  .strict()

export const insightConfigSchema = z.discriminatedUnion('type', [
  trendInsightSchema,
  usersInsightSchema,
  funnelInsightSchema,
  retentionInsightSchema,
  breakdownInsightSchema,
])

export type InsightConfigInput = z.infer<typeof insightConfigSchema>

// ── Structural sync guard ─────────────────────────────────────────────────
// Mirrors segments.schema.ts/experiments.schema.ts's pattern: each variant
// (minus `type`, and minus `projectId`/`window`-as-label where the builder
// doesn't take them) is hand-mirrored from the builder's TS input type rather
// than imported directly, so `satisfies` below pins one concrete value of
// each shape against the real builder args — a future edit to either side
// that drifts the shape fails typecheck instead of silently diverging.
const _syncCheckTrend = {
  event: 'signup',
  interval: 'day',
  range: { from: '2024-01-01 00:00:00.000', to: '2024-01-02 00:00:00.000' },
  filters: [{ key: 'plan', operator: 'exact', value: 'pro' }],
} satisfies Omit<TrendArgs, 'projectId'>

const _syncCheckUsers = {
  range: { from: '2024-01-01 00:00:00.000', to: '2024-01-02 00:00:00.000' },
  window: 'day',
} satisfies Omit<ActiveUsersArgs, 'projectId'>

const _syncCheckFunnelStep = {
  event: 'signup',
  filters: [{ key: 'plan', operator: 'exact', value: 'pro' }],
} satisfies FunnelStep

const _syncCheckFunnel = {
  steps: [_syncCheckFunnelStep, { event: 'purchase', filters: [] }],
  window: 86_400,
  range: { from: '2024-01-01 00:00:00.000', to: '2024-01-02 00:00:00.000' },
} satisfies Omit<FunnelArgs, 'projectId'>

const _syncCheckRetention = {
  range: { from: '2024-01-01 00:00:00.000', to: '2024-01-02 00:00:00.000' },
  cohortWeeks: 8,
} satisfies Omit<RetentionArgs, 'projectId'>

const _syncCheckBreakdown = {
  event: 'click',
  dimension: 'referring_domain',
  range: { from: '2024-01-01 00:00:00.000', to: '2024-01-02 00:00:00.000' },
  limit: 20,
  filters: [{ key: 'plan', operator: 'exact', value: 'pro' }],
} satisfies Omit<BreakdownArgs, 'projectId'>

void _syncCheckTrend
void _syncCheckUsers
void _syncCheckFunnel
void _syncCheckRetention
void _syncCheckBreakdown
