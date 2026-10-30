// Web analytics domain — mirrors
// `apps/api/src/trpc/routers/web-analytics.router.ts` (`webAnalyticsRouter`,
// mounted as `webAnalytics`). All read-only.
import { z } from 'zod'
import { jsonResult } from '../result.js'
import type { AgentTool } from '../types.js'
import { defineTool } from '../types.js'

const baseInputSchema = z.object({
  projectId: z.string(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  interval: z.enum(['day', 'week']).default('day'),
  host: z.string().optional(),
})

export const webAnalyticsTools: AgentTool[] = [
  defineTool({
    name: 'web_analytics_overview',
    description: 'Visitors/pageviews/sessions overview with trends vs. the previous period.',
    category: 'web-analytics',
    mutates: false,
    input: baseInputSchema,
    handle: async (input, ctx) => jsonResult(await ctx.client.webAnalytics.overview.query(input)),
  }),
  defineTool({
    name: 'web_analytics_trend',
    description: 'Visitors/pageviews trend over time, bucketed by day or week.',
    category: 'web-analytics',
    mutates: false,
    input: baseInputSchema,
    handle: async (input, ctx) => jsonResult(await ctx.client.webAnalytics.trend.query(input)),
  }),
  defineTool({
    name: 'web_analytics_top_paths',
    description: 'Top pages by visitors, with view count and bounce rate.',
    category: 'web-analytics',
    mutates: false,
    input: baseInputSchema.extend({ limit: z.number().int().positive().max(100).default(20) }),
    handle: async (input, ctx) => jsonResult(await ctx.client.webAnalytics.topPaths.query(input)),
  }),
  defineTool({
    name: 'web_analytics_sources',
    description: 'Traffic sources (channel or utm_source) by visitors/views.',
    category: 'web-analytics',
    mutates: false,
    input: baseInputSchema.extend({
      groupBy: z.enum(['channel', 'utm_source']).default('channel'),
      limit: z.number().int().positive().max(100).default(20),
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.webAnalytics.sources.query(input)),
  }),
  defineTool({
    name: 'web_analytics_devices',
    description: 'Traffic breakdown by device, browser, or OS.',
    category: 'web-analytics',
    mutates: false,
    input: baseInputSchema.extend({
      groupBy: z.enum(['device', 'browser', 'os']).default('device'),
      limit: z.number().int().positive().max(100).default(20),
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.webAnalytics.devices.query(input)),
  }),
  defineTool({
    name: 'web_analytics_retention',
    description: 'Weekly visitor retention cohorts.',
    category: 'web-analytics',
    mutates: false,
    input: baseInputSchema.extend({ cohortWeeks: z.number().int().positive().max(26).default(8) }),
    handle: async (input, ctx) => jsonResult(await ctx.client.webAnalytics.retention.query(input)),
  }),
  defineTool({
    name: 'web_analytics_active_hours',
    description: "Visitor activity heatmap by day-of-week and hour, in the project's timezone.",
    category: 'web-analytics',
    mutates: false,
    input: baseInputSchema,
    handle: async (input, ctx) =>
      jsonResult(await ctx.client.webAnalytics.activeHours.query(input)),
  }),
  defineTool({
    name: 'web_analytics_hosts',
    description: 'Distinct hosts/domains seen for a project in the last ~90 days.',
    category: 'web-analytics',
    mutates: false,
    input: z.object({ projectId: z.string() }),
    handle: async (input, ctx) => jsonResult(await ctx.client.webAnalytics.hosts.query(input)),
  }),
]
