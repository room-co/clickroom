// Maps AGENT_TOOLS (packages/agent-tools) output into a
// WidgetDescriptor the chat UI can render via <WidgetRenderer />. Only the 17
// tools named across the 4 groups are mapped;
// every other tool name (including every mutating tool, whose confirmation UX
// belongs to ApprovalGate in shell/, not here) returns `null` so the caller
// falls back to a collapsed tool-trace card.
//
// `output` is assumed to already be the tool's *parsed* JSON result (the
// tRPC procedure's return value), not the MCP `AgentToolResult` wrapper
// (`{content:[{type:'text', text: JSON.stringify(...)}]}`) that
// `packages/agent-tools/src/result.ts`'s `jsonResult()` produces for the MCP
// transports — the streaming chat path (agent-toolset.ts, not yet
// built as of this writing) is expected to unwrap/parse that text before
// handing the tool part to the UI, mirroring how the Vercel AI SDK's `tool()`
// `execute()` return value normally flows straight into the message part.
import type { InsightResult } from '@/components/insights/InsightResultView'
import type { FeatureFlagRow } from '@/pages/flags/FlagBits'
import type { OverviewStat } from './AnalyticsWidget'
import { buildOverviewStats } from './AnalyticsWidget'
import type { ExperimentMetricResult } from './ExperimentResultsWidget'
import type { LiveFeedEvent } from './LiveFeedWidget'
import type { SegmentData } from './SegmentWidget'
import type { SqlResultData } from './SqlResultWidget'
import type { UserActivityBucket, UserEventRow, UserSessionRow } from './UserCard'

