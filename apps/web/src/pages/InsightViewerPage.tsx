import { Heart, LayoutGrid, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DateRange as DayRange } from 'react-day-picker'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { DateRangeControl, WindowRangeControl } from '@/components/DateRangeControl'
import InsightResultView, { type InsightResult } from '@/components/insights/InsightResultView'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonChart, SkeletonTable } from '@/components/skeletons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useEventNames } from '@/hooks/useTaxonomy'
import { track } from '@/lib/analytics'
import {
  type DateRangeSelection,
  defaultWindowRangeSelection,
  type RangeKey,
  resolveDateRange,
  resolveWindowRange,
  type UsersWindow,
} from '@/lib/range'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'

/** Best-effort mirror of the persisted config shape (insights.schema.ts) used
 * only to seed the viewer's live range control — same discipline the builder
 * page already follows for its own API-facing types. */
interface StoredInsightConfig {
  type: 'trend' | 'users' | 'funnel' | 'retention' | 'breakdown'
  rangeKey?: RangeKey
  range?: { from: string; to: string }
  window?: UsersWindow
}

function InlineError({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Failed to load</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  )
}

export function InsightViewerPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const projectId = useProjectId()
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canManage = can('projects:manage')
  const enabled = !!projectId && !!id

  const insightQuery = trpc.insights.get.useQuery(
    { projectId: projectId as string, id },
    { enabled },
  )
  const insightData = insightQuery.data as unknown as { config: unknown } | undefined
  const storedConfig = insightData?.config as StoredInsightConfig | undefined
  const isUsers = storedConfig?.type === 'users'

  // Live, non-persisted range override — seeded from the saved config once it
  // loads (`rangeKey` preset if present, else the stored absolute `range`, or
  // the window's default preset for a `users` insight), then user-editable via
  // the header's range control. Never written back to the insight.
  const [rangeSel, setRangeSel] = useState<DateRangeSelection>('custom')
  const [customRange, setCustomRange] = useState<DayRange | undefined>(undefined)
  const [usersRangeSel, setUsersRangeSel] = useState<string>('')
  const [rangeInitialized, setRangeInitialized] = useState(false)

  useEffect(() => {
    if (!storedConfig || rangeInitialized) return
    if (storedConfig.type === 'users') {
      setUsersRangeSel(defaultWindowRangeSelection(storedConfig.window ?? 'day'))
    } else if (storedConfig.rangeKey) {
      setRangeSel(storedConfig.rangeKey)
    } else if (storedConfig.range?.from && storedConfig.range?.to) {
      setRangeSel('custom')
      setCustomRange({
        from: new Date(storedConfig.range.from),
        to: new Date(storedConfig.range.to),
      })
    }
    setRangeInitialized(true)
  }, [storedConfig, rangeInitialized])

  // Fires once per insight id, when the insight has actually loaded.
  useEffect(() => {
    if (!storedConfig) return
    track('insight_viewed', { insight_id: id, insight_type: storedConfig.type })
  }, [id, storedConfig])

  const genericResolved = resolveDateRange(rangeSel, customRange)
  const rangeOverride = isUsers
    ? resolveWindowRange(storedConfig?.window ?? 'day', usersRangeSel)
    : genericResolved.range
  const overrideInterval = isUsers ? undefined : genericResolved.interval

  const resultsQuery = trpc.insights.results.useQuery(
    { projectId: projectId as string, id, rangeOverride, interval: overrideInterval },
    { enabled: enabled && !!insightQuery.data && rangeInitialized },
  )

  const toggleFavorite = trpc.insights.toggleFavorite.useMutation({
    onSuccess: () => {
      utils.insights.get.invalidate({ projectId: projectId as string, id })
      utils.insights.list.invalidate()
    },
  })
  const del = trpc.insights.delete.useMutation()

  const widgetsQuery = trpc.dashboard.widgets.useQuery(
    { projectId: projectId as string },
    { enabled },
  )
  const onDashboard = (widgetsQuery.data ?? []).some((w) => w.insightId === id)
  const addWidget = trpc.dashboard.addWidget.useMutation({
    onSuccess: () => {
      utils.dashboard.widgets.invalidate({ projectId: projectId as string })
      track('dashboard_widget_added', { widget_type: storedConfig?.type })
      toast.success('Added to dashboard')
    },
    onError: (err) => toast.error(err.message ?? 'Failed to add to dashboard'),
  })

  function handleAddToDashboard() {
    if (!projectId) return
    addWidget.mutate({ projectId, insightId: id })
  }

  const eventNames = useEventNames(projectId)
  const labelFor = (value: string): string =>
    eventNames.options.find((o) => o.value === value)?.label ?? value

  async function handleDelete() {
    if (!projectId) return
    try {
      await del.mutateAsync({ projectId, id })
      toast.success('Insight deleted')
      navigate('/insights')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete insight')
    }
  }

  function handleToggleFavorite() {
    if (!projectId) return
    toggleFavorite.mutate({ projectId, id })
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No project selected.
      </div>
    )
  }

  if (insightQuery.isPending) {
    return (
      <div className="flex flex-col h-full overflow-auto">
        <div className="p-4 md:p-6 space-y-3">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="flex-1 p-5">
          <SkeletonChart height={256} />
        </div>
      </div>
    )
  }

  if (insightQuery.error || !insightQuery.data) {
    return (
      <div className="p-5">
        <InlineError message={insightQuery.error?.message ?? 'Insight not found.'} />
      </div>
    )
  }

  const insight = insightQuery.data

  return (
    <div className="flex flex-col h-full overflow-auto">
      <PageHeader title={insight.name} subtitle={insight.description ?? undefined}>
        <div className="flex items-center gap-1.5 flex-wrap">
          {(insight.tags as string[]).map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleToggleFavorite}
          disabled={toggleFavorite.isPending}
          aria-label={insight.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Heart className={cn('w-3.5 h-3.5', insight.isFavorite && 'fill-red-400 text-red-400')} />
        </Button>
        {canManage && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleAddToDashboard}
            disabled={onDashboard || addWidget.isPending}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            {onDashboard ? 'On dashboard' : 'Add to dashboard'}
          </Button>
        )}
        {canManage && (
          <Button variant="outline" size="sm" onClick={() => navigate(`/insights/${id}/edit`)}>
            <Pencil className="w-3.5 h-3.5" />
            Edit
          </Button>
        )}
        {canManage && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="text-red-400 hover:text-red-400">
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this insight?</AlertDialogTitle>
                <AlertDialogDescription>
                  "{insight.name}" will be removed from your saved insights. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={del.isPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault()
                    handleDelete()
                  }}
                  disabled={del.isPending}
                  className="bg-red-500 text-white hover:bg-red-600"
                >
                  {del.isPending ? 'Deleting…' : 'Delete insight'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </PageHeader>

      <div className="flex-1 p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">Date range</span>
          {isUsers ? (
            <WindowRangeControl
              window={storedConfig?.window ?? 'day'}
              selection={usersRangeSel}
              onSelectionChange={setUsersRangeSel}
            />
          ) : (
            <DateRangeControl
              selection={rangeSel}
              onSelectionChange={setRangeSel}
              customRange={customRange}
              onCustomRangeChange={setCustomRange}
            />
          )}
        </div>

        {resultsQuery.isPending ? (
          // `retention` renders a cohort grid and `breakdown` a table; every other
          // insight type renders a chart — mirror whichever is about to land.
          insight.type === 'retention' || insight.type === 'breakdown' ? (
            <div className="overflow-x-auto rounded-lg border border-border">
              <SkeletonTable rows={6} cols={4} />
            </div>
          ) : (
            <SkeletonChart height={256} />
          )
        ) : resultsQuery.error ? (
          <InlineError message={resultsQuery.error.message} />
        ) : !resultsQuery.data ? (
          <EmptyState message="No results." />
        ) : (
          <InsightResultView
            result={resultsQuery.data as InsightResult}
            labelFor={labelFor}
            size="detailed"
          />
        )}
      </div>
    </div>
  )
}
