// Open-text results view (follow-up). A `type: 'open'` question can't
// be binned into bars — every answer is unique free text — so it renders a
// readable, searchable feed of quote cards instead of QuestionBreakdown's bar
// list. Clicking a response drills into a Sheet with that respondent's full
// submission (every question + their answer) and a link to their user profile.

import { keepPreviousData } from '@tanstack/react-query'
import { AlertTriangle, ExternalLink, Loader2, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { formatRelative } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import type { OpenQuestionUI, SurveyQuestionUI } from './types'

const PAGE_SIZE = 20

export function OpenQuestionBreakdown({
  projectId,
  surveyId,
  range,
  question,
  index,
  questions,
}: {
  projectId: string
  surveyId: string
  range: { from: string; to: string }
  question: OpenQuestionUI
  index: number
  /** All survey questions — lets the drill-down Sheet label answers by prompt. */
  questions: SurveyQuestionUI[]
}) {
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [search, setSearch] = useState('')
  const [openFor, setOpenFor] = useState<string | null>(null)

  const query = trpc.surveys.results.openResponses.useQuery(
    { projectId, surveyId, range, questionId: question.id, limit, offset: 0 },
    { placeholderData: keepPreviousData },
  )
  const items = query.data?.items ?? []
  const hasMore = query.data?.hasMore ?? false

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter((r) => r.response.toLowerCase().includes(q))
  }, [items, search])

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-bold text-primary">
          {index + 1}
        </span>
        <span className="text-xs font-medium text-foreground">{question.question}</span>
        <Badge variant="outline" className="ml-auto text-[9px] capitalize">
          Open text
        </Badge>
      </div>

      {query.isPending ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border-l-2 border-border bg-muted/20 p-3">
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="mt-2 h-2.5 w-32" />
            </div>
          ))}
        </div>
      ) : query.error ? (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          <div>
            <div className="text-sm font-medium text-red-400">Failed to load</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{query.error.message}</div>
          </div>
        </div>
      ) : items.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No responses yet.</p>
      ) : (
        <>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-[240px]">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search responses…"
                className="h-8 pl-8 text-xs"
              />
            </div>
            <span className="text-[10px] text-muted-foreground">
              {filtered.length} of {items.length} response{items.length === 1 ? '' : 's'}
            </span>
          </div>

          {filtered.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-muted-foreground">
              No responses match “{search.trim()}”.
            </p>
          ) : (
            <div className="space-y-2">
              {filtered.map((r) => (
                <button
                  key={`${r.distinctId}-${r.timestamp}`}
                  type="button"
                  onClick={() => setOpenFor(r.distinctId)}
                  className="group flex w-full flex-col gap-1.5 rounded-lg border-l-2 border-primary/40 bg-muted/20 p-3 text-left transition-colors hover:border-primary hover:bg-muted/40"
                >
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
                    {r.response}
                  </p>
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span className="max-w-[160px] truncate font-mono" title={r.distinctId}>
                      {r.distinctId}
                    </span>
                    <span>·</span>
                    <span>{formatRelative(r.timestamp)}</span>
                    <ExternalLink className="ml-auto h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                </button>
              ))}
            </div>
          )}

          {hasMore && !search.trim() && (
            <button
              type="button"
              onClick={() => setLimit((l) => l + PAGE_SIZE)}
              disabled={query.isFetching}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-border py-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {query.isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
              Load more
            </button>
          )}
        </>
      )}

      <RespondentSheet
        projectId={projectId}
        surveyId={surveyId}
        range={range}
        questions={questions}
        distinctId={openFor}
        onOpenChange={(open) => !open && setOpenFor(null)}
      />
    </div>
  )
}

function RespondentSheet({
  projectId,
  surveyId,
  range,
  questions,
  distinctId,
  onOpenChange,
}: {
  projectId: string
  surveyId: string
  range: { from: string; to: string }
  questions: SurveyQuestionUI[]
  distinctId: string | null
  onOpenChange: (open: boolean) => void
}) {
  const query = trpc.surveys.results.respondent.useQuery(
    { projectId, surveyId, range, distinctId: distinctId ?? '' },
    { enabled: !!distinctId },
  )
  const answers = query.data ?? []
  const promptFor = (questionId: string) =>
    questions.find((q) => q.id === questionId)?.question ?? questionId
  const latest = answers.length > 0 ? answers[answers.length - 1].timestamp : null

  return (
    <Sheet open={!!distinctId} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="text-sm">Respondent</SheetTitle>
          <SheetDescription asChild>
            {distinctId ? (
              <Link
                to={`/users/${encodeURIComponent(distinctId)}`}
                className="inline-flex items-center gap-1.5 font-mono text-xs text-primary hover:underline"
              >
                {distinctId}
                <ExternalLink className="h-3 w-3" />
              </Link>
            ) : (
              <span />
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-5">
          {query.isPending ? (
            [0, 1, 2].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-2.5 w-40" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))
          ) : query.error ? (
            <p className="text-[11px] text-red-400">{query.error.message}</p>
          ) : answers.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No answers found in this range.</p>
          ) : (
            answers.map((a) => (
              <div key={a.questionId} className="space-y-1">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {promptFor(a.questionId)}
                </div>
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
                  {a.response}
                </p>
              </div>
            ))
          )}
        </div>

        {latest && (
          <div className="mt-6 border-t border-border pt-4 text-[10px] text-muted-foreground">
            Submitted {formatRelative(latest)}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
