// Renders experiment_results tool output (primary + secondary metric
// results). Condensed table variant of ExperimentResultsPage.tsx's
// VariantCard grid — same stats (uplift, chance-to-win, winner threshold),
// laid out as a compact table so it fits inline in a chat message.
import { Crown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

// Mirrors apps/api's experiments.stats.ts threshold (see ExperimentResultsPage.tsx).
const WINNER_PROBABILITY_THRESHOLD = 0.95

type FunnelStepCondition = { key: string; operator: string; value?: unknown }
export type ExperimentMetric =
  | {
      type: 'funnel'
      steps: { event: string; properties?: FunnelStepCondition[] }[]
      window: number
    }
  | { type: 'mean'; event: string; property: string }
  | { type: 'ratio'; numeratorEvent: string; denominatorEvent: string }
  | { type: 'retention'; returnEvent: string; days: number }

export type ExperimentVariantResult = {
  variant: string
  exposed: number
  metricValue: number
  credibleInterval: [number, number]
  probabilityToBeBest: number
  upliftVsControl: number
}

export type ExperimentMetricResult = {
  metric: ExperimentMetric
  results: ExperimentVariantResult[]
  winner?: string
}

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

function MetricTable({ title, output }: { title: string; output: ExperimentMetricResult }) {
  const hasData = output.results.length > 0 && output.results.some((r) => r.exposed > 0)

  return (
    <div className="w-full min-w-0">
      <div className="mb-1 text-xs font-medium text-foreground">{title}</div>
      <div className="mb-2 text-[11px] text-muted-foreground">
        {formatMetricLabel(output.metric)}
      </div>
      {!hasData ? (
        <div className="rounded-lg border border-border bg-card px-4 py-6 text-center text-[11px] text-muted-foreground">
          Not enough data yet: no exposed users recorded.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Variant
                </TableHead>
                <TableHead className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                  Exposed
                </TableHead>
                <TableHead className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                  Value
                </TableHead>
                <TableHead className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                  vs. control
                </TableHead>
                <TableHead className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                  Chance to win
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {output.results.map((result, idx) => {
                const isControl = idx === 0
                const isWinner = output.winner === result.variant
                const uplift = result.upliftVsControl
                const upliftColor =
                  isControl || uplift === 0
                    ? 'text-muted-foreground'
                    : uplift > 0
                      ? 'text-green-400'
                      : 'text-red-400'
                return (
                  <TableRow key={result.variant}>
                    <TableCell className="font-mono text-xs">
                      <div className="flex items-center gap-1.5">
                        {result.variant}
                        {isControl && (
                          <Badge variant="outline" className="text-[9px]">
                            Control
                          </Badge>
                        )}
                        {isWinner && (
                          <Badge className="gap-1 bg-primary text-[9px] text-primary-foreground">
                            <Crown className="h-2.5 w-2.5" />
                            Winner
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {result.exposed.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatMetricValue(output.metric.type, result.metricValue)}
                    </TableCell>
                    <TableCell className={cn('text-right font-mono text-xs', upliftColor)}>
                      {isControl ? '—' : formatUplift(uplift)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatPercent(result.probabilityToBeBest)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {output.winner && (
        <div className="mt-1.5 text-[10px] text-muted-foreground">
          {formatPercent(WINNER_PROBABILITY_THRESHOLD)}+ confidence reached, {output.winner}{' '}
          declared winner.
        </div>
      )}
    </div>
  )
}

export function ExperimentResultsWidget({
  primary,
  secondary,
}: {
  primary: ExperimentMetricResult
  secondary: ExperimentMetricResult[]
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <MetricTable title="Primary metric" output={primary} />
      {secondary.map((output, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: metrics have no stable id
        <MetricTable key={idx} title="Secondary metric" output={output} />
      ))}
    </div>
  )
}
