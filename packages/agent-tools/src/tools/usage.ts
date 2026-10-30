// Usage domain — mirrors `apps/api/src/trpc/routers/usage.router.ts`
// (`usageRouter`, mounted as `usage`). Only `summary` (no input) is exposed;
// `setOveragePolicy` is an org-admin mutation out of scope.
import { z } from 'zod'
import { jsonResult } from '../result.js'
import type { AgentTool } from '../types.js'
import { defineTool } from '../types.js'

export const usageTools: AgentTool[] = [
  defineTool({
    name: 'usage_summary',
    description:
      'Org-wide plan usage summary: seats, flags, monthly events, and monthly flag calls.',
    category: 'usage',
    mutates: false,
    input: z.object({}),
    handle: async (_input, ctx) => jsonResult(await ctx.client.usage.summary.query()),
  }),
]
