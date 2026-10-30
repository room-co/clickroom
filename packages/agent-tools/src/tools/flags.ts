// Flags domain — mirrors `apps/api/src/trpc/routers/flags.router.ts`
// (`flagsRouter`, mounted as `flags`).
import { z } from 'zod'
import { jsonResult } from '../result.js'
import type { AgentTool } from '../types.js'
import { defineTool } from '../types.js'

const envSlugSchema = z.string().min(1)

const operatorSchema = z.enum(['exact', 'is_not', 'icontains', 'gt', 'lt', 'is_set'])

const propertySchema = z
  .object({
    key: z.string(),
    operator: operatorSchema,
    value: z.any().nullable(),
  })
  .strict()

const groupSchema = z
  .object({
    properties: z.array(propertySchema),
    rollout_percentage: z.number().int().min(0).max(100),
    variant: z.string().nullable(),
    // Boolean served to a matched, in-rollout user. Absent means `true`.
    serve: z.boolean().optional(),
  })
  .strict()

const multivariateSchema = z
  .object({
    variants: z.array(
      z
        .object({
          key: z.string(),
          rollout_percentage: z.number().int().min(0).max(100),
        })
        .strict(),
    ),
  })
  .strict()

const filtersSchema = z
  .object({
    groups: z.array(groupSchema),
    multivariate: multivariateSchema.optional(),
    payloads: z.record(z.string(), z.any()).optional(),
    kind: z.enum(['boolean', 'string', 'number']).optional(),
  })
  .strict()

const patchSchema = z
  .object({
    name: z.string().nullable().optional(),
    env: envSlugSchema.optional(),
    tags: z.array(z.string()).optional(),
    filters: filtersSchema.optional(),
  })
  .strict()

export const flagsTools: AgentTool[] = [
  defineTool({
    name: 'flags_list',
    description: 'List feature flags for a project + environment.',
    category: 'flags',
    mutates: false,
    input: z.object({ projectId: z.string(), env: envSlugSchema }),
    handle: async (input, ctx) => jsonResult(await ctx.client.flags.list.query(input)),
  }),
  defineTool({
    name: 'flag_get',
    description: 'Fetch one feature flag by key, for a project + environment.',
    category: 'flags',
    mutates: false,
    input: z.object({ projectId: z.string(), key: z.string(), env: envSlugSchema }),
    handle: async (input, ctx) => jsonResult(await ctx.client.flags.get.query(input)),
  }),
  defineTool({
    name: 'flag_create',
    description: 'Create a feature flag with the given key, active state, and targeting filters.',
    category: 'flags',
    mutates: true,
    input: z.object({
      projectId: z.string(),
      key: z.string().min(1),
      name: z.string().optional(),
      active: z.boolean(),
      env: envSlugSchema.optional(),
      tags: z.array(z.string()).optional(),
      filters: filtersSchema,
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.flags.create.mutate(input)),
  }),
  defineTool({
    name: 'flag_update',
    description: 'Patch a feature flag (name, env, tags, and/or targeting filters).',
    category: 'flags',
    mutates: true,
    input: z.object({ projectId: z.string(), id: z.string(), patch: patchSchema }),
    handle: async (input, ctx) => jsonResult(await ctx.client.flags.update.mutate(input)),
  }),
  defineTool({
    name: 'flag_toggle',
    description: 'Turn a feature flag on or off.',
    category: 'flags',
    mutates: true,
    input: z.object({ projectId: z.string(), id: z.string(), active: z.boolean() }),
    handle: async (input, ctx) => jsonResult(await ctx.client.flags.toggle.mutate(input)),
  }),
  defineTool({
    name: 'flag_delete',
    description: 'Soft-delete a feature flag.',
    category: 'flags',
    mutates: true,
    input: z.object({ projectId: z.string(), id: z.string() }),
    handle: async (input, ctx) => jsonResult(await ctx.client.flags.delete.mutate(input)),
  }),
]
