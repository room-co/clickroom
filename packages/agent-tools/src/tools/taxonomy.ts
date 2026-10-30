// Taxonomy domain — mirrors `apps/api/src/trpc/routers/taxonomy.router.ts`.
//
// DEVIATION from table: the table lists a single `taxonomy_list`
// row, but `taxonomyRouter` is actually two sub-routers (`events`, `properties`),
// each with their own `list` procedure — there is no single `taxonomy.list`.
// Exposed here as two tools against the real procedure names.
import { z } from 'zod'
import { jsonResult } from '../result.js'
import type { AgentTool } from '../types.js'
import { defineTool } from '../types.js'

export const taxonomyTools: AgentTool[] = [
  defineTool({
    name: 'taxonomy_list_events',
    description: "List a project's known event definitions (from schema taxonomy).",
    category: 'taxonomy',
    mutates: false,
    input: z.object({
      projectId: z.string(),
      search: z.string().optional(),
      includeHidden: z.boolean().optional(),
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.taxonomy.events.list.query(input)),
  }),
  defineTool({
    name: 'taxonomy_list_properties',
    description: "List a project's known event/person property definitions (from schema taxonomy).",
    category: 'taxonomy',
    mutates: false,
    input: z.object({
      projectId: z.string(),
      scope: z.enum(['event', 'person']),
      search: z.string().optional(),
      eventName: z.string().optional(),
    }),
    handle: async (input, ctx) =>
      jsonResult(await ctx.client.taxonomy.properties.list.query(input)),
  }),
]
