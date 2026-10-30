import { AlertTriangle, ChevronRight, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { toast } from 'sonner'
import { DateRangeControl } from '@/components/DateRangeControl'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonChart } from '@/components/skeletons'
import { Button } from '@/components/ui/button'
import { useEventNames } from '@/hooks/useTaxonomy'
import { useUrlDateRange } from '@/hooks/useUrlDateRange'
import { formatNumber } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'
import { FunnelPreview } from '@/pages/funnels/FunnelPreview'
import type { SavedFunnel } from '@/pages/funnels/types'

const WINDOW_OPTIONS = [
  { value: 3600, label: '1h' },
  { value: 86400, label: '1d' },
  { value: 604800, label: '7d' },
] as const

// Human-readable duration from milliseconds: days/hours or minutes/seconds.
function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

export function FunnelsPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canManageProjects = can('projects:manage')
  const {
    selection: rangeSel,
    setSelection: setRangeSel,
    customRange,
    setCustomRange,
    range,
  } = useUrlDateRange({ defaultSelection: '30d' })
  // Which funnel is previewed in the sidebar — synced to `?funnel=` so the
  // selection survives a refresh/share, same as the funnel edit route already does.
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = searchParams.get('funnel')
  function setSelectedId(id: string | null) {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        if (id) params.set('funnel', id)
        else params.delete('funnel')
        return params
      },
      { replace: true },
    )
  }
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const enabled = !!projectId

  const eventNames = useEventNames(projectId)
  const options = eventNames.options
  const labelFor = (value: string): string => options.find((o) => o.value === value)?.label ?? value
  const displayLabel = (r: { label: string; alias?: string }): string =>
    r.alias || labelFor(r.label)

  const funnelsQuery = trpc.funnels.list.useQuery({ projectId: projectId as string }, { enabled })
  const del = trpc.funnels.delete.useMutation()

  const funnels = useMemo<SavedFunnel[]>(
    () => (funnelsQuery.data ?? []) as unknown as SavedFunnel[],
    [funnelsQuery.data],
  )

  const selected = funnels.find((f) => f.id === selectedId) ?? funnels[0] ?? null
  const validSteps = selected?.steps.filter((s) => s.event.length > 0) ?? []
  const canRun = validSteps.length >= 2

  const funnel = trpc.events.funnel.useQuery(
    {
      projectId: projectId as string,
      steps: validSteps,
      window: selected?.window ?? 86400,
      range,
    },
    { enabled: enabled && canRun },
  )
  const stats = trpc.events.funnelStats.useQuery(
    {
      projectId: projectId as string,
      steps: validSteps,
      window: selected?.window ?? 86400,
      range,
    },
    { enabled: enabled && canRun },
  )
  const history = trpc.events.funnelHistory.useQuery(
    {
      projectId: projectId as string,
      steps: validSteps,
      window: selected?.window ?? 86400,
      range,
    },
    { enabled: enabled && canRun },
  )

  async function handleDelete(id: string) {
    if (!projectId) return
    try {
      await del.mutateAsync({ projectId, id })
      await utils.funnels.list.invalidate()
      if (selectedId === id) {
        const remaining = funnels.filter((f) => f.id !== id)
        setSelectedId(remaining[0]?.id ?? null)
      }
      toast.success('Funnel deleted')
      setDeleteTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete funnel')
    }
  }

  const rows = funnel.data ?? []
  const entered = rows[0]?.count ?? 0
  const converted = rows.length > 0 ? rows[rows.length - 1].count : 0
  const overallConv = rows.length > 0 ? rows[rows.length - 1].conversionPct : 0
  const trend = stats.data?.trend ?? 0

  const windowLabel =
    WINDOW_OPTIONS.find((o) => o.value === selected?.window)?.label ?? `${selected?.window ?? 0}s`

  const funnelState = !canRun
    ? 'idle'
    : funnel.isPending
      ? 'loading'
      : funnel.error
        ? 'error'
        : rows.length === 0
          ? 'empty'
          : 'ready'

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No project selected.
      </div>
    )
  }

  return (
    <div className="flex flex-col md:flex-row h-full overflow-hidden">
      {/* ── Collapsible funnels sidebar (client-side list, no backend) ── */}
      {sidebarOpen ? (
        <div className="w-full md:w-[248px] border-r border-border flex flex-col shrink-0 bg-sidebar">
          <div className="px-3 py-3 border-b border-border flex items-center justify-between shrink-0">
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="flex items-center gap-2 text-xs font-semibold text-foreground hover:text-muted-foreground transition-colors"
            >
              <ChevronRight className="w-3.5 h-3.5 rotate-180" />
              Funnels
            </button>
            {canManageProjects && (
              <button
                type="button"
                onClick={() => navigate('/funnels/new')}
                className="flex items-center gap-1 px-2 py-1 bg-primary/10 text-primary rounded text-[11px] font-medium hover:bg-primary/20 transition-colors"
              >
                <Plus className="w-3 h-3" />
                New
              </button>
            )}
          </div>
          <div className="flex-1 overflow-auto p-2 space-y-0.5">
            {funnels.map((f) => (
              <div
                key={f.id}
                className={cn(
                  'group relative rounded-md border transition-colors',
                  selectedId === f.id
                    ? 'bg-primary/10 border-primary/20'
                    : 'border-transparent hover:bg-muted/30',
                )}
              >
                <button
                  type="button"
                  className="w-full text-left px-3 py-2.5"
                  onClick={() => setSelectedId(f.id)}
                >
                  <div className="mb-0.5">
                    <span className="text-xs font-medium text-foreground truncate pr-8 leading-tight block">
                      {f.name}
                    </span>
                  </div>
                  <span className="text-[10px] text-muted-foreground">{f.steps.length} steps</span>
                </button>
                <div className="absolute top-2.5 right-2 hidden group-hover:flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => navigate(`/funnels/${f.id}/edit`)}
                    className="p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  {canManageProjects && (
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(f.id)}
                      className="p-1 rounded text-muted-foreground/50 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="w-10 border-r border-border flex flex-col items-center py-3 gap-3 shrink-0 bg-sidebar">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            title="Show funnels"
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
          <div className="flex flex-col gap-1.5 items-center">
            {funnels.map((f) => (
              <button
                type="button"
                key={f.id}
                onClick={() => {
                  setSelectedId(f.id)
                  setSidebarOpen(true)
                }}
                title={f.name}
                className={cn(
                  'w-1.5 h-1.5 rounded-full transition-colors',
                  selectedId === f.id
                    ? 'bg-primary'
                    : 'bg-muted-foreground/30 hover:bg-muted-foreground/60',
                )}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Main content ── */}
      {selected ? (
        <div className="flex-1 overflow-auto flex flex-col min-w-0">
          <PageHeader
            title={selected.name}
            subtitle={`${windowLabel} window · ${formatNumber(entered)} users entered`}
          >
            <DateRangeControl
              selection={rangeSel}
              onSelectionChange={setRangeSel}
              customRange={customRange}
              onCustomRangeChange={setCustomRange}
            />
            <button
              type="button"
              onClick={() => navigate(`/funnels/${selected.id}/edit`)}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground px-2.5 py-1.5 border border-border rounded transition-colors"
            >
              <Pencil className="w-3 h-3" />
              Edit
            </button>
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground px-2.5 py-1.5 border border-border rounded transition-colors flex items-center gap-1.5"
            >
              <ExternalLink className="w-3 h-3" />
              Share
            </button>
          </PageHeader>

          <div className="flex-1 p-6 space-y-5">
            {/* KPI row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                {
                  label: 'Overall Conv.',
                  value: canRun && rows.length > 0 ? `${overallConv}%` : '—',
                  sub:
                    stats.data && enabled
                      ? `${trend >= 0 ? '+' : ''}${trend}% vs prev period`
                      : 'entry → conversion',
                  color: trend >= 0 ? 'text-teal-400' : 'text-red-400',
                },
                {
                  label: 'Users Entered',
                  value: canRun && rows.length > 0 ? formatNumber(entered) : '—',
                  sub: 'started the funnel',
                  color: 'text-muted-foreground',
                },
                {
                  label: 'Users Converted',
                  value: canRun && rows.length > 0 ? formatNumber(converted) : '—',
                  sub: 'reached the last step',
                  color: 'text-muted-foreground',
                },
                {
                  label: 'Median Time',
                  value: formatDuration(stats.data?.medianMs),
                  sub: 'entry → conversion',
                  color: 'text-muted-foreground',
                },
              ].map(({ label, value, sub, color }) => (
                <div key={label} className="bg-card border border-border rounded-lg px-4 py-4">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                    {label}
                  </div>
                  <div className="font-mono text-2xl font-semibold text-foreground">{value}</div>
                  <div className={cn('text-[11px] mt-1', color)}>{sub}</div>
                </div>
              ))}
            </div>

            <FunnelPreview
              rows={rows}
              displayLabel={displayLabel}
              windowLabel={windowLabel}
              state={funnelState}
              errorMessage={funnel.error?.message}
              idleHint="Add at least two steps to run the funnel."
            />

            {/* Conversion over time */}
            {canRun && (
              <div className="bg-card border border-border rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      Conversion rate over time
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      Daily overall conversion rate
                    </div>
                  </div>
                </div>
                {history.isPending ? (
                  <SkeletonChart height={130} />
                ) : (history.data?.length ?? 0) === 0 ? (
                  <div className="flex h-[130px] items-center justify-center text-sm text-muted-foreground">
                    Not enough data to chart conversion over time.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={130}>
                    <AreaChart
                      data={history.data ?? []}
                      margin={{ top: 4, right: 0, left: -20, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="convGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#2DD4BF" stopOpacity={0.2} />
                          <stop offset="95%" stopColor="#2DD4BF" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis
                        dataKey="bucket"
                        tick={{ fontSize: 10, fill: '#6B6B8A' }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(v: string) =>
                          new Date(v).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                          })
                        }
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: '#6B6B8A' }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(v: number) => `${Math.round(v)}%`}
                      />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null
                          return (
                            <div className="bg-popover border border-border rounded-lg px-3 py-2 shadow-xl text-xs">
                              <div className="font-mono font-semibold text-primary">
                                {Number(payload[0].value).toFixed(1)}% conv.
                              </div>
                            </div>
                          )
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="rate"
                        stroke="#2DD4BF"
                        strokeWidth={1.5}
                        fill="url(#convGrad)"
                        dot={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <div className="text-sm font-medium text-muted-foreground">No funnels yet</div>
          <div className="text-[11px] text-muted-foreground/60 mt-1 mb-4">
            Create your first funnel to start tracking.
          </div>
          {canManageProjects && (
            <Button size="sm" onClick={() => navigate('/funnels/new')}>
              <Plus className="w-3.5 h-3.5" />
              New funnel
            </Button>
          )}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this funnel?"
          body={`"${funnels.find((f) => f.id === deleteTarget)?.name}" will be removed from your saved funnels.`}
          confirmLabel="Delete funnel"
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
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
