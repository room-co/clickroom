import type { CSSProperties } from 'react'
import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ChartTooltip } from '@/components/ChartTooltip'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDate, formatNumber, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { FunnelPreview, type FunnelResultRow } from '@/pages/funnels/FunnelPreview'

/** Shared uppercase/muted column-header treatment — matches DashboardPage/
 * WebAnalyticsPage's convention for table headers. */
const TH_CLASS = 'text-[10px] font-medium uppercase tracking-wider text-muted-foreground'

/** Grid-size tier a widget renders at — `WidgetBoard.tsx`'s `widgetSize()` picks
 * this from the widget's `w`/`h`; `InsightViewerPage` always uses `detailed`. */
export type WidgetSize = 'compact' | 'standard' | 'detailed'

/** Compact-tier headline treatment — mirrors StatCard.tsx's uppercase muted
 * label + big mono number, reused so compact widgets read consistently
 * across insight types regardless of chart shape. */
function CompactStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="font-mono text-2xl font-semibold text-foreground tracking-tight">{value}</div>
    </div>
  )
}

/** Human-readable duration from milliseconds — mirrors FunnelsPage.tsx's
 * local `formatDuration` (not exported from that module). */
function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function clamp01(ratio: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
}

/** Retention cell: a proportional bar-fill in the theme's primary color —
 * mirrors WebAnalyticsPage.tsx's `retentionCellStyle` (not exported from that
 * module, so replicated here). */
function retentionCellStyle(ratio: number): CSSProperties {
  const clamped = clamp01(ratio)
  if (clamped <= 0) {
    return { background: 'color-mix(in srgb, var(--muted) 45%, transparent)' }
  }
  const pct = Math.round(clamped * 100)
  const fill = 'color-mix(in srgb, var(--primary) 45%, transparent)'
  return { background: `linear-gradient(to right, ${fill} ${pct}%, transparent ${pct}%)` }
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  )
}

export type InsightResult =
  | { type: 'trend'; series: { bucket: string; value: number }[] }
  | {
      type: 'users'
      window: 'day' | 'week' | 'month'
      series: { bucket: string; value: number }[]
      rangeWidened?: boolean
    }
  | {
      type: 'funnel'
      steps: { step: number; label: string; alias?: string; count: number; conversionPct: number }[]
      medianMs: number
    }
  | { type: 'retention'; cohorts: { cohortWeek: string; size: number; retention: number[] }[] }
  | { type: 'breakdown'; rows: { value: string; count: number }[] }

/** Axis-less, chrome-less sparkline for the `compact` tier — reused by trend
 * and users density variants. */
