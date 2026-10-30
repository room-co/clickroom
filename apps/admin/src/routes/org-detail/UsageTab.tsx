import { SkeletonChart, SkeletonStatRow } from '@/components/skeletons'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDate, formatNumber, formatPercent } from '@/lib/format'
import { trpc } from '@/lib/trpc'

/** Usage tab: this org's per-org volume/trend via `admin.usage.perOrg`. */
export function UsageTab({ orgId }: { orgId: string }) {
  const query = trpc.admin.usage.perOrg.useQuery({ orgId })

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <SkeletonStatRow count={2} />
        <SkeletonChart />
      </div>
    )
  }
  if (query.isError) {
    return <p className="p-4 text-sm text-destructive">Failed to load usage.</p>
  }

  const usage = query.data
  const maxDaily = Math.max(
    1,
    ...usage.trend.map((point) => Math.max(point.events, point.flagCalls)),
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <UsageMetricCard title="Events this month" metric={usage.eventsThisMonth} />
        <UsageMetricCard title="Flag calls this month" metric={usage.flagCallsThisMonth} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily trend</CardTitle>
        </CardHeader>
        <CardContent>
          {usage.trend.length === 0 ? (
            <p className="text-sm text-muted-foreground">No trend data for this month yet.</p>
          ) : (
            <div className="flex h-48 items-end gap-1 overflow-x-auto border-b border-border pb-2">
              {usage.trend.map((point) => (
                <div
                  key={point.date}
                  className="flex min-w-[6px] flex-1 flex-col items-center justify-end gap-0.5"
                  title={`${formatDate(point.date)}: ${formatNumber(point.events)} events, ${formatNumber(point.flagCalls)} flag calls`}
                >
                  <div
                    className="w-full rounded-t-sm bg-primary/70"
                    style={{ height: `${Math.max(2, (point.events / maxDaily) * 100)}%` }}
                  />
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Resets {formatDate(usage.monthlyResetsAt)}. Overage policy:{' '}
            <span className="capitalize">{usage.overagePolicy}</span>
            {usage.canSelfEnableOverage ? ' (org can self-enable overage)' : ''}.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

interface Metric {
  used: number
  limit: number
  percent: number
  overLimit: boolean
  overageUnits: number
}

function UsageMetricCard({ title, metric }: { title: string; metric: Metric }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          {title}
          {metric.overLimit ? <Badge variant="destructive">Over quota</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="font-mono text-2xl text-foreground">
          {formatNumber(metric.used)}
          <span className="text-base text-muted-foreground"> / {formatNumber(metric.limit)}</span>
        </p>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={metric.overLimit ? 'h-full bg-destructive' : 'h-full bg-primary'}
            style={{ width: `${Math.min(100, metric.percent)}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {formatPercent(metric.percent)} of limit
          {metric.overageUnits > 0 ? ` · ${formatNumber(metric.overageUnits)} over` : ''}
        </p>
      </CardContent>
    </Card>
  )
}
