import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'

import { AlertTriangle, LayoutGrid, MoreHorizontal, Plus, Search } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Responsive, WidthProvider } from 'react-grid-layout'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import InsightResultView, {
  type InsightResult,
  type WidgetSize,
} from '@/components/insights/InsightResultView'
import { SkeletonCard, SkeletonChart, SkeletonList } from '@/components/skeletons'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useEventNames } from '@/hooks/useTaxonomy'
import { track } from '@/lib/analytics'
import type { DateRange } from '@/lib/range'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'

const ResponsiveGridLayout = WidthProvider(Responsive)

const BREAKPOINTS = { lg: 1024, md: 768, sm: 0 }
const COLS = { lg: 12, md: 12, sm: 1 }
const LAYOUT_DEBOUNCE_MS = 500

type TypeLabel = Record<string, string>
const TYPE_LABELS: TypeLabel = {
  trend: 'Trend',
  funnel: 'Funnel',
  retention: 'Retention',
  users: 'Active users',
  breakdown: 'Breakdown',
}

interface Widget {
  id: string
  insightId: string
  x: number
  y: number
  w: number
  h: number
  rangeKey: string | null
  insight: { id: string; name: string; type: string }
}

interface InsightListRow {
  id: string
  name: string
  type: string
}

/** Density tier for a widget's grid cell — `compact` when short or narrow
 * (no room for axes/legends), `detailed` when wide enough for extra chrome,
 * `standard` (today's single rendering) otherwise. The default `w=4,h=6` a
 * widget gets on `addWidget` stays `standard`, so existing boards don't
 * regress. */
export function widgetSize(w: number, h: number): WidgetSize {
  if (h <= 4 || w <= 3) return 'compact'
  if (w >= 8) return 'detailed'
  return 'standard'
}

/** Single per-project widget board: a responsive drag/resize grid of saved
 * insights, each rendered via the shared `InsightResultView`. Mirrors
 * `InsightViewerPage`'s range-override query pattern per widget, and
 * `InsightsPage`'s add/remove-confirmation conventions. `boardResolved` is
 * the page-header date filter (Datadog-style) — it's owned by `InsightsPage`
 * so it can live in the shared `PageHeader`, not this component. */
