import { AlertTriangle } from 'lucide-react'
import { Link } from 'react-router'
import { SkeletonTable } from '@/components/skeletons'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatNumber, formatPercent } from '@/lib/format'
import { trpc } from '@/lib/trpc'

/**
 * `/usage`. Cross-org usage/overage rollup via `admin.usage.topByVolume` — sorted by
 * this month's event volume descending, same as the procedure's own contract. Explicitly not a
 * billing/invoice screen: "usage" here is event/flag-call volume against
 * `Plan` limits, not money.
 */
export function UsagePage() {
  const query = trpc.admin.usage.topByVolume.useQuery({ limit: 50 })

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Usage</h1>
        <p className="text-sm text-muted-foreground">
          Cross-org event/flag-call volume this month against effective plan limits.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {query.isPending ? (
            <SkeletonTable rows={10} cols={6} />
          ) : query.isError ? (
            <p className="p-6 text-sm text-destructive">Failed to load usage.</p>
          ) : query.data.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No orgs with usage data.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Org</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Events</TableHead>
                    <TableHead>Flag calls</TableHead>
                    <TableHead>Overage policy</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.map((usage) => (
                    <TableRow key={usage.orgId}>
                      <TableCell>
                        <Link to={`/orgs/${usage.orgId}`} className="hover:underline">
                          <div className="font-medium text-foreground">{usage.orgName}</div>
                          <div className="text-xs text-muted-foreground">{usage.orgSlug}</div>
                        </Link>
                      </TableCell>
                      <TableCell>{usage.planName ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {formatNumber(usage.eventsThisMonth.used)} /{' '}
                        {formatNumber(usage.eventsThisMonth.limit)}
                        <span className="ml-1 text-muted-foreground">
                          ({formatPercent(usage.eventsThisMonth.percent)})
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {formatNumber(usage.flagCallsThisMonth.used)} /{' '}
                        {formatNumber(usage.flagCallsThisMonth.limit)}
                        <span className="ml-1 text-muted-foreground">
                          ({formatPercent(usage.flagCallsThisMonth.percent)})
                        </span>
                      </TableCell>
                      <TableCell className="capitalize">{usage.overagePolicy}</TableCell>
                      <TableCell>
                        {usage.eventsThisMonth.overLimit || usage.flagCallsThisMonth.overLimit ? (
                          <Badge variant="destructive" className="gap-1">
                            <AlertTriangle className="size-3" />
                            Over quota
                          </Badge>
                        ) : (
                          <Badge variant="outline">OK</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
