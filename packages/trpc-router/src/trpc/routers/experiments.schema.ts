import type { ExperimentMetric, FunnelStepCondition } from '@clickroom/clickhouse'
import { z } from 'zod'

// ── -aligned operator vocabulary ──────────────────────────────
// Same operator set as flags.router.ts / segments.schema.ts / events.router.ts's
// funnelStepSchema — kept in sync by convention, not a shared import (each
// package defines its own zod schema over the same literal union).
const experimentOperatorSchema = z.enum(['exact', 'is_not', 'icontains', 'gt', 'lt', 'is_set'])

// Mirrors `FunnelStepFilter` (packages/clickhouse/src/queries.ts) — note the
// field is named `properties` here (not `filters`), matching
// `ExperimentMetric`'s funnel shape exactly (37.3 spec), which differs from
// funnels.router.ts's own step shape.
const experimentFunnelStepConditionSchema = z
  .object({
    key: z.string().min(1),
    operator: experimentOperatorSchema,
    value: z.any().optional(),
  })
  .strict()

const experimentFunnelStepSchema = z
  .object({
    event: z.string().min(1),
    properties: z.array(experimentFunnelStepConditionSchema).optional(),
  })
  .strict()

const experimentFunnelMetricSchema = z
  .object({
    type: z.literal('funnel'),
    steps: z.array(experimentFunnelStepSchema).min(2).max(8),
    window: z.number().int().positive(),
  })
  .strict()

const experimentMeanMetricSchema = z
  .object({
    type: z.literal('mean'),
    event: z.string().min(1),
    property: z.string().min(1),
  })
  .strict()

const experimentRatioMetricSchema = z
  .object({
    type: z.literal('ratio'),
    numeratorEvent: z.string().min(1),
    denominatorEvent: z.string().min(1),
  })
  .strict()

const experimentRetentionMetricSchema = z
  .object({
    type: z.literal('retention'),
    returnEvent: z.string().min(1),
    days: z.number().int().positive(),
  })
  .strict()

export const experimentMetricSchema = z.discriminatedUnion('type', [
  experimentFunnelMetricSchema,
  experimentMeanMetricSchema,
  experimentRatioMetricSchema,
  experimentRetentionMetricSchema,
])

export type ExperimentMetricInput = z.infer<typeof experimentMetricSchema>

// ── Variant shape ──────────────────────────────────────────────────────────
// Mirrors the linked multivariate FeatureFlag's variant config
// (flags.router.ts's multivariateSchema `variants` entries).
export const experimentVariantSchema = z
  .object({
    key: z.string().min(1),
    rolloutPercentage: z.number().int().min(0).max(100),
  })
  .strict()

export const experimentVariantsSchema = z.array(experimentVariantSchema).min(2)

export type ExperimentVariantInput = z.infer<typeof experimentVariantSchema>

// ── Structural sync guard ─────────────────────────────────────────────────
// packages/clickhouse must not depend on apps/api (zod lives here only), so
// this schema is hand-mirrored from the ExperimentMetric TS type in
// packages/clickhouse/src/queries.ts rather than imported directly.
// `satisfies` below pins one concrete value of each shape against the TS type
// so a future edit to either side that drifts the shape fails typecheck
// instead of silently diverging (same pattern as segments.schema.ts).
const _syncCheckFunnelStepCondition = {
  key: 'plan',
  operator: 'exact',
  value: 'pro',
} satisfies FunnelStepCondition

const _syncCheckFunnelMetric = {
  type: 'funnel',
  steps: [{ event: 'signup', properties: [_syncCheckFunnelStepCondition] }, { event: 'purchase' }],
  window: 86_400,
} satisfies ExperimentMetric

const _syncCheckMeanMetric = {
  type: 'mean',
  event: 'checkout_completed',
  property: 'amount',
} satisfies ExperimentMetric

const _syncCheckRatioMetric = {
  type: 'ratio',
  numeratorEvent: 'like',
  denominatorEvent: 'view',
} satisfies ExperimentMetric

const _syncCheckRetentionMetric = {
  type: 'retention',
  returnEvent: 'app_open',
  days: 7,
} satisfies ExperimentMetric

void _syncCheckFunnelMetric
void _syncCheckMeanMetric
void _syncCheckRatioMetric
void _syncCheckRetentionMetric