export type WidgetDescriptor =
  | { kind: 'insight'; title: string; result: InsightResult }
  | { kind: 'stat-overview'; stats: OverviewStat[] }
  | { kind: 'active-users'; count: number }
  | { kind: 'flag'; flag: FeatureFlagRow }
  | { kind: 'flags-list'; flags: FeatureFlagRow[] }
  | {
      kind: 'experiment-results'
      primary: ExperimentMetricResult
      secondary: ExperimentMetricResult[]
    }
  | { kind: 'live-feed'; events: LiveFeedEvent[] }
  | { kind: 'sql-result'; data: SqlResultData }
  | { kind: 'user-events'; events: UserEventRow[] }
  | { kind: 'user-sessions'; sessions: UserSessionRow[] }
  | { kind: 'user-activity'; activity: UserActivityBucket[] }
  | { kind: 'segment'; segment: SegmentData }
  | { kind: 'segment-count'; count: number; scanDays: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

// ── Analytics ────────────────────────────────────────────────────────────

function adaptTrend(output: unknown): WidgetDescriptor | null {
  if (!isArray(output)) return null
  const series = output
    .filter((r): r is { bucket: string; count: number } => isRecord(r))
    .map((r) => ({ bucket: String(r.bucket), value: Number(r.count) }))
  return { kind: 'insight', title: 'Trend', result: { type: 'trend', series } }
}

function adaptBreakdown(output: unknown): WidgetDescriptor | null {
  if (!isArray(output)) return null
  const rows = output
    .filter((r): r is { value: string; count: number } => isRecord(r))
    .map((r) => ({ value: String(r.value), count: Number(r.count) }))
  return { kind: 'insight', title: 'Breakdown', result: { type: 'breakdown', rows } }
}

// Tool output has no `medianMs` (that's a separate, unexposed `funnelStats`
// procedure) — defaults to 0, which InsightResultView's formatDuration()
// already renders as "—" rather than a misleading "0s".
function adaptFunnel(output: unknown): WidgetDescriptor | null {
  if (!isArray(output)) return null
  const steps = output
    .filter(
      (
        r,
      ): r is {
        step: number
        label: string
        alias?: string
        count: number
        conversionPct: number
      } => isRecord(r),
    )
    .map((r) => ({
      step: Number(r.step),
      label: String(r.label),
      alias: r.alias ? String(r.alias) : undefined,
      count: Number(r.count),
      conversionPct: Number(r.conversionPct),
    }))
  return { kind: 'insight', title: 'Funnel', result: { type: 'funnel', steps, medianMs: 0 } }
}

function adaptActiveUsers(output: unknown): WidgetDescriptor | null {
  if (typeof output !== 'number') return null
  return { kind: 'active-users', count: output }
}

function adaptOverview(output: unknown): WidgetDescriptor | null {
  if (!isRecord(output)) return null
  const { totalEvents, eventTypes, topEvent, activeUsers } = output
  if (![totalEvents, eventTypes, topEvent, activeUsers].every(isRecord)) return null
  return {
    kind: 'stat-overview',
    // biome-ignore lint/suspicious/noExplicitAny: shape checked above via isRecord
    stats: buildOverviewStats(output as any),
  }
}

// event/count → value/count, same shape InsightResultView's `breakdown` type
// already renders; no new chart code needed for this tool.
function adaptTopEvents(output: unknown): WidgetDescriptor | null {
  if (!isArray(output)) return null
  const rows = output
    .filter((r): r is { event: string; count: number } => isRecord(r))
    .map((r) => ({ value: String(r.event), count: Number(r.count) }))
  return { kind: 'insight', title: 'Top events', result: { type: 'breakdown', rows } }
}

// page/sessions → value/count. Lossy: drops clicks/rate/trend (no
// InsightResultView variant carries those extra columns) — the model can
// still cite them from the raw tool text if asked.
function adaptTopPages(output: unknown): WidgetDescriptor | null {
  if (!isArray(output)) return null
  const rows = output
    .filter((r): r is { page: string; sessions: number } => isRecord(r))
    .map((r) => ({ value: String(r.page), count: Number(r.sessions) }))
  return { kind: 'insight', title: 'Top pages', result: { type: 'breakdown', rows } }
}

function adaptLive(output: unknown): WidgetDescriptor | null {
  if (!isArray(output)) return null
  const events = output
    .filter((r): r is LiveFeedEvent => isRecord(r))
    .map((r) => ({
      uuid: String(r.uuid),
      event: String(r.event),
      distinct_id: String(r.distinct_id),
      timestamp: String(r.timestamp),
      current_url: String(r.current_url),
    }))
  return { kind: 'live-feed', events }
}

// ── Flags & experiments ─────────────────────────────────────────────────

function adaptFlagGet(output: unknown): WidgetDescriptor | null {
  if (!isRecord(output)) return null
  // biome-ignore lint/suspicious/noExplicitAny: wire shape trusted from own backend
  return { kind: 'flag', flag: output as any }
}

function adaptFlagsList(output: unknown): WidgetDescriptor | null {
  if (!isArray(output)) return null
  // biome-ignore lint/suspicious/noExplicitAny: wire shape trusted from own backend
  return { kind: 'flags-list', flags: output as any }
}

function adaptExperimentResults(output: unknown): WidgetDescriptor | null {
  if (!isRecord(output) || !isRecord(output.primary) || !isArray(output.secondary)) return null
  return {
    kind: 'experiment-results',
    // biome-ignore lint/suspicious/noExplicitAny: wire shape trusted from own backend
    primary: output.primary as any,
    // biome-ignore lint/suspicious/noExplicitAny: wire shape trusted from own backend
    secondary: output.secondary as any,
  }
}

// ── SQL ──────────────────────────────────────────────────────────────────

function adaptSqlQuery(output: unknown): WidgetDescriptor | null {
  if (!isRecord(output) || !isArray(output.columns) || !isArray(output.rows)) return null
  return {
    kind: 'sql-result',
    data: {
      // biome-ignore lint/suspicious/noExplicitAny: wire shape trusted from own backend
      columns: output.columns as any,
      // biome-ignore lint/suspicious/noExplicitAny: wire shape trusted from own backend
      rows: output.rows as any,
      rowCount: Number(output.rowCount ?? output.rows.length),
      elapsedMs: Number(output.elapsedMs ?? 0),
    },
  }
}

// ── Users & segments ────────────────────────────────────────────────────

function adaptUserDetail(output: unknown): WidgetDescriptor | null {
  if (!isArray(output)) return null
  // biome-ignore lint/suspicious/noExplicitAny: wire shape trusted from own backend
  return { kind: 'user-events', events: output as any }
}

function adaptUserSessions(output: unknown): WidgetDescriptor | null {
  if (!isArray(output)) return null
  // biome-ignore lint/suspicious/noExplicitAny: wire shape trusted from own backend
  return { kind: 'user-sessions', sessions: output as any }
}

function adaptUserActivity(output: unknown): WidgetDescriptor | null {
  if (!isArray(output)) return null
  // biome-ignore lint/suspicious/noExplicitAny: wire shape trusted from own backend
  return { kind: 'user-activity', activity: output as any }
}

function adaptSegmentGet(output: unknown): WidgetDescriptor | null {
  if (!isRecord(output) || typeof output.id !== 'string' || typeof output.name !== 'string') {
    return null
  }
  return {
    kind: 'segment',
    segment: {
      id: output.id,
      name: output.name,
      description: typeof output.description === 'string' ? output.description : null,
      // biome-ignore lint/suspicious/noExplicitAny: definition is Prisma Json on the wire
      definition: (output.definition as any) ?? null,
    },
  }
}

function adaptSegmentPreviewCount(output: unknown): WidgetDescriptor | null {
  if (!isRecord(output) || typeof output.count !== 'number') return null
  return {
    kind: 'segment-count',
    count: output.count,
    scanDays: typeof output.scanDays === 'number' ? output.scanDays : 90,
  }
}

const ADAPTERS: Record<string, (output: unknown) => WidgetDescriptor | null> = {
  analytics_trend: adaptTrend,
  analytics_breakdown: adaptBreakdown,
  analytics_funnel: adaptFunnel,
  analytics_active_users: adaptActiveUsers,
  analytics_overview: adaptOverview,
  analytics_top_events: adaptTopEvents,
  analytics_top_pages: adaptTopPages,
  analytics_live: adaptLive,
  flag_get: adaptFlagGet,
  flags_list: adaptFlagsList,
  experiment_results: adaptExperimentResults,
  sql_query: adaptSqlQuery,
  user_detail: adaptUserDetail,
  user_sessions: adaptUserSessions,
  user_activity: adaptUserActivity,
  segment_get: adaptSegmentGet,
  segment_preview_count: adaptSegmentPreviewCount,
}

/**
 * Maps one `AGENT_TOOLS` tool-call result into a `WidgetDescriptor`, or
 * `null` for any tool name without a widget (the caller — `shell/
 * ToolSegment.tsx` — falls back to a collapsed trace card). Never throws:
 * malformed/unexpected output shapes are treated the same as an unmapped
 * tool (`null`), since a bad render is worse than a plain trace card.
 */
export function adaptToolPart(toolName: string, output: unknown): WidgetDescriptor | null {
  const adapt = ADAPTERS[toolName]
  if (!adapt) return null
  try {
    return adapt(output)
  } catch {
    return null
  }
}
