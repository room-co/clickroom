// Insights domain — mirrors `apps/api/src/trpc/routers/insights.router.ts`
// (`insightsRouter`, mounted as `insights`) and its `insights.schema.ts`
// companion.
import { z } from 'zod'
import { jsonResult } from '../result.js'
import type { AgentTool } from '../types.js'
import { defineTool } from '../types.js'

const rangeSchema = z.object({ from: z.string().datetime(), to: z.string().datetime() }).strict()
const rangeKeySchema = z.enum(['24h', '7d', '14d', '30d'])
const trendIntervalSchema = z.enum(['hour', 'day'])

const funnelStepFilterSchema = z.object({
  key: z.string().min(1),
  operator: z.enum(['exact', 'is_not', 'icontains', 'gt', 'lt', 'is_set']),
  value: z.any().nullable(),
})

const funnelStepSchema = z
  .object({
    event: z.string().min(1),
    alias: z.string().max(60).optional(),
    filters: z.array(funnelStepFilterSchema).max(10).default([]),
  })
  .strict()

const funnelStepsSchema = z.array(funnelStepSchema).min(2).max(8)

const breakdownDimensionSchema = z.enum([
  'elements_chain_text',
  'elements_chain_href',
  'current_url',
  'path',
  'referring_domain',
])

const insightConfigSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('trend'),
      event: z.string().min(1).optional(),
      interval: trendIntervalSchema,
      range: rangeSchema,
      rangeKey: rangeKeySchema.optional(),
      filters: z.array(funnelStepFilterSchema).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('users'),
      window: z.enum(['day', 'week', 'month']),
      range: rangeSchema,
      rangeKey: rangeKeySchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('funnel'),
      steps: funnelStepsSchema,
      window: z.number().int().positive(),
      range: rangeSchema,
      rangeKey: rangeKeySchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('retention'),
      range: rangeSchema,
      rangeKey: rangeKeySchema.optional(),
      cohortWeeks: z.number().int().positive().max(52).optional(),
      host: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('breakdown'),
      dimension: breakdownDimensionSchema,
      event: z.string().min(1),
      range: rangeSchema,
      rangeKey: rangeKeySchema.optional(),
      limit: z.number().int().positive().max(100).optional(),
      filters: z.array(funnelStepFilterSchema).optional(),
    })
    .strict(),
])

const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    config: insightConfigSchema.optional(),
  })
  .strict()

export const insightsTools: AgentTool[] = [
  defineTool({
    name: 'insights_list',
    description: 'List saved insights for a project, optionally filtered by favorite/tag/search.',
    category: 'insights',
    mutates: false,
    input: z.object({
      projectId: z.string(),
      favoritesOnly: z.boolean().optional(),
      tag: z.string().optional(),
      search: z.string().optional(),
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.insights.list.query(input)),
  }),
  defineTool({
    name: 'insight_get',
    description: 'Fetch one saved insight by id.',
    category: 'insights',
    mutates: false,
    input: z.object({ projectId: z.string(), id: z.string() }),
    handle: async (input, ctx) => jsonResult(await ctx.client.insights.get.query(input)),
  }),
  defineTool({
    name: 'insight_results',
    description:
      'Compute results for a saved insight, optionally overriding its date range/interval.',
    category: 'insights',
    mutates: false,
    input: z.object({
      projectId: z.string(),
      id: z.string(),
      rangeOverride: z
        .object({ from: z.string().datetime(), to: z.string().datetime() })
        .strict()
        .optional(),
      interval: z.enum(['hour', 'day']).optional(),
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.insights.results.query(input)),
  }),
  defineTool({
    name: 'insight_create',
    description: 'Create a saved insight (trend, users, funnel, retention, or breakdown).',
    category: 'insights',
    mutates: true,
    input: z.object({
      projectId: z.string(),
      name: z.string().min(1),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      config: insightConfigSchema,
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.insights.create.mutate(input)),
  }),
  defineTool({
    name: 'insight_update',
    description: 'Patch a saved insight (name, description, tags, and/or config).',
    category: 'insights',
    mutates: true,
    input: z.object({ projectId: z.string(), id: z.string(), patch: patchSchema }),
    handle: async (input, ctx) => jsonResult(await ctx.client.insights.update.mutate(input)),
  }),
]
