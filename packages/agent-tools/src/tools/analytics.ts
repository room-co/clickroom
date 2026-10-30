// Analytics domain — mirrors `apps/api/src/trpc/routers/events.router.ts`
// (`eventsRouter`, mounted as `events` on `appRouter`). All read-only.
import { z } from 'zod'
import { jsonResult } from '../result.js'
import type { AgentTool } from '../types.js'
import { defineTool } from '../types.js'

const rangeSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
})

const intervalSchema = z.enum(['hour', 'day'])

const breakdownDimensionSchema = z.enum([
  'elements_chain_text',
  'elements_chain_href',
  'current_url',
])

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

export const analyticsTools: AgentTool[] = [
  defineTool({
    name: 'analytics_top_events',
    description: 'Top events by count in a project over a date range.',
    category: 'analytics',
    mutates: false,
    input: z.object({ projectId: z.string(), range: rangeSchema }),
    handle: async (input, ctx) => jsonResult(await ctx.client.events.topEvents.query(input)),
  }),
  defineTool({
    name: 'analytics_top_pages',
    description: 'Top pages by session count, with click rate and trend vs. the previous period.',
    category: 'analytics',
    mutates: false,
    input: z.object({ projectId: z.string(), range: rangeSchema }),
    handle: async (input, ctx) => jsonResult(await ctx.client.events.topPages.query(input)),
  }),
  defineTool({
    name: 'analytics_trend',
    description: 'Event count trend over time, bucketed by hour or day, optionally for one event.',
    category: 'analytics',
    mutates: false,
    input: z.object({
      projectId: z.string(),
      event: z.string().optional(),
      range: rangeSchema,
      interval: intervalSchema,
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.events.trend.query(input)),
  }),
  defineTool({
    name: 'analytics_breakdown',
    description: 'Breaks down one event by a dimension (element text/href, current URL).',
    category: 'analytics',
    mutates: false,
    input: z.object({
      projectId: z.string(),
      event: z.string(),
      dimension: breakdownDimensionSchema,
      range: rangeSchema,
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.events.breakdown.query(input)),
  }),
  defineTool({
    name: 'analytics_funnel',
    description: 'Runs a 2-8 step conversion funnel over a date range and time window.',
    category: 'analytics',
    mutates: false,
    input: z.object({
      projectId: z.string(),
      steps: funnelStepsSchema,
      window: z.number().int().positive(),
      range: rangeSchema,
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.events.funnel.query(input)),
  }),
  defineTool({
    name: 'analytics_live',
    description: 'Most recent raw events for a project (live tail).',
    category: 'analytics',
    mutates: false,
    input: z.object({
      projectId: z.string(),
      limit: z.number().int().positive().max(200).default(50),
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.events.live.query(input)),
  }),
  defineTool({
    name: 'analytics_overview',
    description:
      'Stat-card overview (total events, event types, top event, active users) with trends.',
    category: 'analytics',
    mutates: false,
    input: z.object({ projectId: z.string(), range: rangeSchema }),
    handle: async (input, ctx) => jsonResult(await ctx.client.events.overview.query(input)),
  }),
  defineTool({
    name: 'analytics_active_users',
    description: 'Distinct active users in a project over a date range.',
    category: 'analytics',
    mutates: false,
    input: z.object({ projectId: z.string(), range: rangeSchema }),
    handle: async (input, ctx) => jsonResult(await ctx.client.events.activeUsers.query(input)),
  }),
  defineTool({
    name: 'events_list',
    description:
      'Paginated raw event list for a project, filterable by event name/distinctId/search.',
    category: 'analytics',
    mutates: false,
    input: z.object({
      projectId: z.string(),
      range: rangeSchema,
      event: z.string().optional(),
      distinctId: z.string().optional(),
      search: z.string().optional(),
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().positive().max(200).default(50),
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.events.list.query(input)),
  }),
  defineTool({
    name: 'event_get',
    description: 'Fetch one raw event by uuid, including its full properties.',
    category: 'analytics',
    mutates: false,
    input: z.object({ projectId: z.string(), uuid: z.string() }),
    handle: async (input, ctx) => jsonResult(await ctx.client.events.getById.query(input)),
  }),
  defineTool({
    name: 'users_list',
    description: 'Paginated list of users (distinct_id) seen in a project over a date range.',
    category: 'analytics',
    mutates: false,
    input: z.object({
      projectId: z.string(),
      range: rangeSchema,
      page: z.number().int().positive().default(1),
      search: z.string().optional(),
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.events.users.query(input)),
  }),
  defineTool({
    name: 'user_detail',
    description: 'Recent raw events for one user (distinct_id), most recent first.',
    category: 'analytics',
    mutates: false,
    input: z.object({
      projectId: z.string(),
      distinctId: z.string(),
      limit: z.number().int().positive().max(500).default(100),
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.events.userDetail.query(input)),
  }),
  defineTool({
    name: 'user_sessions',
    description: 'Lifetime session list for one user (distinct_id), newest first.',
    category: 'analytics',
    mutates: false,
    input: z.object({
      projectId: z.string(),
      distinctId: z.string(),
      limit: z.number().int().positive().max(200).default(50),
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.events.userSessions.query(input)),
  }),
  defineTool({
    name: 'user_activity',
    description: 'Per-day event counts for one user over the last 7 days.',
    category: 'analytics',
    mutates: false,
    input: z.object({ projectId: z.string(), distinctId: z.string() }),
    handle: async (input, ctx) => jsonResult(await ctx.client.events.userActivity.query(input)),
  }),
]
