// Experiments domain — mirrors `apps/api/src/trpc/routers/experiments.router.ts`
// (`experimentsRouter`, mounted as `experiments`) and its
// `experiments.schema.ts` companion.
import { z } from 'zod'
import { jsonResult } from '../result.js'
import type { AgentTool } from '../types.js'
import { defineTool } from '../types.js'

const envSlugSchema = z.string().min(1)

const experimentOperatorSchema = z.enum(['exact', 'is_not', 'icontains', 'gt', 'lt', 'is_set'])

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

const experimentMetricSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('funnel'),
      steps: z.array(experimentFunnelStepSchema).min(2).max(8),
      window: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('mean'),
      event: z.string().min(1),
      property: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('ratio'),
      numeratorEvent: z.string().min(1),
      denominatorEvent: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('retention'),
      returnEvent: z.string().min(1),
      days: z.number().int().positive(),
    })
    .strict(),
])

const experimentVariantSchema = z
  .object({
    key: z.string().min(1),
    rolloutPercentage: z.number().int().min(0).max(100),
  })
  .strict()

const experimentVariantsSchema = z.array(experimentVariantSchema).min(2)

const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    hypothesis: z.string().nullable().optional(),
    variants: experimentVariantsSchema.optional(),
    primaryMetric: experimentMetricSchema.optional(),
    secondaryMetrics: z.array(experimentMetricSchema).optional(),
    minimumDetectableEffect: z.number().nullable().optional(),
  })
  .strict()

export const experimentsTools: AgentTool[] = [
  defineTool({
    name: 'experiments_list',
    description: 'List experiments for a project + environment.',
    category: 'experiments',
    mutates: false,
    input: z.object({ projectId: z.string(), env: envSlugSchema }),
    handle: async (input, ctx) => jsonResult(await ctx.client.experiments.list.query(input)),
  }),
  defineTool({
    name: 'experiment_get',
    description: 'Fetch one experiment by id.',
    category: 'experiments',
    mutates: false,
    input: z.object({ projectId: z.string(), id: z.string() }),
    handle: async (input, ctx) => jsonResult(await ctx.client.experiments.get.query(input)),
  }),
  defineTool({
    name: 'experiment_results',
    description:
      'Statistical results (per-variant, with a winner if significant) for an experiment.',
    category: 'experiments',
    mutates: false,
    input: z.object({ projectId: z.string(), id: z.string() }),
    handle: async (input, ctx) => jsonResult(await ctx.client.experiments.results.query(input)),
  }),
  defineTool({
    name: 'experiment_create',
    description:
      'Create an experiment (auto-creates a linked multivariate feature flag for bucketing).',
    category: 'experiments',
    mutates: true,
    input: z.object({
      projectId: z.string(),
      name: z.string().min(1),
      description: z.string().optional(),
      hypothesis: z.string().optional(),
      variants: experimentVariantsSchema.optional(),
      primaryMetric: experimentMetricSchema,
      secondaryMetrics: z.array(experimentMetricSchema).optional(),
      env: envSlugSchema.optional(),
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.experiments.create.mutate(input)),
  }),
  defineTool({
    name: 'experiment_update',
    description: 'Patch an experiment (name, metrics, and/or variants while still in draft).',
    category: 'experiments',
    mutates: true,
    input: z.object({ projectId: z.string(), id: z.string(), patch: patchSchema }),
    handle: async (input, ctx) => jsonResult(await ctx.client.experiments.update.mutate(input)),
  }),
  defineTool({
    name: 'experiment_launch',
    description: 'Launch a draft experiment (starts it running and activates its flag).',
    category: 'experiments',
    mutates: true,
    input: z.object({ projectId: z.string(), id: z.string() }),
    handle: async (input, ctx) => jsonResult(await ctx.client.experiments.launch.mutate(input)),
  }),
  defineTool({
    name: 'experiment_stop',
    description: 'Stop a running experiment (marks it complete).',
    category: 'experiments',
    mutates: true,
    input: z.object({ projectId: z.string(), id: z.string() }),
    handle: async (input, ctx) => jsonResult(await ctx.client.experiments.stop.mutate(input)),
  }),
]
