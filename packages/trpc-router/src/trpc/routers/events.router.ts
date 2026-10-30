import {
  type BreakdownDimension,
  buildActiveUsersTotal,
  buildBreakdown,
  buildDistinctIdGroup,
  buildEventById,
  buildEventList,
  buildFlagsOverviewByEnv,
  buildFlagsOverviewSummary,
  buildFlagsTopFlags,
  buildFlagTopUsers,
  buildFlagUsageByResponse,
  buildFlagUsageSummary,
  buildFlagUsageTrend,
  buildFlagUsageTrendByResponse,
  buildFunnel,
  buildFunnelHistory,
  buildFunnelStats,
  buildLive,
  buildOverviewActiveUsers,
  buildOverviewEvents,
  buildPropertyValues,
  buildSessionEvents,
  buildTopEvents,
  buildTopPages,
  buildTraitValues,
  buildTrend,
  buildUserActivity,
  buildUserDetail,
  buildUserFlagsAtTime,
  buildUserSessions,
  buildUserSummary,
  buildUsers,
  clickhouse,
  type TrendInterval,
} from '@clickroom/clickhouse'
import { z } from 'zod'
import { requirePermission, router, scopedForProject } from '../trpc.js'
import { envSlugSchema } from './flags.router.js'

// Shared ISO date-range input. CH builders expect ISO-8601 UTC strings.
const rangeSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
})

// Person traits derived from the latest `$identify` event's `$set` for a
// distinct_id (see buildUsers/buildUserSummary `traits` column). All optional —
// a user may never have been identified, or the identifying app may only send
// a subset. Unknown keys in the raw $set are dropped (whitelist).
export interface PersonTraits {
  email?: string
  name?: string
  org_id?: string
  org_name?: string
}

// Parse the raw `$set` JSON string returned by CH into a whitelisted,
// all-optional traits object. Never throws — empty/malformed input → {}.
function parseTraits(raw: string | null | undefined): PersonTraits {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const traits: PersonTraits = {}
    for (const key of ['email', 'name', 'org_id', 'org_name'] as const) {
      const value = (parsed as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.length > 0) traits[key] = value
    }
    return traits
  } catch {
    return {}
  }
}

/**
 * ClickHouse's DateTime64 param parser accepts the `T` separator but rejects a
 * trailing `Z`, while zod's `.datetime()` always emits UTC ISO with `Z`. Normalize
 * to `YYYY-MM-DD HH:mm:ss.SSS` (UTC) before handing the range to any builder.
 */
function toChRange(range: { from: string; to: string }): { from: string; to: string } {
  const fmt = (iso: string) => new Date(iso).toISOString().replace('T', ' ').replace('Z', '')
  return { from: fmt(range.from), to: fmt(range.to) }
}

const intervalSchema: z.ZodType<TrendInterval> = z.enum(['hour', 'day'])

const dimensionSchema: z.ZodType<BreakdownDimension> = z.enum([
  'elements_chain_text',
  'elements_chain_href',
  'current_url',
])

