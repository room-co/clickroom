import {
  AlertTriangle,
  ArrowLeft,
  Crown,
  FlaskConical,
  Info,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonCard } from '@/components/skeletons'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { trpc } from '@/lib/trpc'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'

// A variant needs to clear this probability-to-be-best threshold before it's
// declared a winner — mirrors WINNER_PROBABILITY_THRESHOLD in
// apps/api's experiments.stats.ts. Below this but still ahead of the pack,
// we show a "trending toward" note instead of a Winner badge.
const WINNER_PROBABILITY_THRESHOLD = 0.95
// Chance-to-win above this (but below the winner threshold) is worth calling
// out as "leading" rather than staying silent.
const LEADING_PROBABILITY_THRESHOLD = 0.6

/** Small info icon that reveals a plain-language explanation on hover/focus. */
function InfoTooltip({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex text-muted-foreground/60 hover:text-muted-foreground"
        >
          <Info className="h-3 w-3" />
          <span className="sr-only">More info</span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-56 text-center">{children}</TooltipContent>
    </Tooltip>
  )
}

type ExperimentStatus = 'draft' | 'running' | 'complete' | 'archived'

const statusVariant: Record<ExperimentStatus, 'default' | 'secondary' | 'outline' | 'destructive'> =
  {
    draft: 'outline',
    running: 'default',
    complete: 'secondary',
    archived: 'destructive',
  }

function StatusBadge({ status }: { status: ExperimentStatus }) {
  return (
    <Badge variant={statusVariant[status] ?? 'outline'} className="capitalize">
      {status}
    </Badge>
  )
}

// ── Metric shapes (mirrors apps/api's ExperimentMetricInput) ──────────────
type FunnelStepCondition = { key: string; operator: string; value?: unknown }
type ExperimentMetric =
  | {
      type: 'funnel'
      steps: { event: string; properties?: FunnelStepCondition[] }[]
      window: number
    }
  | { type: 'mean'; event: string; property: string }
  | { type: 'ratio'; numeratorEvent: string; denominatorEvent: string }
  | { type: 'retention'; returnEvent: string; days: number }

type VariantResult = {
  variant: string
  exposed: number
  metricValue: number
  credibleInterval: [number, number]
  probabilityToBeBest: number
  upliftVsControl: number
}

type MetricResultsOutput = {
  metric: ExperimentMetric
  results: VariantResult[]
  winner?: string
}

// Beta-Binomial models (funnel/retention) report a 0..1 conversion rate;
// Gamma-Poisson models (mean/ratio) report a raw per-exposed-user count/rate.
function isRateMetric(type: ExperimentMetric['type']): boolean {
  return type === 'funnel' || type === 'retention'
}

function formatMetricLabel(metric: ExperimentMetric): string {
  switch (metric.type) {
    case 'funnel':
      return `Funnel: ${metric.steps.map((s) => s.event).join(' → ')}`
    case 'mean':
      return `Mean: ${metric.event}.${metric.property}`
    case 'ratio':
      return `Ratio: ${metric.numeratorEvent} / ${metric.denominatorEvent}`
    case 'retention':
      return `Retention: ${metric.returnEvent} within ${metric.days}d`
  }
}

function formatMetricDescription(metric: ExperimentMetric): string {
  switch (metric.type) {
    case 'funnel':
      return 'Percentage of users who completed every step in this funnel.'
    case 'mean':
      return `Average ${metric.property} per user, based on ${metric.event} events.`
    case 'ratio':
      return `${metric.numeratorEvent} events divided by ${metric.denominatorEvent} events, per user.`
    case 'retention':
      return `Percentage of users who came back and did ${metric.returnEvent} within ${metric.days} days.`
  }
}

