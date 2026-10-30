import { keepPreviousData } from '@tanstack/react-query'
import { Activity, Clock, Users, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { EventTypeBadge } from '@/components/badges'
import { ChartTooltip } from '@/components/ChartTooltip'
import { DateRangeControl } from '@/components/DateRangeControl'
import { PageHeader } from '@/components/PageHeader'
import { StatCard } from '@/components/StatCard'
import { SkeletonChart, SkeletonList, SkeletonStatRow, SkeletonTable } from '@/components/skeletons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useUrlDateRange } from '@/hooks/useUrlDateRange'
import { formatDate, formatNumber, formatRelative, formatTime } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'

// country is not exposed by the live API — derive a deterministic mock per row.
const MOCK_COUNTRIES = ['US', 'DE', 'BR', 'GB', 'FR', 'JP', 'CA', 'IN', 'AU', 'NL'] as const

function mockCountry(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1)
    hash = (hash + seed.charCodeAt(i)) % MOCK_COUNTRIES.length
  return MOCK_COUNTRIES[hash]
}

export function DashboardPage() {
  const projectId = useProjectId()
  const [refreshMs, setRefreshMs] = useState(0)

  // Ticks on the same cadence as the refresh selector so `range`'s "now"
  // endpoint actually advances — otherwise it's frozen at mount/selection
  // time and every poll re-fetches the identical window (stats/chart/live
  // feed appear frozen even though the query IS refetching).
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (refreshMs <= 0) return
    const id = setInterval(() => setTick((t) => t + 1), refreshMs)
    return () => clearInterval(id)
  }, [refreshMs])

  const {
    selection: rangeSel,
    setSelection: setRangeSel,
    customRange,
    setCustomRange,
    range,
    interval,
  } = useUrlDateRange({ defaultSelection: '14d', refreshTick: tick })

  const enabled = !!projectId
  // react-query wants `false` (not 0) to disable polling.
  const refetchInterval = refreshMs > 0 ? refreshMs : (false as const)

  const overview = trpc.events.overview.useQuery(
    { projectId: projectId as string, range },
    { enabled, refetchInterval, placeholderData: keepPreviousData },
  )
  // Total events over time — not filtered to a single event type, so one dominant
  // event type can't flatten the trend for everything else.
  const trend = trpc.events.trend.useQuery(
    { projectId: projectId as string, range, interval },
    { enabled, refetchInterval, placeholderData: keepPreviousData },
  )

  const topPages = trpc.events.topPages.useQuery(
    { projectId: projectId as string, range },
    { enabled, refetchInterval, placeholderData: keepPreviousData },
  )

  const live = trpc.events.live.useQuery(
    // Preview feed — cap at the 10 most-recent events so the panel stays compact.
    // Honors the global refresh toggle (no independent polling when it's Off).
    { projectId: projectId as string, limit: 10 },
    { enabled, refetchInterval, placeholderData: keepPreviousData },
  )

  const chartData = useMemo(
    () =>
      (trend.data ?? []).map((d) => ({
        bucket: d.bucket,
        events: d.count,
        sessions: d.sessions,
      })),
    [trend.data],
  )

  // Cold load: nothing on the page has resolved yet, so render one composed
  // shell instead of four unsynchronized skeleton islands popping in.
  const pageLoading =
    enabled && overview.isPending && trend.isPending && topPages.isPending && live.isPending

  const subtitle = `${new Date().toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })} · Live`

  return (
    <div className="flex flex-col h-full overflow-auto">
      <PageHeader title="Dashboard" subtitle={subtitle}>
        <DateRangeControl
          selection={rangeSel}
          onSelectionChange={setRangeSel}
          customRange={customRange}
          onCustomRangeChange={setCustomRange}
          refresh={{ value: refreshMs, onChange: setRefreshMs }}
        />
      </PageHeader>

      <div className="flex-1 p-5 space-y-4">
        {!projectId ? (
          <Alert>
            <AlertTitle>No project selected</AlertTitle>
            <AlertDescription>Create a project to start seeing analytics.</AlertDescription>
          </Alert>
        ) : null}

        {pageLoading ? (
          <DashboardSkeleton />
        ) : (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <StatCard
                icon={Zap}
                label="Total Events"
                loading={overview.isPending}
                value={formatNumber(overview.data?.totalEvents.value ?? 0)}
                change={overview.data?.totalEvents.trend}
              />
              <StatCard
                icon={Activity}
                label="Event Types"
                loading={overview.isPending}
                value={formatNumber(overview.data?.eventTypes.value ?? 0)}
                change={overview.data?.eventTypes.trend}
              />
              <StatCard
                icon={Clock}
                label="Active Users"
                loading={overview.isPending}
                value={formatNumber(overview.data?.activeUsers.value ?? 0)}
                change={overview.data?.activeUsers.trend}
              />
              <StatCard
                icon={Users}
                label="Visitors"
                loading={overview.isPending}
                value={formatNumber(overview.data?.visitors.value ?? 0)}
                change={overview.data?.visitors.trend}
              />
            </div>

            {/* Area chart */}
            <div className="bg-card border border-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-xs font-medium text-foreground">Events over time</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    All events · sessions
                  </div>
                </div>
                <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-[2px] bg-teal-400 inline-block rounded" />
                    Events
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-[2px] bg-violet-400 inline-block rounded" />
                    Sessions
                  </span>
                </div>
              </div>

              {trend.isPending ? (
                <SkeletonChart height={160} />
              ) : trend.error ? (
                <InlineError message={trend.error.message} />
              ) : chartData.length === 0 ? (
                <EmptyState message="No events in this range." />
              ) : (
                <ResponsiveContainer width="100%" height={160}>
                  <AreaChart data={chartData} margin={{ top: 2, right: 0, left: -24, bottom: 0 }}>
                    <defs>
                      <linearGradient id="dashEventsGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#2DD4BF" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#2DD4BF" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="dashSessionsGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#A78BFA" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#A78BFA" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis
                      dataKey="bucket"
                      tick={{ fontSize: 10, fill: '#6B6B8A' }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: string) =>
                        interval === 'hour' ? formatTime(v) : formatDate(v)
                      }
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#6B6B8A' }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: number) =>
                        v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`
                      }
                    />
                    <Tooltip content={<ChartTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="events"
                      stroke="#2DD4BF"
                      strokeWidth={1.5}
                      fill="url(#dashEventsGrad)"
                      dot={false}
                      name="Events"
                    />
                    <Area
                      type="monotone"
                      dataKey="sessions"
                      stroke="#A78BFA"
                      strokeWidth={1.5}
                      fill="url(#dashSessionsGrad)"
                      dot={false}
                      name="Sessions"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Bottom row */}
            <div className="grid grid-cols-1 md:grid-cols-[1fr_300px] gap-3">
              {/* Top pages */}
              <div className="bg-card border border-border rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                  <div className="text-xs font-medium text-foreground">Top Pages</div>
                  <div
                    className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-0 text-[10px] text-muted-foreground font-medium uppercase tracking-wider"
                    style={{ width: 280 }}
                  >
                    <span className="text-right">Sessions</span>
                    <span className="text-right">Clicks</span>
                    <span className="text-right">Click rate</span>
                    <span className="text-right">vs prev</span>
                  </div>
                </div>
                {topPages.isPending ? (
                  // page + sessions/clicks/click-rate/vs-prev; the real header row is
                  // already rendered above, so the skeleton omits its own.
                  <SkeletonTable rows={6} cols={5} header={false} />
                ) : topPages.error ? (
                  <div className="p-4">
                    <InlineError message={topPages.error.message} />
                  </div>
                ) : !topPages.data || topPages.data.length === 0 ? (
                  <EmptyState message="No page data yet." />
                ) : (
                  <div className="divide-y divide-border/50">
                    {topPages.data.map((row) => (
                      <div
                        key={row.page}
                        className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/20 transition-colors group"
                      >
                        <div className="flex-1 min-w-0">
                          <span className="font-mono text-[11px] text-foreground truncate block group-hover:text-primary transition-colors">
                            {row.page}
                          </span>
                        </div>
                        <div
                          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-0 text-[11px] font-mono shrink-0"
                          style={{ width: 280 }}
                        >
                          <span className="text-right text-muted-foreground">
                            {formatNumber(row.sessions)}
                          </span>
                          <span className="text-right text-muted-foreground">
                            {formatNumber(row.clicks)}
                          </span>
                          <span className="text-right text-foreground font-medium">
                            {row.rate}%
                          </span>
                          <span
                            className={cn(
                              'text-right font-medium',
                              row.trend > 0
                                ? 'text-teal-400'
                                : row.trend < 0
                                  ? 'text-red-400'
                                  : 'text-muted-foreground',
                            )}
                          >
                            {row.trend > 0 ? '+' : ''}
                            {row.trend}%
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Live event feed */}
              <div className="bg-card border border-border rounded-lg p-4 flex flex-col">
                <div className="mb-3">
                  <div className="text-xs font-medium text-foreground">Last 10 events</div>
                </div>

                {live.isPending ? (
                  <SkeletonList rows={8} className="flex-1" />
                ) : live.error ? (
                  <InlineError message={live.error.message} />
                ) : !live.data || live.data.length === 0 ? (
                  <EmptyState message="Waiting for events…" />
                ) : (
                  <div className="space-y-2 flex-1 overflow-auto">
                    {live.data.map((row) => (
                      <Link
                        key={row.uuid}
                        to={`/events/${row.uuid}`}
                        className="flex items-start gap-2 py-1.5 border-b border-border/50 last:border-0 -mx-2 px-2 rounded-sm hover:bg-muted/50 transition-colors"
                      >
                        <EventTypeBadge type={row.event} />
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-[11px] text-foreground truncate">
                            {row.current_url || '—'}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
                            {row.distinct_id} · {mockCountry(row.distinct_id || row.uuid)} ·{' '}
                            {formatRelative(row.timestamp)}
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Cold-load shell: mirrors the real page grid (4 KPI tiles, trend card, top
 * pages + live feed) so the dashboard doesn't assemble itself in pieces. */
function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <SkeletonStatRow count={4} />
      <div className="bg-card border border-border rounded-lg p-4">
        <SkeletonChart height={160} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_300px] gap-3">
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <SkeletonTable rows={6} cols={5} />
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <SkeletonList rows={8} />
        </div>
      </div>
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className={cn('flex h-[160px] items-center justify-center text-sm text-muted-foreground')}>
      {message}
    </div>
  )
}

function InlineError({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Failed to load</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
