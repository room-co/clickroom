import type { SegmentCondition, SegmentDefinition, SegmentGroup } from '@clickroom/clickhouse'
import { z } from 'zod'

// ── -aligned operator vocabulary ──────────────────────────────
// Reuses the same operator set as flags.router.ts:34 / events.router.ts's
// funnelStepSchema — kept in sync by convention, not a shared import (each
// package defines its own zod schema over the same literal union).
const segmentOperatorSchema = z.enum(['exact', 'is_not', 'icontains', 'gt', 'lt', 'is_set'])

const traitConditionSchema = z
  .object({
    type: z.literal('trait'),
    key: z.string().min(1),
    operator: segmentOperatorSchema,
    value: z.any().optional(),
  })
  .strict()

const eventPropertyConditionSchema = z
  .object({
    type: z.literal('event_property'),
    key: z.string().min(1),
    operator: segmentOperatorSchema,
    value: z.any().optional(),
    event: z.string().min(1).optional(),
  })
  .strict()

const behavioralConditionSchema = z
  .object({
    type: z.literal('behavioral'),
    event: z.string().min(1),
    count: z.number().int().positive(),
    days: z.number().int().positive().max(365),
  })
  .strict()

const segmentConditionSchema = z.discriminatedUnion('type', [
  traitConditionSchema,
  eventPropertyConditionSchema,
  behavioralConditionSchema,
])

// SegmentGroup is recursive (children may be leaf conditions or subgroups) —
// z.lazy ties the knot. v1 only surfaces one root group in the UI (nested
// groups are out of scope per deferred list) but the compiler and
// this schema already support arbitrary nesting.
const segmentGroupSchema: z.ZodType<SegmentGroup> = z.lazy(() =>
  z
    .object({
      combinator: z.enum(['AND', 'OR']),
      conditions: z.array(z.union([segmentConditionSchema, segmentGroupSchema])),
    })
    .strict(),
)
export type SegmentGroupInput = z.infer<typeof segmentGroupSchema>

export const segmentDefinitionSchema = z
  .object({
    version: z.literal(1),
    root: segmentGroupSchema,
  })
  .strict()

export type SegmentDefinitionInput = z.infer<typeof segmentDefinitionSchema>

// ── Structural sync guard ─────────────────────────────────────────────────
// packages/clickhouse must not depend on apps/api (zod lives here only), so
// this schema is hand-mirrored from the SegmentDefinition/SegmentGroup/
// SegmentCondition TS types in packages/clickhouse/src/queries.ts rather than
// imported directly. `satisfies` below pins one concrete value of each shape
// against the TS type so a future edit to either side that drifts the shape
// fails typecheck instead of silently diverging.
const _syncCheckCondition = {
  type: 'behavioral',
  event: 'signup',
  count: 1,
  days: 30,
} satisfies SegmentCondition

const _syncCheckGroup = {
  combinator: 'AND',
  conditions: [_syncCheckCondition],
} satisfies SegmentGroup

const _syncCheckDefinition = {
  version: 1,
  root: _syncCheckGroup,
} satisfies SegmentDefinition

void _syncCheckDefinition
