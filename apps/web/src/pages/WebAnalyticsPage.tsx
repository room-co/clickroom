import { keepPreviousData } from '@tanstack/react-query'
import { Eye, MousePointerClick, Users } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { DateRangeControl } from '@/components/DateRangeControl'
import { PageHeader } from '@/components/PageHeader'
import { StatCard } from '@/components/StatCard'
import { SkeletonChart, SkeletonStatRow, SkeletonTable } from '@/components/skeletons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useUrlDateRange } from '@/hooks/useUrlDateRange'
import { formatDate, formatNumber } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { makeParamSetter, parseEnumParam } from '@/lib/url-params'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'

type SectionState = 'idle' | 'loading' | 'error' | 'empty' | 'ready'

/** Derives the shared idle/loading/error/empty/ready state for a query result,
 * modeled on funnels/FunnelPreview.tsx's convention. `isPending` (not
 * `isLoading`) so a background refetch — e.g. a date-range change, which keeps
 * the previous data via `keepPreviousData` — never collapses a resolved section
 * back to a skeleton. */
function sectionState(
  enabled: boolean,
  query: { isPending: boolean; error: unknown },
  isEmpty: boolean,
): SectionState {
  if (!enabled) return 'idle'
  if (query.isPending) return 'loading'
  if (query.error) return 'error'
  if (isEmpty) return 'empty'
  return 'ready'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.'
}

/** Shared uppercase/muted column-header treatment — matches the convention
 * already established by StatCard.tsx's label style and DashboardPage.tsx's
 * "Top Pages" column headers (`text-[10px] font-medium uppercase tracking-wider
 * text-muted-foreground`), reused here instead of inventing new classes. */
const TH_CLASS = 'text-[10px] font-medium uppercase tracking-wider text-muted-foreground'

function clamp01(ratio: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
}

/** Retention cell: a proportional bar-fill in the theme's primary color (like
 * the reference's shaded percentage bars), hard zero reads as a faint muted
 * fill so empty cohorts are visually distinct from a merely-low percentage. */
function retentionCellStyle(ratio: number): CSSProperties {
  const clamped = clamp01(ratio)
  if (clamped <= 0) {
    return { background: 'color-mix(in srgb, var(--muted) 45%, transparent)' }
  }
  const pct = Math.round(clamped * 100)
  const fill = 'color-mix(in srgb, var(--primary) 45%, transparent)'
  return { background: `linear-gradient(to right, ${fill} ${pct}%, transparent ${pct}%)` }
}

/** Active-hours cell: full-cell intensity shading in the theme's primary
 * color, scaled by ratio-of-max so busier hours read darker. Zero visitors
 * gets a barely-there tint instead of the same floor as low-but-nonzero
 * cells, so empty cells are clearly distinct. */
function hourCellStyle(ratio: number): CSSProperties {
  const clamped = clamp01(ratio)
  const mix = clamped <= 0 ? 4 : 10 + clamped * 55
  return { backgroundColor: `color-mix(in srgb, var(--primary) ${mix.toFixed(0)}%, transparent)` }
}

/** Flat highlight (not intensity-scaled) for the "All" summary row/column in
 * the active-hours heatmap — reuses the chart's secondary violet so summary
 * cells read as a distinct category from the per-cell teal intensity scale,
 * same two-series palette as the trend chart below. */
const HOUR_SUMMARY_STYLE: CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--chart-2) 18%, transparent)',
}

