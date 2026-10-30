// Segments domain — mirrors `apps/api/src/trpc/routers/segments.router.ts`
// (`segmentsRouter`, mounted as `segments`) and its `segments.schema.ts`
// companion.
import { z } from 'zod'
import { jsonResult } from '../result.js'
import type { AgentTool } from '../types.js'
import { defineTool } from '../types.js'

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

interface SegmentGroupInput {
  combinator: 'AND' | 'OR'
  conditions: (z.infer<typeof segmentConditionSchema> | SegmentGroupInput)[]
}

const segmentGroupSchema: z.ZodType<SegmentGroupInput> = z.lazy(() =>
  z
    .object({
      combinator: z.enum(['AND', 'OR']),
      conditions: z.array(z.union([segmentConditionSchema, segmentGroupSchema])),
    })
    .strict(),
)

const segmentDefinitionSchema = z
  .object({
    version: z.literal(1),
    root: segmentGroupSchema,
  })
  .strict()

const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    definition: segmentDefinitionSchema.optional(),
  })
  .strict()

export const segmentsTools: AgentTool[] = [
  defineTool({
    name: 'segments_list',
    description: 'List segments for a project.',
    category: 'segments',
    mutates: false,
    input: z.object({ projectId: z.string() }),
    handle: async (input, ctx) => jsonResult(await ctx.client.segments.list.query(input)),
  }),
  defineTool({
    name: 'segment_get',
    description: 'Fetch one segment by id.',
    category: 'segments',
    mutates: false,
    input: z.object({ projectId: z.string(), id: z.string() }),
    handle: async (input, ctx) => jsonResult(await ctx.client.segments.get.query(input)),
  }),
  defineTool({
    name: 'segment_preview_count',
    description: 'Preview the member count of a segment definition without saving it.',
    category: 'segments',
    mutates: false,
    input: z.object({
      projectId: z.string(),
      definition: segmentDefinitionSchema,
      scanDays: z.number().int().positive().max(365).optional(),
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.segments.previewCount.query(input)),
  }),
  defineTool({
    name: 'segment_create',
    description: 'Create a segment with the given rule definition.',
    category: 'segments',
    mutates: true,
    input: z.object({
      projectId: z.string(),
      name: z.string().min(1),
      description: z.string().optional(),
      definition: segmentDefinitionSchema,
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.segments.create.mutate(input)),
  }),
  defineTool({
    name: 'segment_update',
    description: 'Patch a segment (name, description, and/or rule definition).',
    category: 'segments',
    mutates: true,
    input: z.object({ projectId: z.string(), id: z.string(), patch: patchSchema }),
    handle: async (input, ctx) => jsonResult(await ctx.client.segments.update.mutate(input)),
  }),
  defineTool({
    name: 'segment_materialize',
    description: 'Compute and persist a fresh member snapshot for a segment (synchronous).',
    category: 'segments',
    mutates: true,
    input: z.object({ projectId: z.string(), id: z.string() }),
    handle: async (input, ctx) => jsonResult(await ctx.client.segments.materialize.mutate(input)),
  }),
]
