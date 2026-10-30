// Projects domain — mirrors `apps/api/src/trpc/routers/projects.router.ts`
// (`projectsRouter`, mounted as `projects`). Only `list` is exposed here —
// create/update/delete are workspace-admin actions out of scope for
// read+mutate tool coverage table.
import { z } from 'zod'
import { jsonResult } from '../result.js'
import type { AgentTool } from '../types.js'
import { defineTool } from '../types.js'

export const projectsTools: AgentTool[] = [
  defineTool({
    name: 'projects_list',
    description: "List every project in the caller's org.",
    category: 'projects',
    mutates: false,
    input: z.object({}),
    handle: async (_input, ctx) => jsonResult(await ctx.client.projects.list.query()),
  }),
]