export function WidgetBoard({
  projectId,
  boardResolved,
}: {
  projectId: string
  boardResolved: { range: DateRange; interval: 'hour' | 'day' }
}) {
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canManage = can('projects:manage')

  const widgetsQuery = trpc.dashboard.widgets.useQuery({ projectId })
  const widgets = (widgetsQuery.data ?? []) as unknown as Widget[]

  const [addOpen, setAddOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const breakpointRef = useRef<'lg' | 'md' | 'sm'>('lg')
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [liveLayout, setLiveLayout] = useState<Record<string, { w: number; h: number }>>({})

  const updateLayout = trpc.dashboard.updateLayout.useMutation({
    onSuccess: () => utils.dashboard.widgets.invalidate({ projectId }),
  })
  const removeWidget = trpc.dashboard.removeWidget.useMutation({
    onSuccess: () => {
      utils.dashboard.widgets.invalidate({ projectId })
      toast.success('Widget removed')
      setRemoveTarget(null)
    },
    onError: (err) => toast.error(err.message ?? 'Failed to remove widget'),
  })

  const layouts = useMemo(() => {
    const lg = widgets.map((w) => ({ i: w.id, x: w.x, y: w.y, w: w.w, h: w.h }))
    const sm = widgets.map((w, idx) => ({ i: w.id, x: 0, y: idx * w.h, w: 1, h: w.h }))
    return { lg, md: lg, sm }
  }, [widgets])

  function handleLayoutChange(
    currentLayout: { i: string; x: number; y: number; w: number; h: number }[],
  ) {
    if (breakpointRef.current === 'sm') return
    if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current)
    layoutTimerRef.current = setTimeout(() => {
      updateLayout.mutate({
        projectId,
        layouts: currentLayout.map((l) => ({ id: l.i, x: l.x, y: l.y, w: l.w, h: l.h })),
      })
    }, LAYOUT_DEBOUNCE_MS)
  }

  if (widgetsQuery.isPending) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton cards
          <SkeletonCard key={i} lines={5} className="h-64" />
        ))}
      </div>
    )
  }

  if (widgetsQuery.error) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
        <div>
          <div className="text-sm font-medium text-red-400">Failed to load dashboard</div>
          <div className="mt-1 text-[11px] text-muted-foreground">{widgetsQuery.error.message}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        {canManage && (
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add widget
          </Button>
        )}
      </div>

      {widgets.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-border py-20 text-center">
          <LayoutGrid className="mb-3 h-8 w-8 text-muted-foreground/30" />
          <div className="text-sm font-medium text-muted-foreground">Your dashboard is empty</div>
          <div className="mt-1 mb-4 text-[11px] text-muted-foreground/60">
            Add a saved insight to start tracking it here.
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="w-3.5 h-3.5" />
              Add widget
            </Button>
          )}
        </div>
      ) : (
        <ResponsiveGridLayout
          className="layout"
          layouts={layouts}
          breakpoints={BREAKPOINTS}
          cols={COLS}
          rowHeight={40}
          margin={[16, 16]}
          containerPadding={[0, 0]}
          draggableHandle=".widget-drag-handle"
          onBreakpointChange={(bp: 'lg' | 'md' | 'sm') => {
            breakpointRef.current = bp
          }}
          onDragStop={(l) => handleLayoutChange(l)}
          onResize={(_layout, _oldItem, newItem) => {
            if (breakpointRef.current === 'sm') return
            setLiveLayout((prev) => ({
              ...prev,
              [newItem.i]: { w: newItem.w, h: newItem.h },
            }))
          }}
          onResizeStop={(l) => handleLayoutChange(l)}
        >
          {widgets.map((widget) => (
            <div key={widget.id}>
              <WidgetCard
                widget={widget}
                projectId={projectId}
                canManage={canManage}
                boardResolved={boardResolved}
                gridSize={liveLayout[widget.id] ?? { w: widget.w, h: widget.h }}
                onRemove={() => setRemoveTarget(widget.id)}
              />
            </div>
          ))}
        </ResponsiveGridLayout>
      )}

      <AddWidgetDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        projectId={projectId}
        existingInsightIds={new Set(widgets.map((w) => w.insightId))}
      />

      {removeTarget && (
        <AlertDialog open onOpenChange={(open) => !open && setRemoveTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this widget?</AlertDialogTitle>
              <AlertDialogDescription>
                It will be removed from your dashboard. The saved insight itself is not deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={removeWidget.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault()
                  removeWidget.mutate({ projectId, id: removeTarget })
                }}
                disabled={removeWidget.isPending}
                className="bg-red-500 text-white hover:bg-red-600"
              >
                {removeWidget.isPending ? 'Removing…' : 'Remove widget'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}

function WidgetCard({
  widget,
  projectId,
  canManage,
  boardResolved,
  gridSize,
  onRemove,
}: {
  widget: Widget
  projectId: string
  canManage: boolean
  boardResolved: { range: DateRange; interval: 'hour' | 'day' }
  gridSize: { w: number; h: number }
  onRemove: () => void
}) {
  const navigate = useNavigate()
  const eventNames = useEventNames(projectId)
  const labelFor = (value: string): string =>
    eventNames.options.find((o) => o.value === value)?.label ?? value

  // `users` (DAU/WAU/MAU) insights are window-scoped (day/week/month buckets) —
  // the board-level range still bounds the series span (snapped server-side to
  // at least 2 buckets), but the hour/day `interval` doesn't apply to them.
  const isUsersInsight = widget.insight.type === 'users'

  const resultsQuery = trpc.insights.results.useQuery({
    projectId,
    id: widget.insightId,
    rangeOverride: boardResolved.range,
    interval: isUsersInsight ? undefined : boardResolved.interval,
  })

  return (
    <Card className="flex h-full flex-col overflow-hidden py-0">
      <CardHeader className="widget-drag-handle flex flex-row items-center justify-between gap-2 border-b border-border px-4 py-3 cursor-move">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium text-foreground">
            {widget.insight.name}
          </span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {TYPE_LABELS[widget.insight.type] ?? widget.insight.type}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                title="More actions"
                className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => navigate(`/insights/${widget.insightId}/edit`)}>
                Edit
              </DropdownMenuItem>
              {canManage && (
                <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                  Remove
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-auto p-3">
        {resultsQuery.isPending ? (
          // Every insight type renders as a chart/series in InsightResultView.
          <SkeletonChart height={160} bars={10} />
        ) : resultsQuery.error ? (
          <div className="flex items-center gap-2 text-[11px] text-red-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {resultsQuery.error.message}
          </div>
        ) : !resultsQuery.data ? (
          <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
            No results.
          </div>
        ) : (
          <InsightResultView
            result={resultsQuery.data as InsightResult}
            labelFor={labelFor}
            size={widgetSize(gridSize.w, gridSize.h)}
            fillHeight
          />
        )}
      </CardContent>
    </Card>
  )
}

function AddWidgetDialog({
  open,
  onOpenChange,
  projectId,
  existingInsightIds,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  existingInsightIds: Set<string>
}) {
  const utils = trpc.useUtils()
  const [search, setSearch] = useState('')

  const insightsQuery = trpc.insights.list.useQuery(
    { projectId, search: search || undefined },
    {
      enabled: open,
    },
  )
  const insights = (insightsQuery.data ?? []) as unknown as InsightListRow[]

  const addWidget = trpc.dashboard.addWidget.useMutation({
    onSuccess: (_data, variables) => {
      utils.dashboard.widgets.invalidate({ projectId })
      const widgetType = insights.find((i) => i.id === variables.insightId)?.type
      track('dashboard_widget_added', { widget_type: widgetType })
      toast.success('Widget added to dashboard')
      onOpenChange(false)
    },
    onError: (err) => toast.error(err.message ?? 'Failed to add widget'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Add widget</DialogTitle>
          <DialogDescription>Pick a saved insight to pin to your dashboard.</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search insights…"
            className="h-8 pl-8 text-xs"
          />
        </div>

        <div className="flex-1 overflow-auto -mx-2 px-2">
          {insightsQuery.isPending ? (
            <SkeletonList rows={4} className="py-2" />
          ) : insights.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">No insights found.</div>
          ) : (
            <div className="flex flex-col gap-1 py-1">
              {insights.map((insight) => {
                const onBoard = existingInsightIds.has(insight.id)
                return (
                  <button
                    key={insight.id}
                    type="button"
                    disabled={onBoard || addWidget.isPending}
                    onClick={() => addWidget.mutate({ projectId, insightId: insight.id })}
                    className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-xs font-medium text-foreground">
                        {insight.name}
                      </span>
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {TYPE_LABELS[insight.type] ?? insight.type}
                      </Badge>
                    </div>
                    {onBoard && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        On dashboard
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