/** Round to `decimals` places, guarding against -0 and NaN. */
function round(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

// ── Funnel step shape (shared with funnels.router.ts) ────────────────────────
// A funnel step is an event name plus AND-ed property predicates. Reuses the
// flags.router.ts operator vocabulary.
// Single AND-ed property predicate — shared by funnel steps here and by trend/
// breakdown insight configs in insights.schema.ts (same FunnelStepFilter shape
// from packages/clickhouse/src/queries.ts).
export const funnelStepFilterSchema = z.object({
  key: z.string().min(1),
  operator: z.enum(['exact', 'is_not', 'icontains', 'gt', 'lt', 'is_set']),
  value: z.any().nullable(),
})

export const funnelStepSchema = z
  .object({
    event: z.string().min(1),
    alias: z.string().max(60).optional(),
    filters: z.array(funnelStepFilterSchema).max(10).default([]),
  })
  .strict()
export const funnelStepsSchema = z.array(funnelStepSchema).min(2).max(8)
export type FunnelStepInput = z.infer<typeof funnelStepSchema>

export const eventsRouter = router({
  topEvents: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), range: rangeSchema }))
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildTopEvents({ projectId: input.projectId, range: toChRange(input.range) }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ event: string; count: string }>()
      return rows.map((r) => ({ event: r.event, count: Number(r.count) }))
    }),

  topPages: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), range: rangeSchema }))
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const chRange = toChRange(input.range)
      // Previous window = a same-length span immediately before `from`.
      const fromMs = new Date(input.range.from).getTime()
      const toMs = new Date(input.range.to).getTime()
      const prevFrom = new Date(fromMs - (toMs - fromMs))
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '')
      const rs = await clickhouse.query({
        ...buildTopPages({ projectId: input.projectId, range: chRange, prevFrom }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{
        page: string
        sessions: string
        prev_sessions: string
        clicks: string
        prev_clicks: string
        click_sessions: string
      }>()
      return rows.map((r) => {
        const sessions = Number(r.sessions)
        const clicks = Number(r.clicks)
        const clickSessions = Number(r.click_sessions)
        const prevSessions = Number(r.prev_sessions)
        // Click rate = share of sessions with ≥1 click (0–100%), not clicks/session.
        const rate = sessions > 0 ? round((100 * clickSessions) / sessions) : 0
        const trend = prevSessions > 0 ? round((100 * (sessions - prevSessions)) / prevSessions) : 0
        return { page: r.page, sessions, clicks, rate, trend }
      })
    }),

  trend: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        // Omit for a total-events trend across every event type.
        event: z.string().optional(),
        range: rangeSchema,
        interval: intervalSchema,
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildTrend({
          projectId: input.projectId,
          event: input.event,
          range: toChRange(input.range),
          interval: input.interval,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ bucket: string; count: string; sessions: string }>()
      return rows.map((r) => ({
        bucket: r.bucket,
        count: Number(r.count),
        sessions: Number(r.sessions),
      }))
    }),

  breakdown: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        event: z.string(),
        dimension: dimensionSchema,
        range: rangeSchema,
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildBreakdown({
          projectId: input.projectId,
          event: input.event,
          dimension: input.dimension,
          range: toChRange(input.range),
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ value: string; count: string }>()
      return rows.map((r) => ({ value: r.value, count: Number(r.count) }))
    }),

  live: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        limit: z.number().int().positive().max(200).default(50),
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildLive({ projectId: input.projectId, limit: input.limit }),
        format: 'JSONEachRow',
      })
      return rs.json<{
        uuid: string
        event: string
        distinct_id: string
        timestamp: string
        current_url: string
      }>()
    }),

  list: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        range: rangeSchema,
        event: z.string().optional(),
        distinctId: z.string().optional(),
        search: z.string().optional(),
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().positive().max(200).default(50),
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildEventList({
          projectId: input.projectId,
          range: toChRange(input.range),
          event: input.event,
          distinctId: input.distinctId,
          search: input.search,
          page: input.page,
          pageSize: input.pageSize,
        }),
        format: 'JSONEachRow',
      })
      return rs.json<{
        uuid: string
        event: string
        distinct_id: string
        timestamp: string
        current_url: string
        schema_valid: number
        schema_errors: string
      }>()
    }),

  funnel: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        steps: funnelStepsSchema,
        window: z.number().int().positive(),
        range: rangeSchema,
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildFunnel({
          projectId: input.projectId,
          steps: input.steps,
          window: input.window,
          range: toChRange(input.range),
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ level: number; reached: number }>()

      // Map exact "furthest level == L" buckets, then suffix-sum so that
      // countAtStep[i] = users who reached AT LEAST step i+1 (level >= i+1).
      const reachedByLevel = new Map<number, number>()
      for (const r of rows) {
        reachedByLevel.set(Number(r.level), Number(r.reached))
      }
      const countAtStep = input.steps.map((_, i) => {
        let sum = 0
        for (const [level, reached] of reachedByLevel) {
          if (level >= i + 1) sum += reached
        }
        return sum
      })

      const entered = countAtStep[0]
      return input.steps.map((step, i) => {
        const count = countAtStep[i]
        const conversionPct = entered === 0 ? 0 : round((count / entered) * 100)
        const prev = i === 0 ? count : countAtStep[i - 1]
        const dropoffPct = i === 0 || prev === 0 ? 0 : round(100 - (count / prev) * 100)
        return {
          step: i + 1,
          label: step.event,
          alias: step.alias,
          count,
          conversionPct,
          dropoffPct,
        }
      })
    }),

  activeUsers: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), range: rangeSchema }))
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildActiveUsersTotal({
          projectId: input.projectId,
          range: toChRange(input.range),
        }),
        format: 'JSONEachRow',
      })
      const [row] = await rs.json<{ count: string }>()
      return Number(row?.count ?? 0)
    }),

  // Stat-card metrics (Total Events, Event Types, Top Event, Active Users) with
  // real period-over-period trends, computed server-side in two scans over the
  // widened [prevFrom, to] window (same pattern as topPages/funnelStats).
  // `trend` is null when the previous window had no baseline — UI renders "—".
  overview: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), range: rangeSchema }))
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const chRange = toChRange(input.range)
      // Previous window = a same-length span immediately before `from`.
      const fromMs = new Date(input.range.from).getTime()
      const toMs = new Date(input.range.to).getTime()
      const prevFrom = new Date(fromMs - (toMs - fromMs))
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '')

      const [eventsRs, activeUsersRs] = await Promise.all([
        clickhouse.query({
          ...buildOverviewEvents({ projectId: input.projectId, range: chRange, prevFrom }),
          format: 'JSONEachRow',
        }),
        clickhouse.query({
          ...buildOverviewActiveUsers({ projectId: input.projectId, range: chRange, prevFrom }),
          format: 'JSONEachRow',
        }),
      ])

      const eventRows = await eventsRs.json<{
        event: string
        count: string
        prev_count: string
      }>()
      const activeUsersRows = await activeUsersRs.json<{
        active_cur: string
        active_prev: string
        visitors_cur: string
        visitors_prev: string
      }>()

      const pctTrend = (cur: number, prev: number): number | null =>
        prev > 0 ? round((100 * (cur - prev)) / prev) : null

      const totalEvents = eventRows.reduce((sum, r) => sum + Number(r.count), 0)
      const prevTotalEvents = eventRows.reduce((sum, r) => sum + Number(r.prev_count), 0)

      const eventTypes = eventRows.filter((r) => Number(r.count) > 0).length
      const prevEventTypes = eventRows.filter((r) => Number(r.prev_count) > 0).length

      const top = eventRows[0]
      const topCount = top ? Number(top.count) : 0
      const topPrevCount = top ? Number(top.prev_count) : 0

      const au = activeUsersRows[0]
      const activeUsersCount = au ? Number(au.active_cur) : 0
      const activeUsersPrevCount = au ? Number(au.active_prev) : 0
      const visitorsCount = au ? Number(au.visitors_cur) : 0
      const visitorsPrevCount = au ? Number(au.visitors_prev) : 0

      return {
        totalEvents: { value: totalEvents, trend: pctTrend(totalEvents, prevTotalEvents) },
        eventTypes: { value: eventTypes, trend: pctTrend(eventTypes, prevEventTypes) },
        topEvent: {
          value: top?.event ?? null,
          trend: top ? pctTrend(topCount, topPrevCount) : null,
        },
        activeUsers: {
          value: activeUsersCount,
          trend: pctTrend(activeUsersCount, activeUsersPrevCount),
        },
        visitors: {
          value: visitorsCount,
          trend: pctTrend(visitorsCount, visitorsPrevCount),
        },
      }
    }),

  users: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        range: rangeSchema,
        page: z.number().int().positive().default(1),
        search: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildUsers({
          projectId: input.projectId,
          range: toChRange(input.range),
          page: input.page,
          pageSize: 50,
          search: input.search,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{
        distinct_id: string
        firstSeen: string
        lastSeen: string
        eventCount: string
        lastUrl: string
        traits: string
      }>()
      return rows.map((r) => ({
        distinct_id: r.distinct_id,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        eventCount: Number(r.eventCount),
        lastUrl: r.lastUrl,
        traits: parseTraits(r.traits),
      }))
    }),

  flagUsage: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        key: z.string(),
        range: rangeSchema,
        interval: intervalSchema.default('day'),
        env: envSlugSchema.optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const chRange = toChRange(input.range)
      const [summaryRs, byResponseRs, trendRs, trendByResponseRs] = await Promise.all([
        clickhouse.query({
          ...buildFlagUsageSummary({
            projectId: input.projectId,
            key: input.key,
            range: chRange,
            env: input.env,
          }),
          format: 'JSONEachRow',
        }),
        clickhouse.query({
          ...buildFlagUsageByResponse({
            projectId: input.projectId,
            key: input.key,
            range: chRange,
            env: input.env,
          }),
          format: 'JSONEachRow',
        }),
        clickhouse.query({
          ...buildFlagUsageTrend({
            projectId: input.projectId,
            key: input.key,
            range: chRange,
            interval: input.interval,
            env: input.env,
          }),
          format: 'JSONEachRow',
        }),
        clickhouse.query({
          ...buildFlagUsageTrendByResponse({
            projectId: input.projectId,
            key: input.key,
            range: chRange,
            interval: input.interval,
            env: input.env,
          }),
          format: 'JSONEachRow',
        }),
      ])

      const summaryRows = await summaryRs.json<{ calls: string; users: string }>()
      const byResponseRows = await byResponseRs.json<{
        response: string
        calls: string
        users: string
      }>()
      const trendRows = await trendRs.json<{ bucket: string; calls: string; users: string }>()
      const trendByResponseRows = await trendByResponseRs.json<{
        bucket: string
        response: string
        calls: string
        users: string
      }>()

      const summary = summaryRows[0]
      return {
        calls: summary ? Number(summary.calls) : 0,
        uniqueUsers: summary ? Number(summary.users) : 0,
        byResponse: byResponseRows.map((r) => ({
          response: r.response,
          calls: Number(r.calls),
          users: Number(r.users),
        })),
        trend: trendRows.map((r) => ({
          bucket: r.bucket,
          calls: Number(r.calls),
          users: Number(r.users),
        })),
        trendByResponse: trendByResponseRows.map((r) => ({
          bucket: r.bucket,
          response: r.response,
          calls: Number(r.calls),
          users: Number(r.users),
        })),
      }
    }),

  flagTopUsers: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        key: z.string(),
        range: rangeSchema,
        limit: z.number().int().positive().max(50).default(10),
        env: envSlugSchema.optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildFlagTopUsers({
          projectId: input.projectId,
          key: input.key,
          range: toChRange(input.range),
          limit: input.limit,
          env: input.env,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{
        distinct_id: string
        evals: string
        lastResponse: string
      }>()
      return rows.map((r) => ({
        distinctId: r.distinct_id,
        evals: Number(r.evals),
        lastResponse: r.lastResponse,
      }))
    }),

  flagsOverview: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        range: rangeSchema,
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const chRange = toChRange(input.range)
      const [summaryRs, byEnvRs, topFlagsRs] = await Promise.all([
        clickhouse.query({
          ...buildFlagsOverviewSummary({ projectId: input.projectId, range: chRange }),
          format: 'JSONEachRow',
        }),
        clickhouse.query({
          ...buildFlagsOverviewByEnv({ projectId: input.projectId, range: chRange }),
          format: 'JSONEachRow',
        }),
        clickhouse.query({
          ...buildFlagsTopFlags({ projectId: input.projectId, range: chRange, limit: 10 }),
          format: 'JSONEachRow',
        }),
      ])

      const summaryRows = await summaryRs.json<{ calls: string; users: string }>()
      const byEnvRows = await byEnvRs.json<{ env: string; calls: string; users: string }>()
      const topFlagsRows = await topFlagsRs.json<{
        flag_key: string
        calls: string
        users: string
      }>()

      const summary = summaryRows[0]
      return {
        totalEvals: summary ? Number(summary.calls) : 0,
        uniqueUsers: summary ? Number(summary.users) : 0,
        byEnv: byEnvRows.map((r) => ({
          env: r.env,
          calls: Number(r.calls),
          users: Number(r.users),
        })),
        topFlags: topFlagsRows.map((r) => ({
          flagKey: r.flag_key,
          calls: Number(r.calls),
          users: Number(r.users),
        })),
      }
    }),

  userDetail: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        distinctId: z.string(),
        limit: z.number().int().positive().max(500).default(100),
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildUserDetail({
          projectId: input.projectId,
          distinctId: input.distinctId,
          limit: input.limit,
        }),
        format: 'JSONEachRow',
      })
      // `properties` is a JSON string column — returned as-is (client parses).
      return rs.json<{
        uuid: string
        event: string
        timestamp: string
        current_url: string
        properties: string
        elements_chain_text: string
        distinct_id: string
      }>()
    }),

  // Chronological event timeline for one session ($session_id). Oldest first.
  sessionEvents: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        sessionId: z.string(),
        limit: z.number().int().positive().max(500).default(200),
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildSessionEvents({
          projectId: input.projectId,
          sessionId: input.sessionId,
          limit: input.limit,
        }),
        format: 'JSONEachRow',
      })
      return rs.json<{
        uuid: string
        event: string
        timestamp: string
        current_url: string
        properties: string
        elements_chain_text: string
      }>()
    }),

  // Single event by uuid — full properties blob for the event detail page.
  // Returns null when the uuid is not found in the project.
  getById: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), uuid: z.string() }))
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildEventById({ projectId: input.projectId, uuid: input.uuid }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{
        uuid: string
        event: string
        distinct_id: string
        timestamp: string
        current_url: string
        properties: string
        elements_chain_text: string
        elements_chain_href: string
        schema_valid: number
        schema_errors: string
      }>()
      return rows[0] ?? null
    }),

  // Lifetime summary for one user (no range): first/last seen + total events +
  // total sessions (distinct non-empty $session_id, migration 003) + person
  // traits derived from their latest $identify event, if any (parseTraits).
  userSummary: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), distinctId: z.string() }))
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildUserSummary({ projectId: input.projectId, distinctId: input.distinctId }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{
        firstSeen: string
        lastSeen: string
        totalEvents: string
        totalSessions: string
        traits: string
      }>()
      const r = rows[0]
      return {
        firstSeen: r?.firstSeen ?? null,
        lastSeen: r?.lastSeen ?? null,
        totalEvents: Number(r?.totalEvents ?? 0),
        totalSessions: Number(r?.totalSessions ?? 0),
        traits: parseTraits(r?.traits),
      }
    }),

  // Latest flag response per flag_key that a user had evaluated at/before a
  // timestamp — "flags at event time". Sourced from the flag_events sink.
  userFlags: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), distinctId: z.string(), at: z.string() }))
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildUserFlagsAtTime({
          projectId: input.projectId,
          distinctId: input.distinctId,
          at: input.at,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ flag_key: string; response: string }>()
      return rows.map((r) => ({ key: r.flag_key, response: r.response }))
    }),

  // Session list for one user (one row per $session_id), newest first. No range —
  // lifetime sessions. Country is not derivable (no geo column) so it is omitted.
  userSessions: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        distinctId: z.string(),
        limit: z.number().int().positive().max(200).default(50),
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildUserSessions({
          projectId: input.projectId,
          distinctId: input.distinctId,
          limit: input.limit,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{
        sessionId: string
        startedAt: string
        endedAt: string
        durationSec: string
        events: string
        pages: string
        entryUrl: string
        exitUrl: string
      }>()
      return rows.map((r) => ({
        sessionId: r.sessionId,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        durationSec: Number(r.durationSec),
        events: Number(r.events),
        pages: Number(r.pages),
        entryUrl: r.entryUrl,
        exitUrl: r.exitUrl,
      }))
    }),

  // Per-day event counts for one user over the last 7 days — feeds the sparkline.
  userActivity: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), distinctId: z.string() }))
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const to = new Date()
      const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000)
      const rs = await clickhouse.query({
        ...buildUserActivity({
          projectId: input.projectId,
          distinctId: input.distinctId,
          range: toChRange({ from: from.toISOString(), to: to.toISOString() }),
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ bucket: string; count: string }>()
      return rows.map((r) => ({ bucket: r.bucket, count: Number(r.count) }))
    }),

  // Median entry→conversion time + current-vs-previous conversion trend for a funnel.
  // Companion to `funnel` (which returns the per-step counts); computed in one scan
  // over [prevFrom, to]. `medianMs` is null when no user fully converted.
  funnelStats: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        steps: funnelStepsSchema,
        window: z.number().int().positive(),
        range: rangeSchema,
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const chRange = toChRange(input.range)
      // Previous window = a same-length span immediately before `from`.
      const fromMs = new Date(input.range.from).getTime()
      const toMs = new Date(input.range.to).getTime()
      const prevFrom = new Date(fromMs - (toMs - fromMs))
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '')
      const rs = await clickhouse.query({
        ...buildFunnelStats({
          projectId: input.projectId,
          steps: input.steps,
          window: input.window,
          range: chRange,
          prevFrom,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{
        medianMs: string | null
        enteredCur: string
        convertedCur: string
        enteredPrev: string
        convertedPrev: string
      }>()
      const r = rows[0]
      const enteredCur = Number(r?.enteredCur ?? 0)
      const convertedCur = Number(r?.convertedCur ?? 0)
      const enteredPrev = Number(r?.enteredPrev ?? 0)
      const convertedPrev = Number(r?.convertedPrev ?? 0)
      const convCur = enteredCur === 0 ? 0 : (convertedCur / enteredCur) * 100
      const convPrev = enteredPrev === 0 ? 0 : (convertedPrev / enteredPrev) * 100
      const median = r?.medianMs == null ? null : Number(r.medianMs)
      return {
        medianMs: median != null && Number.isFinite(median) ? median : null,
        trend: enteredPrev === 0 ? 0 : round(convCur - convPrev),
      }
    }),

  // Daily conversion rate for a funnel — feeds the conversion-over-time chart.
  funnelHistory: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        steps: funnelStepsSchema,
        window: z.number().int().positive(),
        range: rangeSchema,
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildFunnelHistory({
          projectId: input.projectId,
          steps: input.steps,
          window: input.window,
          range: toChRange(input.range),
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ bucket: string; entered: string; converted: string }>()
      return rows.map((r) => {
        const entered = Number(r.entered)
        const converted = Number(r.converted)
        return {
          bucket: r.bucket,
          entered,
          converted,
          rate: entered === 0 ? 0 : round((converted / entered) * 100),
        }
      })
    }),

  // Property-value autocomplete: most common values seen for one event property
  // within a range, for the funnel-builder filter value input.
  propertyValues: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        event: z.string(),
        key: z.string(),
        range: rangeSchema,
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildPropertyValues({
          projectId: input.projectId,
          event: input.event,
          key: input.key,
          range: toChRange(input.range),
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ v: string; c: string }>()
      return rows.map((r) => r.v)
    }),

  // Trait-value autocomplete: most common values seen for one person trait
  // ($identify $set property) within a range, for the segment-builder trait
  // condition's value input. No `event` param — pinned to `$identify` server-side.
  traitValues: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        key: z.string(),
        range: rangeSchema,
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const rs = await clickhouse.query({
        ...buildTraitValues({
          projectId: input.projectId,
          key: input.key,
          range: toChRange(input.range),
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ v: string; c: string }>()
      return rows.map((r) => r.v)
    }),

  // GDPR erasure: hard-delete ALL rows for one distinct_id, all-time, across both
  // per-user tables (events, flag_events). Synchronous CH mutation (mutations_sync)
  // so a follow-up `users`/`userDetail` query reliably no longer returns the person.
  //
  // A person may span several distinct_ids once merged, so purging the one
  // passed in isn't enough — first resolve the full set of distinct_ids currently
  // mapped to the same person (falls back to just the input id if never merged), then
  // purge that whole set from events/flag_events AND from person_distinct_ids itself
  // (otherwise the mapping row would keep resurrecting the person on the next merge).
  purgeUser: requirePermission('projects:manage')
    .input(z.object({ projectId: z.string(), distinctId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)

      const groupRs = await clickhouse.query({
        ...buildDistinctIdGroup({ projectId: input.projectId, distinctId: input.distinctId }),
        format: 'JSONEachRow',
      })
      const groupRows = await groupRs.json<{ distinct_id: string }>()
      const distinctIds = [...new Set(groupRows.map((r) => r.distinct_id))]

      const query_params = { pid: input.projectId, dids: distinctIds }
      for (const table of ['events', 'flag_events', 'person_distinct_ids'] as const) {
        await clickhouse.command({
          query: `ALTER TABLE ${table} DELETE WHERE project_id = {pid:String} AND distinct_id IN {dids:Array(String)} SETTINGS mutations_sync = 1`,
          query_params,
        })
      }
      return { ok: true }
    }),
})
