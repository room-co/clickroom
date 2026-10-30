import { keepPreviousData } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  MessageSquareText,
  Percent,
  Users,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { DateRangeControl } from '@/components/DateRangeControl'
import { PageHeader } from '@/components/PageHeader'
import { StatCard } from '@/components/StatCard'
import { SkeletonChart, SkeletonStatRow } from '@/components/skeletons'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useUrlDateRange } from '@/hooks/useUrlDateRange'
import { trpc } from '@/lib/trpc'
import { useProjectId } from '@/lib/use-project'
import { OpenQuestionBreakdown } from './OpenResponses'
import {
  fromApiDefinition,
  STATUS_BADGE,
  type SurveyQuestionUI,
  type SurveyRow,
  type SurveyStatus,
  scoreQuestion,
} from './types'

function formatScore(scoreType: 'csat' | 'ces' | 'nps', score: number): string {
  if (Number.isNaN(score)) return '—'
  // CSAT score is a top-box fraction (0..1); CES is a raw average; NPS is -100..100.
  if (scoreType === 'csat') return `${(score * 100).toFixed(0)}%`
  if (scoreType === 'ces') return score.toFixed(2)
  return score.toFixed(0)
}

export function SurveyResultsPage() {
  const { id } = useParams<{ id: string }>()
  const projectId = useProjectId()
  const enabled = !!projectId && !!id

  const { selection, setSelection, customRange, setCustomRange, range, interval } = useUrlDateRange(
    {
      defaultSelection: '30d',
      presetOptions: ['7d', '14d', '30d'],
    },
  )

  const surveyQuery = trpc.surveys.get.useQuery(
    { projectId: projectId as string, id: id as string },
    { enabled },
  )
  const survey = surveyQuery.data as unknown as SurveyRow | undefined
  const definition = useMemo(() => (survey ? fromApiDefinition(survey.definition) : null), [survey])
  const scoreCfg = useMemo(() => (definition ? scoreQuestion(definition) : null), [definition])

  const commonInput = { projectId: projectId as string, surveyId: id as string, range }
  const queryOpts = { enabled, placeholderData: keepPreviousData }

  const responseRateQuery = trpc.surveys.results.responseRate.useQuery(commonInput, queryOpts)
  const scoreQuery = trpc.surveys.results.score.useQuery(
    scoreCfg
      ? { ...commonInput, questionId: scoreCfg.questionId, scoreType: scoreCfg.scoreType }
      : { ...commonInput, questionId: '', scoreType: 'csat' as const },
    { enabled: enabled && !!scoreCfg, placeholderData: keepPreviousData },
  )
  const trendQuery = trpc.surveys.results.trend.useQuery({ ...commonInput, interval }, queryOpts)

  const scoreRaw = scoreQuery.data as unknown as Record<string, unknown> | undefined
  const scoreValue = scoreRaw ? Number(scoreRaw.score) : undefined

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No project selected.
      </div>
    )
  }

  const status = survey?.status as SurveyStatus | undefined

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Link
        to="/surveys"
        className="flex items-center gap-1.5 px-4 pt-4 text-xs text-muted-foreground hover:text-foreground md:px-6"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Surveys
      </Link>
      <PageHeader title={survey?.name ?? 'Survey results'}>
        {status && (
          <Badge variant={STATUS_BADGE[status]} className="capitalize">
            {status}
          </Badge>
        )}
        <DateRangeControl
          selection={selection}
          onSelectionChange={setSelection}
          customRange={customRange}
          onCustomRangeChange={setCustomRange}
          presetOptions={['7d', '14d', '30d']}
        />
        <Link
          to={`/surveys/${id}/edit`}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Edit
        </Link>
      </PageHeader>

      <div className="flex-1 overflow-auto p-4 md:p-6">
        {surveyQuery.isPending ? (
          <div className="space-y-6">
            <SkeletonStatRow count={4} />
            <SkeletonChart height={220} />
          </div>
        ) : surveyQuery.error ? (
          <ErrorBanner message={surveyQuery.error.message} />
        ) : (
          <div className="space-y-8">
            {/* Score / rate stat row */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                icon={Percent}
                label="Response rate"
                value={`${((responseRateQuery.data?.rate ?? 0) * 100).toFixed(1)}%`}
                loading={responseRateQuery.isPending}
              />
              <StatCard
                icon={Users}
                label="Shown"
                value={(responseRateQuery.data?.shown ?? 0).toLocaleString()}
                loading={responseRateQuery.isPending}
              />
              <StatCard
                icon={MessageSquareText}
                label="Responses"
                value={(responseRateQuery.data?.responded ?? 0).toLocaleString()}
                loading={responseRateQuery.isPending}
              />
              <StatCard
                icon={BarChart3}
                label={scoreCfg ? `${scoreCfg.scoreType.toUpperCase()} score` : 'Score'}
                value={
                  !scoreCfg || scoreValue === undefined
                    ? '—'
                    : formatScore(scoreCfg.scoreType, scoreValue)
                }
                loading={!!scoreCfg && scoreQuery.isPending}
              />
            </div>

            {/* Trend */}
            <section>
              <h2 className="mb-3 text-xs font-semibold text-foreground">Shown vs. responded</h2>
              {trendQuery.isPending ? (
                <SkeletonChart height={200} />
              ) : trendQuery.error ? (
                <ErrorBanner message={trendQuery.error.message} />
              ) : (
                <TrendChart data={trendQuery.data ?? []} />
              )}
            </section>

            {/* Per-question breakdown */}
            <section>
              <h2 className="mb-3 text-xs font-semibold text-foreground">Question breakdown</h2>
              <div className="space-y-4">
                {definition?.questions.map((q, i) =>
                  q.type === 'open' ? (
                    <OpenQuestionBreakdown
                      key={q.id}
                      projectId={projectId}
                      surveyId={id as string}
                      range={range}
                      question={q}
                      index={i}
                      questions={definition.questions}
                    />
                  ) : (
                    <QuestionBreakdown
                      key={q.id}
                      projectId={projectId}
                      surveyId={id as string}
                      range={range}
                      question={q}
                      index={i}
                    />
                  ),
                )}
              </div>
            </section>

            {/* Segment breakdown */}
            <SegmentBreakdownSection projectId={projectId} surveyId={id as string} range={range} />
          </div>
        )}
      </div>
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
      <div>
        <div className="text-sm font-medium text-red-400">Failed to load</div>
        <div className="mt-1 text-[11px] text-muted-foreground">{message}</div>
      </div>
    </div>
  )
}