function formatMetricValue(type: ExperimentMetric['type'], value: number): string {
  return isRateMetric(type) ? `${(value * 100).toFixed(1)}%` : value.toFixed(2)
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatUplift(value: number): string {
  const pct = value * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

function hasEnoughData(output: MetricResultsOutput): boolean {
  return output.results.length > 0 && output.results.some((r) => r.exposed > 0)
}

/** Minimal horizontal credible-interval bar — no shadcn range primitive exists, built with Tailwind divs. */
function CredibleIntervalBar({
  lo,
  hi,
  value,
  max,
  isWinner,
}: {
  lo: number
  hi: number
  value: number
  max: number
  isWinner: boolean
}) {
  const scale = max > 0 ? max : 1
  const loPct = Math.min(100, Math.max(0, (lo / scale) * 100))
  const hiPct = Math.min(100, Math.max(0, (hi / scale) * 100))
  const valuePct = Math.min(100, Math.max(0, (value / scale) * 100))

  return (
    <div className="relative h-2 w-full rounded-full bg-muted/40">
      <div
        className={cn(
          'absolute top-0 h-full rounded-full',
          isWinner ? 'bg-primary' : 'bg-[var(--chart-2)]',
        )}
        style={{ left: `${loPct}%`, width: `${Math.max(1.5, hiPct - loPct)}%` }}
      />
      <div
        className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
        style={{ left: `${valuePct}%` }}
      />
    </div>
  )
}

function VariantCard({
  result,
  metricType,
  isControl,
  isWinner,
  hasWinner,
  sectionMax,
}: {
  result: VariantResult
  metricType: ExperimentMetric['type']
  isControl: boolean
  isWinner: boolean
  hasWinner: boolean
  sectionMax: number
}) {
  const uplift = result.upliftVsControl
  const upliftColor =
    isControl || uplift === 0
      ? 'text-muted-foreground'
      : uplift > 0
        ? 'text-green-400'
        : 'text-red-400'

  const isLeading =
    !hasWinner &&
    result.probabilityToBeBest >= LEADING_PROBABILITY_THRESHOLD &&
    result.probabilityToBeBest < WINNER_PROBABILITY_THRESHOLD

  return (
    <div
      className={cn(
        'relative flex flex-col gap-3 rounded-xl border p-4',
        isWinner ? 'border-primary/50 bg-primary/[0.04]' : 'border-border bg-card',
      )}
    >
      {isWinner && (
        <Badge className="absolute -top-2.5 right-3 gap-1 bg-primary text-primary-foreground">
          <Crown className="h-3 w-3" />
          Winner
        </Badge>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-medium text-foreground">{result.variant}</span>
          {isControl && (
            <Badge variant="outline" className="text-[9px]">
              Control
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Users className="h-3 w-3" />
          {result.exposed.toLocaleString()}
        </div>
      </div>

      <div>
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
          {isRateMetric(metricType) ? 'Conversion rate' : 'Metric value'}
        </div>
        <div className="text-2xl font-semibold tracking-tight text-foreground">
          {formatMetricValue(metricType, result.metricValue)}
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
          <span>
            Likely range: {formatMetricValue(metricType, result.credibleInterval[0])} –{' '}
            {formatMetricValue(metricType, result.credibleInterval[1])}
          </span>
          <InfoTooltip>
            We're 95% confident the true value for this variant falls in this range.
          </InfoTooltip>
        </div>
      </div>

      <CredibleIntervalBar
        lo={result.credibleInterval[0]}
        hi={result.credibleInterval[1]}
        value={result.metricValue}
        max={sectionMax}
        isWinner={isWinner}
      />

      <div className="flex items-center justify-between border-t border-border/60 pt-2.5">
        <div className="flex flex-col">
          <span className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-muted-foreground">
            Chance to win
            <InfoTooltip>
              The probability this variant is truly the best one, based on the data so far.
            </InfoTooltip>
          </span>
          <span className="text-xs font-medium text-foreground">
            {formatPercent(result.probabilityToBeBest)}
          </span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
            vs. control
          </span>
          <span className={cn('flex items-center gap-1 text-xs font-medium', upliftColor)}>
            {!isControl && uplift !== 0 ? (
              uplift > 0 ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )
            ) : null}
            {isControl ? '—' : formatUplift(uplift)}
          </span>
        </div>
      </div>

      {isLeading && (
        <div className="flex items-start gap-1.5 rounded-md bg-muted/40 px-2 py-1.5 text-[10px] text-muted-foreground">
          <TrendingUp className="mt-0.5 h-3 w-3 shrink-0 text-foreground/60" />
          <span>
            Trending toward this variant — needs {formatPercent(WINNER_PROBABILITY_THRESHOLD)}{' '}
            confidence to declare a winner.
          </span>
        </div>
      )}
    </div>
  )
}

function EmptyState({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: typeof FlaskConical
  title: string
  subtitle: string
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Icon className="mb-3 h-8 w-8 text-muted-foreground/30" />
      <div className="text-sm font-medium text-muted-foreground">{title}</div>
      <div className="mt-1 max-w-sm text-[11px] text-muted-foreground/60">{subtitle}</div>
    </div>
  )
}

function MetricSection({ title, output }: { title: string; output: MetricResultsOutput }) {
  if (!hasEnoughData(output)) {
    return (
      <section>
        <h2 className="mb-1 text-xs font-semibold text-foreground">{title}</h2>
        <p className="text-[11px] text-muted-foreground">{formatMetricLabel(output.metric)}</p>
        <p className="mb-3 text-[11px] text-muted-foreground/60">
          {formatMetricDescription(output.metric)}
        </p>
        <div className="rounded-xl border border-border bg-card">
          <EmptyState
            icon={AlertTriangle}
            title="Not enough data yet"
            subtitle="No exposed users have been recorded for this metric yet. Check back once traffic starts flowing through the experiment."
          />
        </div>
      </section>
    )
  }

  const sectionMax =
    Math.max(...output.results.flatMap((r) => [r.credibleInterval[1], r.metricValue]), 0) * 1.15
  const hasWinner = !!output.winner

  return (
    <section>
      <h2 className="mb-1 text-xs font-semibold text-foreground">{title}</h2>
      <p className="text-[11px] text-muted-foreground">{formatMetricLabel(output.metric)}</p>
      <p className="mb-3 text-[11px] text-muted-foreground/60">
        {formatMetricDescription(output.metric)}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {output.results.map((result, idx) => (
          <VariantCard
            key={result.variant}
            result={result}
            metricType={output.metric.type}
            isControl={idx === 0}
            isWinner={output.winner === result.variant}
            hasWinner={hasWinner}
            sectionMax={sectionMax}
          />
        ))}
      </div>
    </section>
  )
}

export function ExperimentResultsPage() {
  const { id } = useParams<{ id: string }>()
  const projectId = useProjectId()
  const enabled = !!projectId && !!id

  const [isLive, setIsLive] = useState(true)

  const experimentQuery = trpc.experiments.get.useQuery(
    { projectId: projectId as string, id: id as string },
    { enabled, refetchInterval: isLive ? 10_000 : false },
  )
  const status = experimentQuery.data?.status as ExperimentStatus | undefined
  const isRunningOrComplete = status === 'running' || status === 'complete'

  useEffect(() => {
    if (status && status !== 'running') setIsLive(false)
  }, [status])

  const resultsQuery = trpc.experiments.results.useQuery(
    { projectId: projectId as string, id: id as string },
    {
      enabled: enabled && isRunningOrComplete,
      refetchInterval: isLive ? 10_000 : false,
    },
  )

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No project selected.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Link
        to="/experiments"
        className="flex items-center gap-1.5 px-4 md:px-6 pt-4 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to Experiments
      </Link>
      <PageHeader title={experimentQuery.data?.name ?? 'Experiment results'}>
        {status && <StatusBadge status={status} />}
        {status === 'running' && isLive && (
          <Badge variant="outline" className="gap-1.5 text-emerald-500 border-emerald-500/40">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            Live
          </Badge>
        )}
      </PageHeader>

      <div className="flex-1 overflow-auto p-4 md:p-6">
        {experimentQuery.isPending ? (
          <ExperimentResultsSkeleton />
        ) : experimentQuery.error ? (
          <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <div className="text-sm font-medium text-red-400">Failed to load experiment</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {experimentQuery.error.message}
              </div>
            </div>
          </div>
        ) : !isRunningOrComplete ? (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState
              icon={FlaskConical}
              title="Not launched yet"
              subtitle="Results appear once this experiment is launched and starts collecting exposures. Launch it from the experiment editor."
            />
          </div>
        ) : resultsQuery.isPending ? (
          <ExperimentResultsSkeleton />
        ) : resultsQuery.error ? (
          <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <div className="text-sm font-medium text-red-400">Failed to load results</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {resultsQuery.error.message}
              </div>
            </div>
          </div>
        ) : !resultsQuery.data?.primary ? (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState
              icon={FlaskConical}
              title="Not launched yet"
              subtitle="This experiment hasn't been launched, so there's nothing to measure yet."
            />
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            <MetricSection title="Primary metric" output={resultsQuery.data.primary} />
            {resultsQuery.data.secondary.map((output, idx) => (
              <MetricSection
                // biome-ignore lint/suspicious/noArrayIndexKey: metrics have no stable id
                key={idx}
                title="Secondary metric"
                output={output}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Page shell for the initial no-data state. The page assembles two independent
 * queries (`experiments.get` + `experiments.results`), so both cold-load
 * branches render this one composition instead of popping in as separate
 * skeleton islands. Mirrors the real grid: a metric section heading plus a
 * 2-up grid of `VariantCard`s, twice (primary + one secondary).
 */
function ExperimentResultsSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      {Array.from({ length: 2 }).map((_, section) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
        <section key={section} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-3 w-64" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Array.from({ length: 2 }).map((_, card) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
              <SkeletonCard key={card} className="rounded-xl" lines={4} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
