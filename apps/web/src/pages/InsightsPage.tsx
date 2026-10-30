import {
  AlertTriangle,
  BarChart3,
  Filter,
  Funnel as FunnelIcon,
  Heart,
  LineChart,
  ListFilter,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
  TrendingUp,
  Users2,
} from 'lucide-react'
import { type ComponentType, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { DateRangeControl } from '@/components/DateRangeControl'
import { WidgetBoard } from '@/components/dashboard/WidgetBoard'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonTable } from '@/components/skeletons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useUrlDateRange } from '@/hooks/useUrlDateRange'
import { track } from '@/lib/analytics'
import { formatTimestamp } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { makeParamSetter, parseEnumParam } from '@/lib/url-params'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'

type InsightType = 'trend' | 'funnel' | 'retention' | 'users' | 'breakdown'

type InsightRow = {
  id: string
  name: string
  description: string | null
  type: string
  tags: string[]
  isFavorite: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

const TAB_OPTIONS = [
  { value: 'all', label: 'All insights' },
  { value: 'mine', label: 'My insights' },
  { value: 'favorites', label: 'Favorites' },
] as const

type TabValue = (typeof TAB_OPTIONS)[number]['value']

const TYPE_META: Record<
  InsightType,
  { label: string; icon: ComponentType<{ className?: string }> }
> = {
  trend: { label: 'Trend', icon: TrendingUp },
  funnel: { label: 'Funnel', icon: FunnelIcon },
  retention: { label: 'Retention', icon: LineChart },
  users: { label: 'Active users', icon: Users2 },
  breakdown: { label: 'Breakdown', icon: ListFilter },
}

const ALL_TYPES = 'all'

function TypeIcon({ type }: { type: string }) {
  const meta = TYPE_META[type as InsightType]
  const Icon = meta?.icon ?? BarChart3
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
      <Icon className="h-3.5 w-3.5" />
    </div>
  )
}