// ── Trend chart (grouped bars, no external lib) ───────────────────────────────

function TrendChart({ data }: { data: { bucket: string; shown: number; sent: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.shown))
  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card py-12 text-center text-[11px] text-muted-foreground">
        No survey activity in this range yet.
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-4 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-muted-foreground/40" />
          Shown
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-primary" />
          Responded
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex h-[180px] min-w-[480px] items-end gap-2 border-b border-border pb-2">
          {data.map((d) => (
            <div key={d.bucket} className="flex h-full flex-1 flex-col items-center gap-1">
              <div className="flex h-full w-full items-end justify-center gap-0.5">
                <div
                  className="w-1/2 rounded-sm bg-muted-foreground/40"
                  style={{ height: `${(d.shown / max) * 100}%` }}
                  title={`Shown: ${d.shown}`}
                />
                <div
                  className="w-1/2 rounded-sm bg-primary"
                  style={{ height: `${(d.sent / max) * 100}%` }}
                  title={`Responded: ${d.sent}`}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Per-question breakdown ────────────────────────────────────────────────────

function QuestionBreakdown({
  projectId,
  surveyId,
  range,
  question,
  index,
}: {
  projectId: string
  surveyId: string
  range: { from: string; to: string }
  question: SurveyQuestionUI
  index: number
}) {
  const query = trpc.surveys.results.questionBreakdown.useQuery(
    { projectId, surveyId, range, questionId: question.id },
    { placeholderData: keepPreviousData },
  )
  const rows = query.data ?? []
  const max = Math.max(1, ...rows.map((r) => r.count))

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-bold text-primary">
          {index + 1}
        </span>
        <span className="text-xs font-medium text-foreground">{question.question}</span>
        <Badge variant="outline" className="ml-auto text-[9px] capitalize">
          {question.type.replace('_', ' ')}
        </Badge>
      </div>
      {query.isPending ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      ) : query.error ? (
        <ErrorBanner message={query.error.message} />
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No responses yet.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.value} className="flex items-center gap-3">
              <div className="w-28 shrink-0 truncate text-[11px] text-foreground" title={r.value}>
                {r.value}
              </div>
              <div className="relative h-5 flex-1 overflow-hidden rounded bg-muted/30">
                <div
                  className="h-full rounded bg-primary/70"
                  style={{ width: `${(r.count / max) * 100}%` }}
                />
              </div>
              <div className="w-24 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                {r.count} · {r.users} users
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Segment breakdown ─────────────────────────────────────────────────────────

function SegmentBreakdownSection({
  projectId,
  surveyId,
  range,
}: {
  projectId: string
  surveyId: string
  range: { from: string; to: string }
}) {
  const [segmentId, setSegmentId] = useState<string>('')
  const segmentsQuery = trpc.segments.list.useQuery({ projectId })
  const segments = (segmentsQuery.data ?? []) as unknown as { id: string; name: string }[]

  const breakdownQuery = trpc.surveys.results.segmentBreakdown.useQuery(
    { projectId, surveyId, range, segmentId },
    { enabled: !!segmentId, placeholderData: keepPreviousData },
  )
  const rows = breakdownQuery.data ?? []

  return (
    <section>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-xs font-semibold text-foreground">Response rate by segment</h2>
        <Select value={segmentId} onValueChange={setSegmentId}>
          <SelectTrigger className="h-8 w-full text-xs sm:w-56">
            <SelectValue placeholder="Select a segment" />
          </SelectTrigger>
          <SelectContent>
            {segments.map((s) => (
              <SelectItem key={s.id} value={s.id} className="text-xs">
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!segmentId ? (
        <div className="rounded-xl border border-border bg-card py-10 text-center text-[11px] text-muted-foreground">
          Pick a segment to compare response rate for members vs. non-members.
        </div>
      ) : breakdownQuery.isPending ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : breakdownQuery.error ? (
        <ErrorBanner message={breakdownQuery.error.message} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[420px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">Segment</th>
                <th className="px-4 py-2.5 text-right font-medium">Shown</th>
                <th className="px-4 py-2.5 text-right font-medium">Responded</th>
                <th className="px-4 py-2.5 text-right font-medium">Rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.member} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-3 capitalize text-foreground">
                    {r.member.replace('_', '-')}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                    {r.shown.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                    {r.responded.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-foreground">
                    {(r.rate * 100).toFixed(1)}%
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-6 text-center text-[11px] text-muted-foreground"
                  >
                    No data for this segment in range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
