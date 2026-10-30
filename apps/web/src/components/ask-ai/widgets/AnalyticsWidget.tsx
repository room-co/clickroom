// Renders analytics_* tool output. Three sub-shapes:
//  - `insight`   — reuses InsightResultView.tsx verbatim (trend/breakdown/funnel,
//    plus top_events/top_pages lossily remapped into 'breakdown' — see adapter.ts).
//  - `stat-overview` — analytics_overview's 4 stat cards; no InsightResult variant
//    fits a card grid, so this reuses the existing StatCard component instead of
//    inventing new chart code.
//  - `active-users`  — analytics_active_users returns a single number (not a
//    series), so it doesn't fit InsightResultView's `users` variant either
//    (that needs a windowed series) — rendered as one StatCard.
import { Activity, BarChart3, Hash, Users, Zap } from 'lucide-react'
import InsightResultView, { type InsightResult } from '@/components/insights/InsightResultView'
import { StatCard } from '@/components/StatCard'
import { formatNumber } from '@/lib/format'

export interface OverviewStat {
  label: string
  value: string
  trend: number | null
}

export function buildOverviewStats(output: {
  totalEvents: { value: number; trend: number | null }
  eventTypes: { value: number; trend: number | null }
  topEvent: { value: string | null; trend: number | null }
  activeUsers: { value: number; trend: number | null }
}): OverviewStat[] {
  return [
    {
      label: 'Total events',
      value: formatNumber(output.totalEvents.value),
      trend: output.totalEvents.trend,
    },
    {
      label: 'Event types',
      value: formatNumber(output.eventTypes.value),
      trend: output.eventTypes.trend,
    },
    { label: 'Top event', value: output.topEvent.value ?? '—', trend: output.topEvent.trend },
    {
      label: 'Active users',
      value: formatNumber(output.activeUsers.value),
      trend: output.activeUsers.trend,
    },
  ]
}

const STAT_ICONS = [Zap, Hash, BarChart3, Users]

export function AnalyticsInsightWidget({
  title,
  result,
}: {
  title: string
  result: InsightResult
}) {
  return (
    <div className="w-full min-w-0 rounded-lg border border-border bg-card p-3">
      <div className="mb-2 text-xs font-medium text-foreground">{title}</div>
      <InsightResultView result={result} size="standard" />
    </div>
  )
}

export function AnalyticsOverviewWidget({ stats }: { stats: OverviewStat[] }) {
  return (
    <div className="grid w-full min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
      {stats.map((stat, i) => {
        const Icon = STAT_ICONS[i % STAT_ICONS.length]
        return (
          <StatCard
            key={stat.label}
            icon={Icon}
            label={stat.label}
            value={stat.value}
            change={stat.trend}
          />
        )
      })}
    </div>
  )
}

export function AnalyticsActiveUsersWidget({ count }: { count: number }) {
  return (
    <div className="w-full min-w-0 max-w-xs">
      <StatCard icon={Activity} label="Active users" value={formatNumber(count)} />
    </div>
  )
}