export function InsightsPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const utils = trpc.useUtils()
  const { can, user } = useAuth()
  const canManageProjects = can('projects:manage')
  const enabled = !!projectId

  const [searchParams, setSearchParams] = useSearchParams()
  const setParam = useMemo(() => makeParamSetter(setSearchParams), [setSearchParams])

  // All list/board filters are URL-backed so a filtered Insights view is
  // shareable and survives reload.
  const view = parseEnumParam<'board' | 'library'>(
    searchParams.get('view'),
    ['board', 'library'],
    'board',
  )
  const setView = (next: 'board' | 'library') => setParam('view', next, 'board')

  // Board-level filter (Datadog-style): applies to every board widget.
  // `users` (DAU/WAU/MAU) widgets are window-scoped — the range still bounds
  // their series span, but the hour/day interval doesn't apply to them.
  const {
    selection: boardRangeSel,
    setSelection: setBoardRangeSel,
    customRange: boardCustomRange,
    setCustomRange: setBoardCustomRange,
    range: boardRange,
    interval: boardInterval,
  } = useUrlDateRange({ defaultSelection: '7d' })
  const boardResolved = useMemo(
    () => ({ range: boardRange, interval: boardInterval }),
    [boardRange, boardInterval],
  )

  const tab = parseEnumParam<TabValue>(
    searchParams.get('tab'),
    TAB_OPTIONS.map((o) => o.value),
    'all',
  )
  const tagFilter = searchParams.get('tag') || undefined
  const typeFilter = searchParams.get('type') || ALL_TYPES
  const search = searchParams.get('q')?.trim() ?? ''
  const [searchInput, setSearchInput] = useState(search)
  const setTab = (next: TabValue) => setParam('tab', next, 'all')
  const setTagFilter = (next: string | undefined) => setParam('tag', next ?? null)
  const setTypeFilter = (next: string) => setParam('type', next, ALL_TYPES)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [seeding, setSeeding] = useState(false)
  // Optimistic favorite overrides, keyed by insight id — avoids fighting
  // tRPC's recursive `Insight.config: Json` type when patching the query
  // cache directly; cleared once the invalidated list refetch lands.
  const [favoriteOverrides, setFavoriteOverrides] = useState<Record<string, boolean>>({})

  // Debounce the free-text search into the URL (and thus the query key). Skip
  // the write when it already matches so seeding from a shared `?q=` link
  // doesn't rewrite the URL on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setParam/search read intentionally, effect keyed on input
  useEffect(() => {
    const t = setTimeout(() => {
      const trimmed = searchInput.trim()
      if (trimmed !== search) setParam('q', trimmed, '')
    }, 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const insightsQuery = trpc.insights.list.useQuery(
    {
      projectId: projectId as string,
      favoritesOnly: tab === 'favorites' || undefined,
      tag: tagFilter,
      search: search || undefined,
    },
    { enabled },
  )
  const toggleFavorite = trpc.insights.toggleFavorite.useMutation()
  const del = trpc.insights.delete.useMutation()
  const seedDefaults = trpc.insights.seedDefaults.useMutation()

  const widgetsQuery = trpc.dashboard.widgets.useQuery(
    { projectId: projectId as string },
    { enabled },
  )
  const boardInsightIds = useMemo(
    () => new Set((widgetsQuery.data ?? []).map((w) => w.insightId)),
    [widgetsQuery.data],
  )
  const addWidget = trpc.dashboard.addWidget.useMutation({
    onSuccess: (_data, variables) => {
      utils.dashboard.widgets.invalidate({ projectId: projectId as string })
      const widgetType = allInsights.find((i) => i.id === variables.insightId)?.type
      track('dashboard_widget_added', { widget_type: widgetType })
      toast.success('Added to dashboard')
    },
    onError: (err) => toast.error(err.message ?? 'Failed to add to dashboard'),
  })

  function handleAddToDashboard(insightId: string) {
    if (!projectId) return
    addWidget.mutate({ projectId, insightId })
  }

  const allInsights = useMemo<InsightRow[]>(() => {
    const rows = (insightsQuery.data ?? []) as unknown as InsightRow[]
    if (Object.keys(favoriteOverrides).length === 0) return rows
    return rows.map((row) =>
      row.id in favoriteOverrides ? { ...row, isFavorite: favoriteOverrides[row.id] } : row,
    )
  }, [insightsQuery.data, favoriteOverrides])

  const insights = useMemo(() => {
    let rows = allInsights
    if (tab === 'mine' && user?.id) {
      rows = rows.filter((i) => i.createdBy === user.id)
    }
    if (typeFilter !== ALL_TYPES) {
      rows = rows.filter((i) => i.type === typeFilter)
    }
    return rows
  }, [allInsights, tab, typeFilter, user?.id])

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const insight of allInsights) {
      for (const tag of insight.tags) set.add(tag)
    }
    return Array.from(set).sort()
  }, [allInsights])

  async function handleToggleFavorite(insight: InsightRow) {
    if (!projectId) return
    setFavoriteOverrides((prev) => ({ ...prev, [insight.id]: !insight.isFavorite }))
    try {
      await toggleFavorite.mutateAsync({ projectId, id: insight.id })
      await utils.insights.list.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update favorite')
    } finally {
      setFavoriteOverrides((prev) => {
        const next = { ...prev }
        delete next[insight.id]
        return next
      })
    }
  }

  async function handleDelete(id: string) {
    if (!projectId) return
    try {
      await del.mutateAsync({ projectId, id })
      await utils.insights.list.invalidate()
      toast.success('Insight deleted')
      setDeleteTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete insight')
    }
  }

  async function handleQuickStart() {
    if (!projectId) return
    setSeeding(true)
    try {
      const result = await seedDefaults.mutateAsync({ projectId })
      await utils.insights.list.invalidate()
      if (result.seeded) {
        toast.success(`Seeded ${result.count} default insights`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to seed default insights')
    } finally {
      setSeeding(false)
    }
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No project selected.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        title="Product analytics"
        subtitle={`${insights.length} insight${insights.length === 1 ? '' : 's'}`}
      >
        {view === 'board' && (
          <DateRangeControl
            selection={boardRangeSel}
            onSelectionChange={setBoardRangeSel}
            customRange={boardCustomRange}
            onCustomRangeChange={setBoardCustomRange}
          />
        )}
        {canManageProjects && (
          <Button size="sm" onClick={() => navigate('/insights/new')}>
            <Plus className="w-3.5 h-3.5" />
            New
          </Button>
        )}
      </PageHeader>

      <Tabs
        value={view}
        onValueChange={(v) => setView(v as 'board' | 'library')}
        className="flex flex-1 flex-col overflow-hidden"
      >
        <div className="px-4 pt-4 md:px-6 md:pt-6">
          <TabsList>
            <TabsTrigger value="board">Board</TabsTrigger>
            <TabsTrigger value="library">Library</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="board" className="flex-1 overflow-auto p-4 md:p-6">
          <WidgetBoard projectId={projectId} boardResolved={boardResolved} />
        </TabsContent>

        <TabsContent value="library" className="flex-1 overflow-auto p-4 md:p-6">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
              <TabsList>
                {TAB_OPTIONS.map((opt) => (
                  <TabsTrigger key={opt.value} value={opt.value}>
                    {opt.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search insights…"
                  className="h-8 w-full pl-8 text-xs sm:w-56"
                />
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5">
                    <Filter className="h-3.5 w-3.5" />
                    {tagFilter ?? 'All tags'}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setTagFilter(undefined)}>
                    All tags
                  </DropdownMenuItem>
                  {allTags.map((tag) => (
                    <DropdownMenuItem key={tag} onSelect={() => setTagFilter(tag)}>
                      {tag}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5">
                    <ListFilter className="h-3.5 w-3.5" />
                    {typeFilter === ALL_TYPES
                      ? 'All types'
                      : TYPE_META[typeFilter as InsightType]?.label}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setTypeFilter(ALL_TYPES)}>
                    All types
                  </DropdownMenuItem>
                  {(Object.keys(TYPE_META) as InsightType[]).map((type) => (
                    <DropdownMenuItem key={type} onSelect={() => setTypeFilter(type)}>
                      {TYPE_META[type].label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {insightsQuery.isPending ? (
            <div className="overflow-x-auto rounded-lg border border-border">
              <SkeletonTable rows={5} cols={6} />
            </div>
          ) : insightsQuery.error ? (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              <div>
                <div className="text-sm font-medium text-red-400">Failed to load insights</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {insightsQuery.error.message}
                </div>
              </div>
            </div>
          ) : allInsights.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
              <BarChart3 className="mb-3 h-8 w-8 text-muted-foreground/30" />
              <div className="text-sm font-medium text-muted-foreground">No insights yet</div>
              <div className="mt-1 mb-4 text-[11px] text-muted-foreground/60">
                Build a saved trend, funnel, retention, or breakdown insight — or quick-start with a
                library of common defaults.
              </div>
              <div className="flex items-center gap-2">
                {canManageProjects && (
                  <Button variant="outline" size="sm" onClick={handleQuickStart} disabled={seeding}>
                    <Sparkles className="w-3.5 h-3.5" />
                    {seeding ? 'Seeding…' : 'Quick start'}
                  </Button>
                )}
                {canManageProjects && (
                  <Button size="sm" onClick={() => navigate('/insights/new')}>
                    <Plus className="w-3.5 h-3.5" />
                    New
                  </Button>
                )}
              </div>
            </div>
          ) : insights.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
              <Search className="mb-3 h-8 w-8 text-muted-foreground/30" />
              <div className="text-sm font-medium text-muted-foreground">No matching insights</div>
              <div className="mt-1 text-[11px] text-muted-foreground/60">
                Try clearing your search, tag, or type filter.
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-background">
                  <tr className="border-b border-border">
                    <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground" />
                    <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Name
                    </th>
                    <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Tags
                    </th>
                    <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Created by
                    </th>
                    <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Created
                    </th>
                    <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Modified
                    </th>
                    <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground" />
                    <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground" />
                  </tr>
                </thead>
                <tbody>
                  {insights.map((insight) => (
                    <tr
                      key={insight.id}
                      onClick={() => navigate(`/insights/${insight.id}`)}
                      className="group cursor-pointer border-b border-border/50 transition-colors last:border-b-0 hover:bg-muted/20"
                    >
                      <td className="px-4 py-3">
                        <TypeIcon type={insight.type} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground transition-colors group-hover:text-primary">
                          {insight.name}
                        </div>
                        {insight.description && (
                          <div className="mt-0.5 max-w-xs truncate text-[11px] text-muted-foreground">
                            {insight.description}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {insight.tags.length === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            insight.tags.map((tag) => (
                              <Badge key={tag} variant="secondary" className="text-[10px]">
                                {tag}
                              </Badge>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        {insight.createdBy || '—'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-muted-foreground">
                        {formatTimestamp(insight.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-muted-foreground">
                        {formatTimestamp(insight.updatedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleToggleFavorite(insight)
                          }}
                          title={insight.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                          className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-foreground"
                        >
                          <Heart
                            className={
                              insight.isFavorite
                                ? 'h-3.5 w-3.5 fill-red-400 text-red-400'
                                : 'h-3.5 w-3.5'
                            }
                          />
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              onClick={(e) => e.stopPropagation()}
                              title="More actions"
                              className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-foreground"
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenuItem
                              onSelect={() => navigate(`/insights/${insight.id}/edit`)}
                            >
                              Edit
                            </DropdownMenuItem>
                            {canManageProjects && (
                              <DropdownMenuItem
                                disabled={boardInsightIds.has(insight.id) || addWidget.isPending}
                                onSelect={() => handleAddToDashboard(insight.id)}
                              >
                                {boardInsightIds.has(insight.id)
                                  ? 'On dashboard'
                                  : 'Add to dashboard'}
                              </DropdownMenuItem>
                            )}
                            {canManageProjects && (
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setDeleteTarget(insight.id)}
                              >
                                Delete
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {deleteTarget && (
            <ConfirmDialog
              title="Delete this insight?"
              body={`"${insights.find((i) => i.id === deleteTarget)?.name}" will be removed from your saved insights.`}
              confirmLabel="Delete insight"
              onConfirm={() => handleDelete(deleteTarget)}
              onCancel={() => setDeleteTarget(null)}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/60"
        onClick={onCancel}
      />
      <div className="relative w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl shadow-black/50">
        <div className="mb-4 flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500/15">
            <AlertTriangle className="h-4 w-4 text-red-400" />
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground">{title}</div>
            <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{body}</div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
