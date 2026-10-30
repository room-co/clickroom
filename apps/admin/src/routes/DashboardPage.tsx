import { AlertTriangle, Building2, CheckCircle2, Database, Webhook } from 'lucide-react'
import type { ComponentType } from 'react'
import { Link } from 'react-router'
import { SkeletonStatRow, SkeletonTable } from '@/components/skeletons'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatNumber } from '@/lib/format'
import { trpc } from '@/lib/trpc'

/**
 * `/dashboard`. Needs-attention queue FIRST, then a KPI strip.
 *
 * Backend gap: there is no admin procedure that lists locked `AdminUser` accounts (only
 * `admin-auth.router.ts`'s `login`/`refresh` read `loginLockedAt` for the signed-in admin
 * themselves) — per own instruction, the needs-attention queue falls back to
 * `admin.health.summary`'s `orgsOverQuota` and `failedWebhookDeliveries` only.
 *
 * The KPI strip's "orgs" count is a page of `admin.orgs.list` (max 200, the procedure's own
 * cap) rather than a true total — there is no count-only admin procedure either. A trailing
 * "+" on the tile signals when the true count exceeds what was fetched.
 */
export function DashboardPage() {
  const health = trpc.admin.health.summary.useQuery()
  const orgsPage = trpc.admin.orgs.list.useQuery({ limit: 200 })

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Needs-attention queue, then a cross-tenant snapshot.
        </p>
      </div>

      <NeedsAttentionQueue
        isPending={health.isPending}
        isError={health.isError}
        orgsOverQuota={health.data?.orgsOverQuota}
        failedWebhookDeliveries={health.data?.failedWebhookDeliveries}
      />

      <KpiStrip
        healthPending={health.isPending}
        health={health.data}
        orgsPending={orgsPage.isPending}
        orgCount={orgsPage.data?.orgs.length}
        orgCountHasMore={Boolean(orgsPage.data?.nextCursor)}
      />
    </div>
  )
}

interface NeedsAttentionQueueProps {
  isPending: boolean
  isError: boolean
  orgsOverQuota:
    | {
        orgId: string
        orgName: string
        metric: 'events' | 'flagCalls'
        used: number
        limit: number
      }[]
    | undefined
  failedWebhookDeliveries: number | undefined
}

function NeedsAttentionQueue({
  isPending,
  isError,
  orgsOverQuota,
  failedWebhookDeliveries,
}: NeedsAttentionQueueProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="size-4 text-destructive" />
          Needs attention
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <SkeletonTable rows={3} cols={2} header={false} className="p-0" />
        ) : isError ? (
          <p className="text-sm text-destructive">Failed to load health summary.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {Boolean(failedWebhookDeliveries) && (
              <Link
                to="/health"
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm hover:bg-secondary/70"
              >
                <span className="flex items-center gap-2">
                  <Webhook className="size-4 text-destructive" />
                  Failing support webhook deliveries
                </span>
                <Badge variant="destructive">{failedWebhookDeliveries}</Badge>
              </Link>
            )}
            {orgsOverQuota?.map((breach) => (
              <Link
                key={`${breach.orgId}-${breach.metric}`}
                to={`/orgs/${breach.orgId}`}
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm hover:bg-secondary/70"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Building2 className="size-4 shrink-0 text-destructive" />
                  <span className="truncate">{breach.orgName}</span>
                  <span className="shrink-0 text-muted-foreground">
                    over {breach.metric === 'events' ? 'event' : 'flag-call'} quota
                  </span>
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {formatNumber(breach.used)} / {formatNumber(breach.limit)}
                </span>
              </Link>
            ))}
            {!failedWebhookDeliveries && !orgsOverQuota?.length ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 text-primary" />
                Nothing needs attention right now.
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

interface KpiStripProps {
  healthPending: boolean
  health:
    | {
        clickhouse: { reachable: boolean }
        orgsOverQuota: unknown[]
        failedWebhookDeliveries: number
      }
    | undefined
  orgsPending: boolean
  orgCount: number | undefined
  orgCountHasMore: boolean
}

function KpiStrip({
  healthPending,
  health,
  orgsPending,
  orgCount,
  orgCountHasMore,
}: KpiStripProps) {
  if (healthPending || orgsPending) {
    return <SkeletonStatRow count={4} />
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiTile
        icon={Building2}
        label="Orgs"
        value={
          orgCount === undefined ? '—' : `${formatNumber(orgCount)}${orgCountHasMore ? '+' : ''}`
        }
      />
      <KpiTile
        icon={AlertTriangle}
        label="Orgs over quota"
        value={health ? formatNumber(health.orgsOverQuota.length) : '—'}
        tone={health && health.orgsOverQuota.length > 0 ? 'destructive' : undefined}
      />
      <KpiTile
        icon={Webhook}
        label="Failed webhook deliveries"
        value={health ? formatNumber(health.failedWebhookDeliveries) : '—'}
        tone={health && health.failedWebhookDeliveries > 0 ? 'destructive' : undefined}
      />
      <KpiTile
        icon={Database}
        label="ClickHouse"
        value={health ? (health.clickhouse.reachable ? 'Reachable' : 'Unreachable') : '—'}
        tone={health && !health.clickhouse.reachable ? 'destructive' : undefined}
      />
    </div>
  )
}

function KpiTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
  tone?: 'destructive'
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </span>
          <div className="flex size-6 items-center justify-center rounded bg-primary/10">
            <Icon className="size-3.5 text-primary" />
          </div>
        </div>
        <span
          className={
            tone === 'destructive'
              ? 'text-2xl font-semibold text-destructive'
              : 'text-2xl font-semibold text-foreground'
          }
        >
          {value}
        </span>
      </CardContent>
    </Card>
  )
}
