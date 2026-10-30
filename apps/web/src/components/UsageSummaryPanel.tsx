import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { SkeletonCard } from '@/components/skeletons'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate, formatNumber } from '@/lib/format'
import { getDeployment } from '@/lib/runtime-config'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { cn } from '@/lib/utils'

// Runtime shape returned by `usage.summary` (apps/api/src/trpc/routers/usage.router.ts).
interface UsageMetric {
  used: number
  limit: number
  percent: number
  overLimit: boolean
  /** Only present on monthly metrics — `max(0, used - limit)`. */
  overageUnits?: number
}

interface UsageSummary {
  planKey: string | null
  seats: UsageMetric
  flags: UsageMetric
  eventsThisMonth: UsageMetric
  flagCallsThisMonth: UsageMetric
  monthlyResetsAt: string
  overagePolicy: 'block' | 'allow'
  /** Whether the org's plan entitles it to switch `overagePolicy` to 'allow'. Server-enforced in `usage.setOveragePolicy`. */
  canSelfEnableOverage: boolean
}

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  enterprise: 'Enterprise',
  unlimited: 'Unlimited',
}

export function planLabel(planKey: string | null): string {
  if (!planKey) return 'No plan'
  return PLAN_LABEL[planKey] ?? planKey
}

function UsageMetricCard({
  label,
  metric,
  resetsAt,
}: {
  label: string
  metric: UsageMetric
  /** Present for monthly metrics only — lifetime metrics (seats/flags) never reset. */
  resetsAt?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col bg-card border rounded-lg p-4',
        metric.overLimit ? 'border-red-500/30' : 'border-border',
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
        {metric.overLimit && (
          <span className="flex items-center gap-1 text-[10px] font-medium text-red-400">
            <AlertTriangle className="w-3 h-3" />
            Over limit
          </span>
        )}
      </div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-mono text-base text-foreground">
          {formatNumber(metric.used)}{' '}
          <span className="text-xs text-muted-foreground">/ {formatNumber(metric.limit)}</span>
        </div>
        <span
          className={cn(
            'font-mono text-xs',
            metric.overLimit ? 'text-red-400' : 'text-muted-foreground',
          )}
        >
          {metric.percent}%
        </span>
      </div>
      <Progress
        value={Math.min(100, metric.percent)}
        className={cn('h-1.5', metric.overLimit && 'bg-red-500/15')}
        indicatorClassName={metric.overLimit ? 'bg-red-500' : undefined}
      />
      <div className="mt-auto flex items-center justify-between pt-2 text-[10px] text-muted-foreground">
        <span>{resetsAt ? `Resets ${formatDate(resetsAt)}` : 'Lifetime. Does not reset.'}</span>
        {metric.overLimit && !!metric.overageUnits && (
          <span className="font-mono font-medium text-red-400">
            +{formatNumber(metric.overageUnits)} over
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Org-scoped allow-vs-block toggle for what happens once a monthly
 * metered metric (events, flag-calls) goes over its limit. Only rendered
 * when the parent opts in via `showPolicyControl` (billing tab) — display-only
 * consumers (e.g. DataManagementPage) never show this.
 */
function OveragePolicyControl({
  policy,
  canSelfEnable,
}: {
  policy: 'block' | 'allow'
  /** Whether the org's plan entitles it to 'allow' at all. Server-enforced in `usage.setOveragePolicy`; this only keeps the UI from offering a choice it would reject. */
  canSelfEnable: boolean
}) {
  const { can } = useAuth()
  const canUpdatePolicy = can('org:update')
  const utils = trpc.useUtils()
  const setPolicy = trpc.usage.setOveragePolicy.useMutation()

  async function handleChange(next: string) {
    if (next !== 'block' && next !== 'allow') return
    if (next === policy) return
    try {
      await setPolicy.mutateAsync({ policy: next })
      await utils.usage.summary.invalidate()
      toast.success('Overage policy updated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update overage policy')
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-[10px] uppercase tracking-wider text-muted-foreground">
        When you go over a monthly limit
      </div>
      <RadioGroup
        value={policy}
        onValueChange={handleChange}
        disabled={setPolicy.isPending || !canUpdatePolicy}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <label
          htmlFor="overage-policy-allow"
          className={cn(
            'flex items-start gap-2 rounded-md border p-3 text-xs transition-colors',
            canSelfEnable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
            policy === 'allow' ? 'border-primary/50 bg-primary/5' : 'border-border',
          )}
        >
          <RadioGroupItem
            value="allow"
            id="overage-policy-allow"
            disabled={!canSelfEnable}
            className="mt-0.5"
          />
          <span className="text-foreground">
            <span className="font-medium">Allow overage</span>
            <span className="block text-[11px] text-muted-foreground">
              Keep accepting, bill the difference.
            </span>
          </span>
        </label>
        <label
          htmlFor="overage-policy-block"
          className={cn(
            'flex cursor-pointer items-start gap-2 rounded-md border p-3 text-xs transition-colors',
            policy === 'block' ? 'border-primary/50 bg-primary/5' : 'border-border',
          )}
        >
          <RadioGroupItem value="block" id="overage-policy-block" className="mt-0.5" />
          <span className="text-foreground">
            <span className="font-medium">Discard</span>
            <span className="block text-[11px] text-muted-foreground">
              Block over-limit traffic.
            </span>
          </span>
        </label>
      </RadioGroup>
      {!canUpdatePolicy && (
        <p className="mt-3 text-[10px] text-muted-foreground">
          Only org admins can change this setting.
        </p>
      )}
      {canUpdatePolicy && !canSelfEnable && (
        <p className="mt-3 text-[10px] text-muted-foreground">
          Overage is not included in your plan — over-limit traffic is discarded. Upgrade to keep
          accepting it.
        </p>
      )}
    </div>
  )
}

/** Self-host: a plain counter, no plan, limit, percentage or overage. */
function UsageCountCard({
  label,
  used,
  resetsAt,
}: {
  label: string
  used: number
  resetsAt?: string
}) {
  return (
    <div className="flex flex-col bg-card border border-border rounded-lg p-4">
      <span className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="font-mono text-base text-foreground">{formatNumber(used)}</div>
      <div className="pt-2 text-[10px] text-muted-foreground">
        {resetsAt ? `This month. Resets ${formatDate(resetsAt)}` : 'Current total'}
      </div>
    </div>
  )
}

/**
 * Shared usage/plan panel backed by the real `usage.summary` tRPC query —
 * no plan-purchase/upgrade flow, display only.
 */
export function UsageSummaryPanel({ showPolicyControl = false }: { showPolicyControl?: boolean }) {
  const usageQuery = trpc.usage.summary.useQuery()

  if (usageQuery.isPending) {
    return (
      <div className="w-full space-y-4">
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-6 w-28" />
          </div>
          <Skeleton className="h-6 w-14 rounded-full" />
        </div>
        {showPolicyControl && <SkeletonCard lines={2} />}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
        </div>
      </div>
    )
  }

  if (usageQuery.isError || !usageQuery.data) {
    return (
      <div className="bg-card border border-destructive/25 rounded-lg p-5 text-[11px] text-destructive">
        Couldn&apos;t load usage data.
      </div>
    )
  }

  const usage = usageQuery.data as UsageSummary

  if (getDeployment() === 'self_host') {
    return (
      <div className="w-full grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <UsageCountCard label="Team seats" used={usage.seats.used} />
        <UsageCountCard label="Feature flags" used={usage.flags.used} />
        <UsageCountCard
          label="Events / mo"
          used={usage.eventsThisMonth.used}
          resetsAt={usage.monthlyResetsAt}
        />
        <UsageCountCard
          label="Flag calls / mo"
          used={usage.flagCallsThisMonth.used}
          resetsAt={usage.monthlyResetsAt}
        />
      </div>
    )
  }

  return (
    <div className="w-full space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            Current Plan
          </div>
          <div className="text-xl font-semibold text-foreground font-mono">
            {planLabel(usage.planKey)}
          </div>
        </div>
        <Badge
          variant="outline"
          className="rounded-full border-primary/25 bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary"
        >
          Active
        </Badge>
      </div>
      {showPolicyControl && (
        <OveragePolicyControl
          policy={usage.overagePolicy}
          canSelfEnable={usage.canSelfEnableOverage}
        />
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <UsageMetricCard label="Team seats" metric={usage.seats} />
        <UsageMetricCard label="Feature flags" metric={usage.flags} />
        <UsageMetricCard
          label="Events / mo"
          metric={usage.eventsThisMonth}
          resetsAt={usage.monthlyResetsAt}
        />
        <UsageMetricCard
          label="Flag calls / mo"
          metric={usage.flagCallsThisMonth}
          resetsAt={usage.monthlyResetsAt}
        />
      </div>
    </div>
  )
}
