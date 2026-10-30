import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from 'lucide-react'
import type { ComponentType } from 'react'
import { Link } from 'react-router'
import { SkeletonCard } from '@/components/skeletons'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatNumber } from '@/lib/format'
import { trpc } from '@/lib/trpc'

/**
 * `/health`. Read-only dashboard over `admin.health.summary` — every field there
 * degrades to a status rather than throwing (see the router's own doc comment), so this page
 * renders each signal independently instead of failing the whole page on one dead dependency.
 */
export function HealthPage() {
  const query = trpc.admin.health.summary.useQuery()

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Health</h1>
        <p className="text-sm text-muted-foreground">
          Read-only operator view over state the platform already tracks.
        </p>
      </div>

      {query.isPending ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : query.isError ? (
        <p className="text-sm text-destructive">Failed to load health summary.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatusTile
              label="ClickHouse"
              status={query.data.clickhouse.reachable ? 'ok' : 'bad'}
              detail={
                query.data.clickhouse.reachable
                  ? `${query.data.clickhouse.latencyMs}ms`
                  : (query.data.clickhouse.error ?? 'unreachable')
              }
            />
            <StatusTile
              label="Ingest backlog"
              status="unknown"
              detail={query.data.ingestBacklog.note}
            />
            <StatusTile label="NATS" status="unknown" detail={query.data.nats.note} />
            <StatusTile
              label="Failed webhook deliveries"
              status={query.data.failedWebhookDeliveries > 0 ? 'bad' : 'ok'}
              detail={formatNumber(query.data.failedWebhookDeliveries)}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="size-4 text-destructive" />
                Orgs over quota ({query.data.orgsOverQuota.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {query.data.orgsOverQuota.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground">No orgs currently over quota.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Org</TableHead>
                        <TableHead>Metric</TableHead>
                        <TableHead>Used</TableHead>
                        <TableHead>Limit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {query.data.orgsOverQuota.map((breach) => (
                        <TableRow key={`${breach.orgId}-${breach.metric}`}>
                          <TableCell>
                            <Link to={`/orgs/${breach.orgId}`} className="hover:underline">
                              {breach.orgName}
                            </Link>
                          </TableCell>
                          <TableCell className="capitalize">{breach.metric}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {formatNumber(breach.used)}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {formatNumber(breach.limit)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Applied ClickHouse migrations</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {query.data.appliedMigrations === null ? (
                <p className="p-6 text-sm text-destructive">
                  Could not read the migrations table (ClickHouse unreachable?).
                </p>
              ) : query.data.appliedMigrations.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground">No migrations recorded.</p>
              ) : (
                <div className="max-h-80 overflow-x-auto overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Applied at</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {query.data.appliedMigrations.map((migration) => (
                        <TableRow key={migration.name}>
                          <TableCell className="font-mono text-xs">{migration.name}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {migration.appliedAt}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

type Status = 'ok' | 'bad' | 'unknown'

const STATUS_ICON: Record<Status, ComponentType<{ className?: string }>> = {
  ok: CheckCircle2,
  bad: XCircle,
  unknown: HelpCircle,
}

function StatusTile({ label, status, detail }: { label: string; status: Status; detail: string }) {
  const Icon = STATUS_ICON[status]
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </span>
          <Icon
            className={
              status === 'ok'
                ? 'size-4 text-primary'
                : status === 'bad'
                  ? 'size-4 text-destructive'
                  : 'size-4 text-muted-foreground'
            }
          />
        </div>
        <Badge
          variant={status === 'bad' ? 'destructive' : status === 'ok' ? 'outline' : 'secondary'}
          className="w-fit"
        >
          {status === 'unknown' ? 'Unknown' : status === 'ok' ? 'Healthy' : 'Unhealthy'}
        </Badge>
        <p className="truncate text-xs text-muted-foreground" title={detail}>
          {detail}
        </p>
      </CardContent>
    </Card>
  )
}