const TREND_CHART_CONFIG: ChartConfig = {
  visitors: { label: 'Visitors', color: 'var(--chart-1)' },
  pageviews: { label: 'Pageviews', color: 'var(--chart-2)' },
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Failed to load</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

/** Ranked table shared by the Sources and Devices cards — path/channel/device |
 * visitors | views. */
function RankedTable({
  rows,
  columnLabel,
}: {
  rows: { value: string; visitors: number; views: number }[]
  columnLabel: string
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={TH_CLASS}>{columnLabel}</TableHead>
            <TableHead className={cn(TH_CLASS, 'text-right')}>Visitors</TableHead>
            <TableHead className={cn(TH_CLASS, 'text-right')}>Views</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.value}>
              <TableCell className="max-w-[160px] truncate font-mono text-xs">
                {row.value}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {formatNumber(row.visitors)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {formatNumber(row.views)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function WebAnalyticsPage() {
  const projectId = useProjectId()
  const enabled = !!projectId

  const [searchParams, setSearchParams] = useSearchParams()
  const setParam = useMemo(() => makeParamSetter(setSearchParams), [setSearchParams])

  // resolveDateRange's own hour/day interval inference is for other pages'
  // trend granularity — this page has its own day/week Select, so only `range`
  // (ISO from/to strings) is used from it.
  const {
    selection: rangeSel,
    setSelection: setRangeSel,
    customRange,
    setCustomRange,
    range,
  } = useUrlDateRange({ defaultSelection: '7d' })

  // URL-backed view filters so the exact breakdown is shareable/bookmarkable.
  const interval = parseEnumParam<'day' | 'week'>(
    searchParams.get('interval'),
    ['day', 'week'],
    'day',
  )
  const sourcesGroupBy = parseEnumParam<'channel' | 'utm_source'>(
    searchParams.get('sources'),
    ['channel', 'utm_source'],
    'channel',
  )
  const devicesGroupBy = parseEnumParam<'device' | 'browser' | 'os'>(
    searchParams.get('devices'),
    ['device', 'browser', 'os'],
    'device',
  )
  // `undefined` means "All hosts" (no filter) — matches the router's optional
  // `host` input, which omits the WHERE clause entirely when absent.
  const host = searchParams.get('host') || undefined
  const setInterval = (v: 'day' | 'week') => setParam('interval', v, 'day')
  const setSourcesGroupBy = (v: 'channel' | 'utm_source') => setParam('sources', v, 'channel')
  const setDevicesGroupBy = (v: 'device' | 'browser' | 'os') => setParam('devices', v, 'device')
  const setHost = (v: string | undefined) => setParam('host', v ?? null)

  const hosts = trpc.webAnalytics.hosts.useQuery({ projectId: projectId as string }, { enabled })
  const hostList = hosts.data ?? []
  // Single-domain-per-project is the common case (per spec) — hide the
  // selector entirely rather than show a disabled control when there's
  // nothing to pick between (0 or 1 known hosts).
  const showHostFilter = hostList.length > 1

  // If the selected host drops out of the list (project data changed, or the
  // list settled at 0/1 entries after loading), fall back to "All hosts"
  // instead of silently filtering on a host that's no longer selectable.
  // Wait for the hosts query to actually resolve before pruning — otherwise a
  // shared `?host=` link gets wiped during the initial load (empty list).
  useEffect(() => {
    if (hosts.isSuccess && host && !hostList.includes(host)) setParam('host', null)
  }, [host, hostList, hosts.isSuccess, setParam])

  // Router input is `z.coerce.date()` (accepts a Date or an ISO string at
  // runtime — see web-analytics.router.ts), but zod's static types don't model
  // coercion, so real `Date` objects keep the client call sites type-checked.
  const baseInput = {
    projectId: projectId as string,
    from: new Date(range.from),
    to: new Date(range.to),
    ...(host ? { host } : {}),
  }
  const queryOpts = { enabled, placeholderData: keepPreviousData } as const

  const overview = trpc.webAnalytics.overview.useQuery(baseInput, queryOpts)

  const trend = trpc.webAnalytics.trend.useQuery({ ...baseInput, interval }, queryOpts)
  const trendRows = useMemo(() => {
    const byBucket = new Map<string, { bucket: string; visitors: number; pageviews: number }>()
    for (const p of trend.data?.visitors ?? []) {
      byBucket.set(p.bucket, { bucket: p.bucket, visitors: p.value, pageviews: 0 })
    }
    for (const p of trend.data?.pageviews ?? []) {
      const existing = byBucket.get(p.bucket)
      if (existing) existing.pageviews = p.value
      else byBucket.set(p.bucket, { bucket: p.bucket, visitors: 0, pageviews: p.value })
    }
    return Array.from(byBucket.values()).sort((a, b) => (a.bucket < b.bucket ? -1 : 1))
  }, [trend.data])
  const trendState = sectionState(enabled, trend, trendRows.length === 0)

  const topPaths = trpc.webAnalytics.topPaths.useQuery(baseInput, queryOpts)
  const topPathsState = sectionState(enabled, topPaths, (topPaths.data ?? []).length === 0)

  const sources = trpc.webAnalytics.sources.useQuery(
    { ...baseInput, groupBy: sourcesGroupBy },
    queryOpts,
  )
  const sourcesState = sectionState(enabled, sources, (sources.data ?? []).length === 0)

  const devices = trpc.webAnalytics.devices.useQuery(
    { ...baseInput, groupBy: devicesGroupBy },
    queryOpts,
  )
  const devicesState = sectionState(enabled, devices, (devices.data ?? []).length === 0)

  const retention = trpc.webAnalytics.retention.useQuery(baseInput, queryOpts)
  const retentionState = sectionState(enabled, retention, (retention.data ?? []).length === 0)
  const retentionWeeks = useMemo(
    () => Math.max(1, ...(retention.data ?? []).map((c) => c.retention.length)),
    [retention.data],
  )

  const activeHours = trpc.webAnalytics.activeHours.useQuery(baseInput, queryOpts)
  const activeHoursState = sectionState(enabled, activeHours, (activeHours.data ?? []).length === 0)
  // Grid keyed by "dayOfWeek-hour" plus client-derived row/column/grand totals
  // for the "All" summary edges (reference image 4) — cheap sums over data
  // already fetched, no extra query.
  const activeHoursGrid = useMemo(() => {
    const grid = new Map<string, number>()
    const dayTotals = new Map<number, number>()
    const hourTotals = new Map<number, number>()
    let max = 0
    let grandTotal = 0
    for (const cell of activeHours.data ?? []) {
      grid.set(`${cell.dayOfWeek}-${cell.hour}`, cell.visitors)
      dayTotals.set(cell.dayOfWeek, (dayTotals.get(cell.dayOfWeek) ?? 0) + cell.visitors)
      hourTotals.set(cell.hour, (hourTotals.get(cell.hour) ?? 0) + cell.visitors)
      grandTotal += cell.visitors
      if (cell.visitors > max) max = cell.visitors
    }
    return { grid, dayTotals, hourTotals, grandTotal, max: max || 1 }
  }, [activeHours.data])

  // Cold load: no section has resolved yet, so render one composed shell rather
  // than six independent skeleton islands landing at different times.
  const pageLoading =
    enabled &&
    overview.isPending &&
    trend.isPending &&
    topPaths.isPending &&
    sources.isPending &&
    devices.isPending &&
    retention.isPending &&
    activeHours.isPending

  return (
    <div className="flex flex-col h-full overflow-auto">
      <PageHeader
        title="Web Analytics"
        subtitle="Visitors, traffic, and engagement for this project"
      >
        <DateRangeControl
          selection={rangeSel}
          onSelectionChange={setRangeSel}
          customRange={customRange}
          onCustomRangeChange={setCustomRange}
        />
        <Select value={interval} onValueChange={(v) => setInterval(v as 'day' | 'week')}>
          <SelectTrigger size="sm" className="w-24">
            <SelectValue placeholder="Interval" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="day">Day</SelectItem>
            <SelectItem value="week">Week</SelectItem>
          </SelectContent>
        </Select>
        {/* Host/domain filter (31.5) — hidden entirely (not disabled) when the
            project has 0 or 1 known hosts, since single-domain-per-project is
            the common case and a disabled control would just be noise. */}
        {showHostFilter ? (
          <Select
            value={host ?? '__all__'}
            onValueChange={(v) => setHost(v === '__all__' ? undefined : v)}
          >
            <SelectTrigger size="sm" className="w-36">
              <SelectValue placeholder="All hosts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All hosts</SelectItem>
              {hostList.map((h) => (
                <SelectItem key={h} value={h}>
                  {h}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </PageHeader>

      <div className="flex-1 p-5 space-y-4">
        {!projectId ? (
          <Alert>
            <AlertTitle>No project selected</AlertTitle>
            <AlertDescription>Create a project to start seeing analytics.</AlertDescription>
          </Alert>
        ) : null}

        {pageLoading ? (
          <WebAnalyticsSkeleton />
        ) : (
          <>
            {/* KPI tiles */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <StatCard
                icon={Users}
                label="Visitors"
                loading={overview.isPending}
                value={formatNumber(overview.data?.visitors.value ?? 0)}
                change={overview.data?.visitors.trend}
              />
              <StatCard
                icon={Eye}
                label="Pageviews"
                loading={overview.isPending}
                value={formatNumber(overview.data?.pageviews.value ?? 0)}
                change={overview.data?.pageviews.trend}
              />
              <StatCard
                icon={MousePointerClick}
                label="Sessions"
                loading={overview.isPending}
                value={formatNumber(overview.data?.sessions.value ?? 0)}
                change={overview.data?.sessions.trend}
              />
            </div>

            {/* Visitors trend */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Visitors over time</CardTitle>
              </CardHeader>
              <CardContent>
                {trendState === 'idle' ? (
                  <EmptyPanel message="Select a project to see the trend." />
                ) : trendState === 'loading' ? (
                  <SkeletonChart height={260} />
                ) : trendState === 'error' ? (
                  <ErrorPanel message={errorMessage(trend.error)} />
                ) : trendState === 'empty' ? (
                  <EmptyPanel message="No visitor data in this range." />
                ) : (
                  <ChartContainer config={TREND_CHART_CONFIG} className="h-[260px] w-full">
                    <AreaChart data={trendRows} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                      <defs>
                        <linearGradient id="webVisitorsGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--color-visitors)" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="var(--color-visitors)" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="webPageviewsGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--color-pageviews)" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="var(--color-pageviews)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} />
                      <XAxis
                        dataKey="bucket"
                        tickLine={false}
                        axisLine={false}
                        fontSize={11}
                        tickFormatter={formatDate}
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        fontSize={11}
                        allowDecimals={false}
                      />
                      <ChartTooltip
                        content={
                          <ChartTooltipContent labelFormatter={(v) => formatDate(String(v))} />
                        }
                      />
                      <Area
                        dataKey="visitors"
                        type="monotone"
                        stroke="var(--color-visitors)"
                        fill="url(#webVisitorsGrad)"
                        dot={false}
                      />
                      <Area
                        dataKey="pageviews"
                        type="monotone"
                        stroke="var(--color-pageviews)"
                        fill="url(#webPageviewsGrad)"
                        dot={false}
                      />
                      <ChartLegend content={<ChartLegendContent />} />
                    </AreaChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>

            {/* Sources + Devices */}
            <div className="flex flex-col md:flex-row gap-3">
              <Card className="flex-1 min-w-0">
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-1 text-sm font-medium">
                    Sources by
                    <Select
                      value={sourcesGroupBy}
                      onValueChange={(v) => setSourcesGroupBy(v as 'channel' | 'utm_source')}
                    >
                      <SelectTrigger
                        size="sm"
                        className="h-auto w-auto gap-1 border-none bg-transparent px-1 py-0 text-sm font-medium text-primary shadow-none hover:bg-accent/40 focus-visible:ring-0"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="channel">Channel</SelectItem>
                        <SelectItem value="utm_source">UTM source</SelectItem>
                      </SelectContent>
                    </Select>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {sourcesState === 'idle' ? (
                    <EmptyPanel message="Select a project to see sources." />
                  ) : sourcesState === 'loading' ? (
                    // RankedTable: channel | visitors | views
                    <SkeletonTable rows={5} cols={3} />
                  ) : sourcesState === 'error' ? (
                    <ErrorPanel message={errorMessage(sources.error)} />
                  ) : sourcesState === 'empty' ? (
                    <EmptyPanel message="No source data in this range." />
                  ) : (
                    <RankedTable
                      rows={sources.data ?? []}
                      columnLabel={sourcesGroupBy === 'channel' ? 'Channel' : 'UTM source'}
                    />
                  )}
                </CardContent>
              </Card>

              <Card className="flex-1 min-w-0">
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-1 text-sm font-medium">
                    Devices by
                    <Select
                      value={devicesGroupBy}
                      onValueChange={(v) => setDevicesGroupBy(v as 'device' | 'browser' | 'os')}
                    >
                      <SelectTrigger
                        size="sm"
                        className="h-auto w-auto gap-1 border-none bg-transparent px-1 py-0 text-sm font-medium text-primary shadow-none hover:bg-accent/40 focus-visible:ring-0"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="device">Device</SelectItem>
                        <SelectItem value="browser">Browser</SelectItem>
                        <SelectItem value="os">OS</SelectItem>
                      </SelectContent>
                    </Select>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {devicesState === 'idle' ? (
                    <EmptyPanel message="Select a project to see devices." />
                  ) : devicesState === 'loading' ? (
                    // RankedTable: device | visitors | views
                    <SkeletonTable rows={5} cols={3} />
                  ) : devicesState === 'error' ? (
                    <ErrorPanel message={errorMessage(devices.error)} />
                  ) : devicesState === 'empty' ? (
                    <EmptyPanel message="No device data in this range." />
                  ) : (
                    <RankedTable
                      rows={devices.data ?? []}
                      columnLabel={
                        devicesGroupBy === 'device'
                          ? 'Device'
                          : devicesGroupBy === 'browser'
                            ? 'Browser'
                            : 'OS'
                      }
                    />
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Top paths */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Top paths</CardTitle>
              </CardHeader>
              <CardContent>
                {topPathsState === 'idle' ? (
                  <EmptyPanel message="Select a project to see top paths." />
                ) : topPathsState === 'loading' ? (
                  // path | visitors | views | bounce rate
                  <SkeletonTable rows={6} cols={4} />
                ) : topPathsState === 'error' ? (
                  <ErrorPanel message={errorMessage(topPaths.error)} />
                ) : topPathsState === 'empty' ? (
                  <EmptyPanel message="No pageviews in this range." />
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className={TH_CLASS}>Path</TableHead>
                          <TableHead className={cn(TH_CLASS, 'text-right')}>Visitors</TableHead>
                          <TableHead className={cn(TH_CLASS, 'text-right')}>Views</TableHead>
                          <TableHead className={cn(TH_CLASS, 'text-right')}>Bounce rate</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(topPaths.data ?? []).map((row) => (
                          <TableRow key={row.path}>
                            <TableCell className="font-mono text-xs">{row.path}</TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {formatNumber(row.visitors)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {formatNumber(row.views)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {row.bounceRate}%
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Retention */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Retention</CardTitle>
              </CardHeader>
              <CardContent>
                {retentionState === 'idle' ? (
                  <EmptyPanel message="Select a project to see retention." />
                ) : retentionState === 'loading' ? (
                  // cohort week | size | W0..Wn — week count is unknown until data
                  // lands, so stand in with a typical 4-week cohort table.
                  <SkeletonTable rows={4} cols={6} />
                ) : retentionState === 'error' ? (
                  <ErrorPanel message={errorMessage(retention.error)} />
                ) : retentionState === 'empty' ? (
                  <EmptyPanel message="Not enough return visits yet to compute retention." />
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className={TH_CLASS}>Cohort week</TableHead>
                          <TableHead className={cn(TH_CLASS, 'text-right')}>Size</TableHead>
                          {Array.from({ length: retentionWeeks }).map((_, i) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: fixed week-offset columns
                            <TableHead key={i} className={cn(TH_CLASS, 'text-right')}>
                              W{i}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(retention.data ?? []).map((cohort) => (
                          <TableRow key={cohort.cohortWeek}>
                            <TableCell className="font-mono text-xs">
                              {formatDate(cohort.cohortWeek)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {formatNumber(cohort.size)}
                            </TableCell>
                            {Array.from({ length: retentionWeeks }).map((_, i) => {
                              const value = cohort.retention[i]
                              return (
                                // biome-ignore lint/suspicious/noArrayIndexKey: fixed week-offset columns
                                <TableCell key={i} className="p-1 font-mono text-xs">
                                  {value === undefined ? (
                                    <span className="block px-1.5 py-1 text-right text-muted-foreground/40">
                                      —
                                    </span>
                                  ) : (
                                    <div
                                      className="min-w-[64px] rounded px-1.5 py-1 text-right"
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
                )}
              </CardContent>
            </Card>

            {/* Active hours */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Active hours</CardTitle>
              </CardHeader>
              <CardContent>
                {activeHoursState === 'idle' ? (
                  <EmptyPanel message="Select a project to see active hours." />
                ) : activeHoursState === 'loading' ? (
                  // day/hour heatmap: 7 day rows + the "All" summary row.
                  <SkeletonTable rows={8} cols={12} />
                ) : activeHoursState === 'error' ? (
                  <ErrorPanel message={errorMessage(activeHours.error)} />
                ) : activeHoursState === 'empty' ? (
                  <EmptyPanel message="No activity data in this range." />
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className={TH_CLASS}>Day</TableHead>
                          {Array.from({ length: 24 }).map((_, hour) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: fixed 0..23 hour columns
                            <TableHead key={hour} className={cn(TH_CLASS, 'text-center px-1')}>
                              {hour}
                            </TableHead>
                          ))}
                          <TableHead className={cn(TH_CLASS, 'text-center px-1')}>All</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {DAY_LABELS.map((label, i) => {
                          const dayOfWeek = i + 1 // CH's toDayOfWeek: 1=Monday..7=Sunday
                          return (
                            <TableRow key={label}>
                              <TableCell className="font-mono text-xs">{label}</TableCell>
                              {Array.from({ length: 24 }).map((_, hour) => {
                                const visitors =
                                  activeHoursGrid.grid.get(`${dayOfWeek}-${hour}`) ?? 0
                                return (
                                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed 0..23 hour columns
                                  <TableCell key={hour} className="p-1 text-center">
                                    <div
                                      className="flex h-7 w-7 items-center justify-center rounded-sm font-mono text-[10px] text-foreground"
                                      style={hourCellStyle(visitors / activeHoursGrid.max)}
                                      title={`${label} ${hour}:00 — ${formatNumber(visitors)} visitors`}
                                    >
                                      {formatNumber(visitors)}
                                    </div>
                                  </TableCell>
                                )
                              })}
                              <TableCell className="p-1 text-center">
                                <div
                                  className="flex h-7 w-full items-center justify-center rounded-sm font-mono text-[10px] font-medium text-foreground"
                                  style={HOUR_SUMMARY_STYLE}
                                >
                                  {formatNumber(activeHoursGrid.dayTotals.get(dayOfWeek) ?? 0)}
                                </div>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                        <TableRow>
                          <TableCell className={cn(TH_CLASS, 'font-mono')}>All</TableCell>
                          {Array.from({ length: 24 }).map((_, hour) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: fixed 0..23 hour columns
                            <TableCell key={hour} className="p-1 text-center">
                              <div
                                className="flex h-7 w-7 items-center justify-center rounded-sm font-mono text-[10px] font-medium text-foreground"
                                style={HOUR_SUMMARY_STYLE}
                              >
                                {formatNumber(activeHoursGrid.hourTotals.get(hour) ?? 0)}
                              </div>
                            </TableCell>
                          ))}
                          <TableCell className="p-1 text-center">
                            <div
                              className="flex h-7 w-full items-center justify-center rounded-sm font-mono text-[10px] font-semibold text-foreground"
                              style={HOUR_SUMMARY_STYLE}
                            >
                              {formatNumber(activeHoursGrid.grandTotal)}
                            </div>
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}

/** Cold-load shell: mirrors the real page grid (3 KPI tiles, trend chart,
 * sources + devices pair, top paths, retention, active hours) so the page
 * doesn't assemble itself out of six independently-resolving islands. */
function WebAnalyticsSkeleton() {
  return (
    <div className="space-y-4">
      <SkeletonStatRow count={3} className="sm:grid-cols-3 lg:grid-cols-3" />
      <Card>
        <CardContent>
          <SkeletonChart height={260} />
        </CardContent>
      </Card>
      <div className="flex flex-col md:flex-row gap-3">
        <Card className="flex-1 min-w-0">
          <CardContent>
            <SkeletonTable rows={5} cols={3} />
          </CardContent>
        </Card>
        <Card className="flex-1 min-w-0">
          <CardContent>
            <SkeletonTable rows={5} cols={3} />
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardContent>
          <SkeletonTable rows={6} cols={4} />
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <SkeletonTable rows={4} cols={6} />
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <SkeletonTable rows={8} cols={12} />
        </CardContent>
      </Card>
    </div>
  )
}