function Sparkline({ series }: { series: { bucket: string; value: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={40}>
      <AreaChart data={series} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="insightSparkGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#2DD4BF" stopOpacity={0.25} />
            <stop offset="95%" stopColor="#2DD4BF" stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="value"
          stroke="#2DD4BF"
          strokeWidth={1.5}
          fill="url(#insightSparkGrad)"
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/** Reuses DashboardPage.tsx's area-chart config (gradient defs, axis
 * formatting, ChartTooltip) for trend time-series insights. `size` picks the
 * density: `compact` drops the chart for a headline number + sparkline,
 * `detailed` adds a stat row (total/average) below the same chart. */
export function TrendChart({
  series,
  size = 'standard',
  fillHeight = false,
}: {
  series: { bucket: string; value: number }[]
  size?: WidgetSize
  /** Fill the parent's height instead of a fixed px chart height — only safe
   * when the caller guarantees a definite-height ancestor (the widget board's
   * grid cell); `InsightViewerPage`/the builder preview render in normal flow
   * with no such ancestor, so they keep the fixed-height default. */
  fillHeight?: boolean
}) {
  const chartData = useMemo(
    () => series.map((d) => ({ bucket: d.bucket, value: d.value })),
    [series],
  )
  const isHourly = useMemo(
    () =>
      chartData.length > 1 &&
      new Date(chartData[1].bucket).getTime() - new Date(chartData[0].bucket).getTime() <
        86_400_000,
    [chartData],
  )
  const total = useMemo(() => series.reduce((sum, d) => sum + d.value, 0), [series])
  const average = series.length > 0 ? total / series.length : 0

  if (chartData.length === 0) return <EmptyState message="No data in this range." />

  if (size === 'compact') {
    const latest = series[series.length - 1]
    return (
      <div className="flex flex-col gap-2">
        <CompactStat label="Latest" value={formatNumber(latest.value)} />
        <Sparkline series={series} />
      </div>
    )
  }

  const chart = (
    <AreaChart data={chartData} margin={{ top: 2, right: 0, left: -24, bottom: 0 }}>
      <defs>
        <linearGradient id="insightTrendGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%" stopColor="#2DD4BF" stopOpacity={0.2} />
          <stop offset="95%" stopColor="#2DD4BF" stopOpacity={0} />
        </linearGradient>
      </defs>
      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
      <XAxis
        dataKey="bucket"
        tick={{ fontSize: 10, fill: '#6B6B8A' }}
        axisLine={false}
        tickLine={false}
        tickFormatter={(v: string) => (isHourly ? formatTime(v) : formatDate(v))}
      />
      <YAxis
        tick={{ fontSize: 10, fill: '#6B6B8A' }}
        axisLine={false}
        tickLine={false}
        tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`)}
      />
      <Tooltip content={<ChartTooltip />} />
      <Area
        type="monotone"
        dataKey="value"
        stroke="#2DD4BF"
        strokeWidth={1.5}
        fill="url(#insightTrendGrad)"
        dot={false}
        name="Count"
      />
    </AreaChart>
  )

  return (
    <div
      className={cn(
        'bg-card border border-border rounded-lg p-4',
        fillHeight && 'flex h-full flex-col',
      )}
    >
      <div className="text-xs font-medium text-foreground mb-4 shrink-0">Trend</div>
      {fillHeight ? (
        <div className="flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            {chart}
          </ResponsiveContainer>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={size === 'detailed' ? 340 : 260}>
          {chart}
        </ResponsiveContainer>
      )}
      {size === 'detailed' && (
        <div className="mt-4 flex gap-6 border-t border-border pt-3 shrink-0">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Total in range
            </div>
            <div className="font-mono text-sm font-medium text-foreground">
              {formatNumber(total)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Average
            </div>
            <div className="font-mono text-sm font-medium text-foreground">
              {formatNumber(Math.round(average))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const WINDOW_TITLES: Record<'day' | 'week' | 'month', string> = {
  day: 'Daily Active Users',
  week: 'Weekly Active Users',
  month: 'Monthly Active Users',
}

/** Cadence word for the "range widened" note — mirrors `WINDOW_TITLES`'s
 * per-window vocabulary. */
const WINDOW_CADENCE: Record<'day' | 'week' | 'month', string> = {
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
}

/** Shown when the backend widened the requested range (`snapUsersRange` in
 * insights.router.ts) because it was too narrow to chart at least 2 buckets
 * of the widget's window — otherwise the chart silently ignores a narrow
 * board-level date filter and looks broken. */
function RangeWidenedNote({ window }: { window: 'day' | 'week' | 'month' }) {
  return (
    <div className="text-[10px] text-muted-foreground">
      Range widened — not enough history for {WINDOW_CADENCE[window]} buckets
    </div>
  )
}

/** Bar chart of the per-bucket active-users series (DAU/WAU/MAU), with the
 * latest bucket's value shown as a headline number above the chart — replaces
 * the old single-number `UsersCount` now that `users` results are windowed.
 * `compact` drops the bar chart for a headline number + tiny sparkline;
 * `detailed` grows the chart height. */
export function UsersSeriesChart({
  window,
  series,
  size = 'standard',
  rangeWidened = false,
  fillHeight = false,
}: {
  window: 'day' | 'week' | 'month'
  series: { bucket: string; value: number }[]
  size?: WidgetSize
  rangeWidened?: boolean
  /** See `TrendChart`'s `fillHeight` doc — only safe with a definite-height
   * ancestor (the widget board's grid cell). */
  fillHeight?: boolean
}) {
  const latest = series.length > 0 ? series[series.length - 1] : undefined

  if (size === 'compact') {
    return (
      <div className="flex flex-col gap-2">
        <CompactStat
          label={WINDOW_TITLES[window]}
          value={latest ? formatNumber(latest.value) : '—'}
        />
        {rangeWidened && <RangeWidenedNote window={window} />}
        {series.length > 0 && <Sparkline series={series} />}
      </div>
    )
  }

  const chart = (
    <BarChart data={series} margin={{ top: 2, right: 0, left: -24, bottom: 0 }}>
      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
      <XAxis
        dataKey="bucket"
        tick={{ fontSize: 10, fill: '#6B6B8A' }}
        axisLine={false}
        tickLine={false}
        tickFormatter={(v: string) => formatDate(v)}
      />
      <YAxis
        tick={{ fontSize: 10, fill: '#6B6B8A' }}
        axisLine={false}
        tickLine={false}
        tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`)}
      />
      <Tooltip content={<ChartTooltip />} />
      <Bar dataKey="value" fill="#2DD4BF" radius={[3, 3, 0, 0]} name="Active users" />
    </BarChart>
  )

  return (
    <div
      className={cn(
        'bg-card border border-border rounded-lg p-4',
        fillHeight && 'flex h-full flex-col',
      )}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 shrink-0">
        {WINDOW_TITLES[window]}
      </div>
      {rangeWidened && (
        <div className="mb-2 shrink-0">
          <RangeWidenedNote window={window} />
        </div>
      )}
      <div className="font-mono text-4xl font-semibold text-foreground mb-4 shrink-0">
        {latest ? formatNumber(latest.value) : '—'}
      </div>
      {series.length === 0 ? (
        <EmptyState message="No data in this range." />
      ) : fillHeight ? (
        <div className="flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            {chart}
          </ResponsiveContainer>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={size === 'detailed' ? 300 : 220}>
          {chart}
        </ResponsiveContainer>
      )}
    </div>
  )
}

/** Reuses funnels/FunnelPreview.tsx's step/drop-off bar visualization.
 * `compact` swaps the bars for a one-line text summary; `detailed` keeps the
 * bars and adds a per-step drop-off/median-time numeric table alongside. */
export function FunnelResults({
  steps,
  medianMs,
  labelFor,
  size = 'standard',
}: {
  steps: { step: number; label: string; alias?: string; count: number; conversionPct: number }[]
  medianMs?: number
  labelFor: (value: string) => string
  size?: WidgetSize
}) {
  const rows: FunnelResultRow[] = steps.map((s, i) => {
    const prev = i > 0 ? steps[i - 1] : null
    const dropoffPct =
      prev && prev.count > 0 ? Math.round(((prev.count - s.count) / prev.count) * 1000) / 10 : 0
    return {
      step: s.step,
      label: s.label,
      alias: s.alias,
      count: s.count,
      conversionPct: Math.round(s.conversionPct * 10) / 10,
      dropoffPct,
    }
  })
  const displayLabel = (r: { label: string; alias?: string }) => r.alias || labelFor(r.label)
  const state = rows.length === 0 ? 'empty' : 'ready'

  if (size === 'compact') {
    if (rows.length === 0) return <EmptyState message="No funnel steps configured." />
    const overallPct = rows[rows.length - 1].conversionPct
    return (
      <div className="text-sm text-foreground">
        {rows.length} steps · <span className="font-mono font-medium">{overallPct}%</span> converted
      </div>
    )
  }

  const funnel = (
    <FunnelPreview
      rows={rows}
      displayLabel={displayLabel}
      windowLabel="funnel"
      state={state}
      idleHint="No funnel steps configured."
    />
  )

  if (size !== 'detailed' || rows.length === 0) return funnel

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="flex-1 min-w-0">{funnel}</div>
      <div className="w-full shrink-0 overflow-x-auto rounded-lg border border-border lg:w-64">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={TH_CLASS}>Step</TableHead>
              <TableHead className={cn(TH_CLASS, 'text-right')}>Drop-off</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.step}>
                <TableCell className="text-xs">{displayLabel(r)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{r.dropoffPct}%</TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell className="text-xs text-muted-foreground">Median time</TableCell>
              <TableCell className="text-right font-mono text-xs">
                {formatDuration(medianMs)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

/** Reuses WebAnalyticsPage.tsx's retention cohort grid (Table + proportional
 * bar-fill cells) — that grid isn't extracted into a shared component, so the
 * markup/style helpers are replicated here rather than duplicating a second
 * copy of WINDOW_OPTIONS-style logic. `compact` collapses to a single
 * headline (latest cohort's Week-1 retention); `detailed` grows the row
 * height so more cohorts/weeks read comfortably. */
export function RetentionGrid({
  cohorts,
  size = 'standard',
}: {
  cohorts: { cohortWeek: string; size: number; retention: number[] }[]
  size?: WidgetSize
}) {
  const weeks = Math.max(1, ...cohorts.map((c) => c.retention.length))

  if (cohorts.length === 0) {
    return <EmptyState message="Not enough return visits yet to compute retention." />
  }

  if (size === 'compact') {
    const latest = cohorts[cohorts.length - 1]
    const week1 = latest.retention[1]
    return (
      <CompactStat
        label="Latest cohort — week 1"
        value={week1 === undefined ? '—' : `${Math.round(week1 * 100)}%`}
      />
    )
  }

  const cellPadding = size === 'detailed' ? 'py-2' : 'py-1'

  return (
    <div className="bg-card border border-border rounded-lg overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={TH_CLASS}>Cohort week</TableHead>
            <TableHead className={cn(TH_CLASS, 'text-right')}>Size</TableHead>
            {Array.from({ length: weeks }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed week-offset columns
              <TableHead key={i} className={cn(TH_CLASS, 'text-right')}>
                W{i}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {cohorts.map((cohort) => (
            <TableRow key={cohort.cohortWeek}>
              <TableCell className={cn('font-mono text-xs', cellPadding)}>
                {formatDate(cohort.cohortWeek)}
              </TableCell>
              <TableCell className={cn('text-right font-mono text-xs', cellPadding)}>
                {formatNumber(cohort.size)}
              </TableCell>
              {Array.from({ length: weeks }).map((_, i) => {
                const value = cohort.retention[i]
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed week-offset columns
                  <TableCell key={i} className="p-1 font-mono text-xs">
                    {value === undefined ? (
                      <span
                        className={cn(
                          'block px-1.5 text-right text-muted-foreground/40',
                          cellPadding,
                        )}
                      >
                        —
                      </span>
                    ) : (
                      <div
                        className={cn('min-w-[64px] rounded px-1.5 text-right', cellPadding)}
                        style={retentionCellStyle(value)}
                      >
                        {Math.round(value * 100)}%
                      </div>
                    )}
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** Ranked table — same shape as DashboardPage.tsx's Top Pages panel.
 * `compact` shows only the top 3 rows, no header, no share column;
 * `detailed` adds an inline proportional share-bar per row (reusing
 * `retentionCellStyle`'s gradient-fill technique). */
export function BreakdownTable({
  rows,
  size = 'standard',
}: {
  rows: { value: string; count: number }[]
  size?: WidgetSize
}) {
  if (rows.length === 0) return <EmptyState message="No data in this range." />

  const total = rows.reduce((sum, r) => sum + r.count, 0)
  const shareOf = (count: number) => (total > 0 ? count / total : 0)

  if (size === 'compact') {
    return (
      <div className="flex flex-col divide-y divide-border/50">
        {rows.slice(0, 3).map((row) => (
          <div key={row.value} className="flex items-center gap-3 py-1.5 first:pt-0 last:pb-0">
            <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-foreground">
              {row.value || '—'}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {formatNumber(row.count)}
            </span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="text-xs font-medium text-foreground">Breakdown</div>
        <div className={cn(TH_CLASS, 'flex gap-4')}>
          <span className="text-right w-16">Count</span>
          <span className="text-right w-16">Share</span>
        </div>
      </div>
      <div className="divide-y divide-border/50">
        {rows.map((row) => (
          <div
            key={row.value}
            className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/20 transition-colors"
            style={size === 'detailed' ? retentionCellStyle(shareOf(row.count)) : undefined}
          >
            <div className="flex-1 min-w-0">
              <span className="font-mono text-[11px] text-foreground truncate block">
                {row.value || '—'}
              </span>
            </div>
            <div className="flex gap-4 text-[11px] font-mono shrink-0">
              <span className="text-right w-16 text-muted-foreground">
                {formatNumber(row.count)}
              </span>
              <span className="text-right w-16 text-foreground font-medium">
                {total > 0 ? `${Math.round(shareOf(row.count) * 1000) / 10}%` : '0%'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Single entry point: switches on `result.type` and renders the matching
 * per-type visualization. Shared by `InsightViewerPage` and the widget
 * dashboard board (Feature 2). `labelFor` is only used for funnel step
 * event-name lookups; defaults to the identity function when omitted (e.g.
 * the builder preview, which doesn't resolve display names). `size` picks
 * the density variant — defaults to `standard` (today's behavior) so callers
 * that don't pass it are unaffected; `InsightViewerPage` always passes
 * `detailed`, `WidgetBoard` derives it per-widget from `widgetSize()`. */
export default function InsightResultView({
  result,
  labelFor = (v) => v,
  size = 'standard',
  fillHeight = false,
}: {
  result: InsightResult
  labelFor?: (value: string) => string
  size?: WidgetSize
  /** See `TrendChart`'s `fillHeight` doc — pass only when the caller has a
   * definite-height ancestor (the widget board's grid cell). */
  fillHeight?: boolean
}) {
  switch (result.type) {
    case 'trend':
      return <TrendChart series={result.series} size={size} fillHeight={fillHeight} />
    case 'users':
      return (
        <UsersSeriesChart
          window={result.window}
          series={result.series}
          size={size}
          rangeWidened={result.rangeWidened}
          fillHeight={fillHeight}
        />
      )
    case 'funnel':
      return (
        <FunnelResults
          steps={result.steps}
          medianMs={result.medianMs}
          labelFor={labelFor}
          size={size}
        />
      )
    case 'retention':
      return <RetentionGrid cohorts={result.cohorts} size={size} />
    case 'breakdown':
      return <BreakdownTable rows={result.rows} size={size} />
    default:
      return <EmptyState message="Unsupported insight type." />
  }
}
