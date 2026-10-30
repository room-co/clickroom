import { ChevronRight, Flag, FlaskConical, Info, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
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
import { ChartTooltip } from '@/components/ChartTooltip'
import { RangeFilter } from '@/components/RangeFilter'
import { SkeletonCard, SkeletonChart, SkeletonStatRow, SkeletonTable } from '@/components/skeletons'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TooltipContent, TooltipTrigger, Tooltip as UiTooltip } from '@/components/ui/tooltip'
import { useFlagsStream } from '@/hooks/useFlagsStream'
import { track } from '@/lib/analytics'
import { formatDate, formatNumber, formatTimestamp } from '@/lib/format'
import { intervalForKey, type RangeKey, rangeFromKey } from '@/lib/range'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'
import {
  ENV_TAB_GLOW_CLASS,
  EnvBadge,
  envGlowVars,
  type FeatureFlagRow,
  FlagToggle,
  KindBadge,
  KpiCard,
} from './FlagBits'
import { NewFlagDialog } from './NewFlagDialog'
import { TargetingTab } from './TargetingTab'
import {
  defaultEnvKey,
  defaultServedValue,
  type Environment,
  type FlagEnv,
  toFlagFilters,
  useEnvironments,
} from './types'

type FlagDetailTab = 'metrics' | 'targeting' | 'history'

const DETAIL_TABS: { id: FlagDetailTab; label: string }[] = [
  { id: 'metrics', label: 'Metrics' },
  { id: 'targeting', label: 'Targeting' },
  { id: 'history', label: 'History' },
]

/** `?env=` is valid to land on directly (if it names a real environment);
 * anything else falls back to the project's `isDefault` environment. */
function parseEnvParam(raw: string | null, environments: Environment[]): FlagEnv {
  if (raw && environments.some((e) => e.key === raw)) return raw
  return defaultEnvKey(environments) ?? raw ?? ''
}

/**
 * Route: `/flags/:flagKey?env=<production|staging|development>`. Self-contained
 * (mirrors `EventDetailPage`'s convention — `useProjectId`/`useParams`/
 * `useNavigate` directly, no props from a parent list page) so the URL alone
 * is enough to reload this exact view: which flag, and which environment tab.
 */
export function FlagDetailPage() {
  const projectId = useProjectId()
  const { flagKey = '' } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canWriteFlags = can('flags:write')
  const [tab, setTab] = useState<FlagDetailTab>('metrics')
  const environmentsQuery = useEnvironments(projectId)
  const environments = useMemo(() => environmentsQuery.data ?? [], [environmentsQuery.data])
  const envColorByKey = useMemo(
    () => Object.fromEntries(environments.map((e) => [e.key, e.color])),
    [environments],
  )
  const envTab = parseEnvParam(searchParams.get('env'), environments)
  const [creatingInEnv, setCreatingInEnv] = useState(false)
  const toggle = trpc.flags.toggle.useMutation()
  const updateFlag = trpc.flags.update.useMutation()
  useFlagsStream(projectId)

  // Pin: while a running experiment references this flag, exposure
  // tracking is forced on (the API rejects a `track:false` write), so the
  // toggle is disabled + shown on.
  const experimentsQuery = trpc.experiments.list.useQuery(
    { projectId: projectId as string, env: envTab },
    { enabled: !!projectId && !!envTab },
  )

  function setEnvTab(next: FlagEnv) {
    // replace (not push) — switching env tabs is a filter change, not new
    // navigation history; keeps back/forward from stepping through every tab.
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        params.set('env', next)
        return params
      },
      { replace: true },
    )
  }

  const enabled = !!projectId && !!flagKey && !!envTab
  const flagQuery = trpc.flags.get.useQuery(
    { projectId: projectId as string, key: flagKey, env: envTab },
    { enabled, retry: false },
  )

  const currentFlag = flagQuery.data as unknown as FeatureFlagRow | undefined
  const notConfigured = flagQuery.isError && flagQuery.error?.data?.code === 'NOT_FOUND'
  // What a user matching no rule is served — the headline "value for all users".
  const servedDefault = currentFlag ? defaultServedValue(currentFlag.filters) : null

  const trackPinned = useMemo(
    () =>
      (experimentsQuery.data ?? []).some(
        (e) => e.featureFlagId === currentFlag?.id && e.status === 'running',
      ),
    [experimentsQuery.data, currentFlag?.id],
  )

  function onBack() {
    navigate('/flags')
  }

  async function onTrackChange(next: boolean) {
    if (!projectId || !currentFlag) return
    try {
      await updateFlag.mutateAsync({ projectId, id: currentFlag.id, patch: { track: next } })
      track('flag_track_changed', {
        flag_key: currentFlag.key,
        environment: currentFlag.env,
        tracking: next,
      })
      await utils.flags.get.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update exposure tracking')
    }
  }

  async function onToggle(flag: FeatureFlagRow) {
    if (!projectId) return
    try {
      const nextActive = !flag.active
      await toggle.mutateAsync({ projectId, id: flag.id, active: nextActive })
      track('flag_toggled', { flag_key: flag.key, environment: flag.env, enabled: nextActive })
      await Promise.all([utils.flags.get.invalidate(), utils.flags.list.invalidate()])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle flag')
    }
  }

  async function handleCreated() {
    setCreatingInEnv(false)
    await Promise.all([utils.flags.get.invalidate(), utils.flags.list.invalidate()])
  }

  // Cold load: the page assembles several independent queries (environments, flag, metrics) and
  // without a composed shell they pop in as unsynchronized islands. `isPending` (not `isLoading`)
  // so a background refetch of the flag keeps the loaded page rendered. Covers the disabled-query
  // window too, while `environments` is still resolving and `envTab` is empty.
  if (flagQuery.isPending) return <FlagDetailSkeleton />

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* ── Page header ── */}
      <div className="shrink-0 px-8 pb-0 pt-6">
        <button
          type="button"
          onClick={onBack}
          className="group mb-4 flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight className="h-3 w-3 rotate-180 transition-transform group-hover:-translate-x-0.5" />
          Feature Flags
        </button>

        {/* Environment switcher — the flag's config is independent per env */}
        <div className="mb-4 overflow-x-auto">
          <Tabs value={envTab} onValueChange={(v) => setEnvTab(v as FlagEnv)}>
            <TabsList className="w-max">
              {environments.map((e) => (
                <TabsTrigger
                  key={e.key}
                  value={e.key}
                  className={cn('min-w-[84px] shrink-0', ENV_TAB_GLOW_CLASS)}
                  style={envGlowVars(e.color, e.key)}
                >
                  {e.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {currentFlag ? (
          <>
            <div className="mb-5 flex items-start justify-between gap-6">
              <div className="flex items-start gap-4">
                <div className="mt-1">
                  <FlagToggle
                    enabled={currentFlag.active}
                    onToggle={() => onToggle(currentFlag)}
                    disabled={!canWriteFlags}
                  />
                </div>
                <div>
                  <h1 className="text-xl font-semibold leading-tight text-foreground">
                    {currentFlag.name ?? currentFlag.key}
                  </h1>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    {currentFlag.key}
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <EnvBadge env={currentFlag.env} color={envColorByKey[currentFlag.env]} />
                    <KindBadge filters={toFlagFilters(currentFlag.filters)} />
                    {currentFlag.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[10px] text-muted-foreground">Modified</div>
                <div className="mt-0.5 text-xs text-foreground">
                  {formatTimestamp(currentFlag.updatedAt)}
                </div>
                <div className="mt-3 text-[10px] text-muted-foreground">Default</div>
                <div className="mt-0.5 font-mono text-sm font-semibold text-foreground">
                  {servedDefault ?? '—'}
                </div>
              </div>
            </div>

            {/* Exposure-tracking toggle — disabled + on while pinned. */}
            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3.5 py-2.5">
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="flag-track" className="text-[11px] text-foreground">
                    Track exposures
                  </Label>
                  <UiTooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="About exposure tracking"
                        className="text-muted-foreground/60 transition-colors hover:text-foreground"
                      >
                        <Info className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[240px]">
                      Emits a $feature_flag_called event on each read, powering experiment and
                      adoption analytics. Leave off for plain operational gates.
                    </TooltipContent>
                  </UiTooltip>
                </div>
                <p className="text-[10px] leading-snug text-muted-foreground">
                  {trackPinned
                    ? 'Required while an experiment uses this flag.'
                    : 'Drives experiment / adoption analytics. Not needed for plain gates.'}
                </p>
              </div>
              {trackPinned ? (
                <UiTooltip>
                  <TooltipTrigger asChild>
                    <div className="shrink-0">
                      <Switch id="flag-track" checked disabled aria-label="Track exposures" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>required while an experiment uses this flag</TooltipContent>
                </UiTooltip>
              ) : (
                <Switch
                  id="flag-track"
                  className="shrink-0"
                  checked={currentFlag.track}
                  disabled={!canWriteFlags || updateFlag.isPending}
                  onCheckedChange={onTrackChange}
                  aria-label="Track exposures"
                />
              )}
            </div>

            <div className="-mx-8 flex gap-0 overflow-x-auto border-b border-border px-8">
              {DETAIL_TABS.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    '-mb-px shrink-0 border-b-2 px-4 py-2.5 text-xs font-medium transition-colors',
                    tab === t.id
                      ? 'border-primary text-primary'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </>
        ) : notConfigured ? (
          <div className="flex flex-col items-center justify-center gap-3 border-b border-border py-16 text-center">
            <Flag className="h-8 w-8 text-muted-foreground/30" />
            <div>
              <div className="text-sm font-medium text-foreground">Not configured in {envTab}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                <span className="font-mono">{flagKey}</span> has no config for this environment yet.
              </div>
            </div>
            {canWriteFlags && (
              <button
                type="button"
                onClick={() => setCreatingInEnv(true)}
                className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                <Plus className="h-3.5 w-3.5" />
                Create in {envTab}
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 border-b border-border py-16 text-center">
            <Flag className="h-8 w-8 text-muted-foreground/30" />
            <div className="text-sm font-medium text-foreground">Failed to load flag</div>
            <div className="text-[11px] text-muted-foreground">
              {flagQuery.error?.message ?? 'Unknown error'}
            </div>
          </div>
        )}
      </div>

      {/* ── Tab content ── */}
      {currentFlag && projectId && (
        <div className="flex-1 overflow-auto px-8 py-6">
          {tab === 'metrics' && <MetricsTab projectId={projectId} flag={currentFlag} />}
          {tab === 'targeting' && (
            <TargetingTab projectId={projectId} flag={currentFlag} canEdit={canWriteFlags} />
          )}
          {tab === 'history' && <HistoryTab projectId={projectId} flagId={currentFlag.id} />}
        </div>
      )}

      {creatingInEnv && projectId && (
        <NewFlagDialog
          projectId={projectId}
          initialKey={flagKey}
          lockKey
          initialEnv={envTab}
          lockEnv
          onClose={() => setCreatingInEnv(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  )
}

// ── Metrics ──────────────────────────────────────────────────────────────────

function MetricsTab({ projectId, flag }: { projectId: string; flag: FeatureFlagRow }) {
  const [rangeKey, setRangeKey] = useState<RangeKey>('30d')
  const range = useMemo(() => rangeFromKey(rangeKey), [rangeKey])
  const interval = intervalForKey(rangeKey)

  const usage = trpc.events.flagUsage.useQuery(
    { projectId, key: flag.key, range, interval, env: flag.env },
    { enabled: !!projectId },
  )
  const topUsers = trpc.events.flagTopUsers.useQuery(
    { projectId, key: flag.key, range, limit: 10, env: flag.env },
    { enabled: !!projectId },
  )

  const data = usage.data
  const calls = data?.calls ?? 0
  const uniqueUsers = data?.uniqueUsers ?? 0

  const trueCalls = useMemo(
    () => data?.byResponse.find((r) => r.response === 'true')?.calls ?? 0,
    [data],
  )
  const falseCalls = useMemo(
    () => data?.byResponse.find((r) => r.response === 'false')?.calls ?? 0,
    [data],
  )
  const totalResp = trueCalls + falseCalls

  // Pivot trendByResponse → [{ bucket, true, false }]
  const series = useMemo(() => {
    const byBucket = new Map<string, { bucket: string; true: number; false: number }>()
    for (const r of data?.trendByResponse ?? []) {
      const row = byBucket.get(r.bucket) ?? { bucket: r.bucket, true: 0, false: 0 }
      if (r.response === 'true') row.true += r.calls
      else row.false += r.calls
      byBucket.set(r.bucket, row)
    }
    return [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))
  }, [data])

  const pct = (n: number) => (totalResp > 0 ? `${((n / totalResp) * 100).toFixed(1)}%` : '—')

  // `isPending`, not `isLoading` — changing the range refetches with data already on screen and
  // must not collapse the tab back to a skeleton.
  if (usage.isPending) {
    return <MetricsTabSkeleton />
  }

  return (
    <div className="w-full space-y-5">
      <div className="flex items-center justify-end">
        <RangeFilter value={rangeKey} onChange={setRangeKey} />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label={`Evaluations (${rangeKey})`}
          value={calls > 0 ? formatNumber(calls) : '0'}
          sub={flag.active ? 'active' : 'flag disabled'}
        />
        <KpiCard label="Unique users" value={formatNumber(uniqueUsers)} sub="identified users" />
        <KpiCard
          label="Returning true"
          value={pct(trueCalls)}
          sub={`${formatNumber(trueCalls)} evals`}
        />
        <KpiCard
          label="Returning false"
          value={pct(falseCalls)}
          sub={`${formatNumber(falseCalls)} evals`}
        />
      </div>

      {/* Chart */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-foreground">Evaluations over time</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {rangeKey} window · true vs false
            </div>
          </div>
          <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-[2px] w-2 rounded bg-teal-400" />
              True
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-[2px] w-2 rounded bg-muted-foreground/40" />
              False
            </span>
          </div>
        </div>
        {series.length === 0 ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            No evaluations in this range.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={series} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="flagTrueGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#2DD4BF" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#2DD4BF" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="flagFalseGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6B6B8A" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#6B6B8A" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis
                dataKey="bucket"
                tick={{ fontSize: 10, fill: '#6B6B8A' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: string) => formatDate(v)}
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#6B6B8A' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`)}
              />
              <Tooltip content={<ChartTooltip />} />
              <Area
                type="monotone"
                dataKey="true"
                stroke="#2DD4BF"
                strokeWidth={1.5}
                fill="url(#flagTrueGrad)"
                dot={false}
                name="True"
              />
              <Area
                type="monotone"
                dataKey="false"
                stroke="#6B6B8A"
                strokeWidth={1}
                fill="url(#flagFalseGrad)"
                dot={false}
                name="False"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Split + top users */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
        {/* Split */}
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="text-sm font-medium text-foreground">Evaluation split</div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {formatNumber(totalResp)} total
            </div>
          </div>
          {totalResp > 0 ? (
            <>
              <div className="mb-3 flex h-4 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-l-full bg-teal-400 transition-all duration-700"
                  style={{ width: `${(trueCalls / totalResp) * 100}%` }}
                />
                <div className="h-full flex-1 bg-muted-foreground/20" />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-lg border border-teal-500/15 bg-teal-500/5 p-3">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-teal-400/70">
                    True
                  </div>
                  <div className="font-mono text-xl font-semibold text-teal-400">
                    {pct(trueCalls)}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {formatNumber(trueCalls)} evaluations
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    False
                  </div>
                  <div className="font-mono text-xl font-semibold text-foreground">
                    {pct(falseCalls)}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {formatNumber(falseCalls)} evaluations
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center py-8">
              <FlaskConical className="mb-2 h-8 w-8 text-muted-foreground/20" />
              <div className="text-xs text-muted-foreground">No evaluations yet</div>
            </div>
          )}
        </div>

        {/* Top users */}
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3.5">
            <div className="text-sm font-medium text-foreground">Top users</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Most evaluations · by distinct id
            </div>
          </div>
          {(topUsers.data?.length ?? 0) > 0 ? (
            <div className="divide-y divide-border">
              {topUsers.data?.map((u, i) => (
                <div key={u.distinctId} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-4 shrink-0 font-mono text-[10px] text-muted-foreground/50">
                    {i + 1}
                  </span>
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
                    {u.distinctId.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[11px] text-foreground">
                      {u.distinctId}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-xs text-foreground">{formatNumber(u.evals)}</div>
                    <div
                      className={cn(
                        'font-mono text-[10px] font-medium',
                        u.lastResponse === 'true' ? 'text-teal-400' : 'text-muted-foreground/50',
                      )}
                    >
                      {u.lastResponse || '—'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center py-10">
              <div className="text-[11px] text-muted-foreground">No user data yet</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── History ──────────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  created: 'Created',
  updated: 'Updated',
  toggled: 'Toggled',
  deleted: 'Deleted',
}

type FlagAuditDiff = {
  before: { active?: boolean; filters?: unknown } | null
  after: { active?: boolean; filters?: unknown } | null
}

function diffSummary(action: string, diff: unknown): string {
  const d = diff as FlagAuditDiff
  if (action === 'created') return 'Flag created'
  if (action === 'deleted') return 'Flag deleted'
  if (action === 'toggled') {
    return `${d.before?.active ? 'On' : 'Off'} → ${d.after?.active ? 'On' : 'Off'}`
  }
  const activeChanged = d.before?.active !== d.after?.active
  const filtersChanged = JSON.stringify(d.before?.filters) !== JSON.stringify(d.after?.filters)
  const parts: string[] = []
  if (activeChanged)
    parts.push(`${d.before?.active ? 'On' : 'Off'} → ${d.after?.active ? 'On' : 'Off'}`)
  if (filtersChanged) parts.push('Targeting changed')
  return parts.length > 0 ? parts.join(' · ') : 'No changes'
}

function HistoryTab({ projectId, flagId }: { projectId: string; flagId: string }) {
  const historyQuery = trpc.flags.history.useQuery({ projectId, flagId })

  if (historyQuery.isPending) {
    return (
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        {/* 2 columns: action + summary · actor + timestamp */}
        <SkeletonTable rows={5} cols={2} header={false} className="min-w-[420px]" />
      </div>
    )
  }

  const items = historyQuery.data?.items ?? []

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="text-sm font-medium text-muted-foreground">No history yet</div>
        <div className="mt-1 text-[11px] text-muted-foreground/60">
          Changes to this flag will appear here.
        </div>
      </div>
    )
  }

  return (
    <div className="divide-y divide-border rounded-lg border border-border bg-card">
      {items.map((entry) => (
        <div key={entry.id} className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="text-xs font-medium text-foreground">
              {ACTION_LABELS[entry.action] ?? entry.action}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {diffSummary(entry.action, entry.diff)}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-[11px] text-foreground">
              {entry.actor.name ?? entry.actor.email}
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
              {formatTimestamp(entry.createdAt)}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Skeletons ────────────────────────────────────────────────────────────────

/** Mirrors `MetricsTab`: range filter · KPI row · evaluations chart card · split + top-users pair. */
function MetricsTabSkeleton() {
  return (
    <div className="w-full space-y-5">
      <div className="flex items-center justify-end">
        <Skeleton className="h-7 w-40" />
      </div>
      <SkeletonStatRow count={4} />
      <div className="rounded-lg border border-border bg-card p-5">
        <Skeleton className="mb-4 h-4 w-40" />
        <SkeletonChart height={200} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
        <SkeletonCard lines={3} />
        <SkeletonCard lines={4} />
      </div>
    </div>
  )
}

/**
 * Page shell for the cold load. The page assembles several independent queries —
 * environments, flag, metrics — so without one composed shell it arrives as N unsynchronized
 * islands. Mirrors the real grid: header (back link · env tabs · title block) + tab bar + the
 * metrics tab's stat row, chart, and table.
 */
function FlagDetailSkeleton() {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="shrink-0 px-8 pb-0 pt-6">
        {/* Back link */}
        <Skeleton className="mb-4 h-3 w-24" />
        {/* Environment tabs */}
        <Skeleton className="mb-4 h-9 w-64" />

        {/* Title block: toggle + name/key/badges · modified + default */}
        <div className="mb-5 flex flex-col justify-between gap-6 sm:flex-row sm:items-start">
          <div className="flex items-start gap-4">
            <Skeleton className="mt-1 h-6 w-11 rounded-full" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-3 w-32" />
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-16" />
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:items-end">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-2 h-3 w-12" />
            <Skeleton className="h-5 w-16" />
          </div>
        </div>

        {/* Tab bar */}
        <div className="-mx-8 flex gap-6 border-b border-border px-8 pb-2.5 pt-1">
          {DETAIL_TABS.map((t) => (
            <Skeleton key={t.id} className="h-4 w-16" />
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">
        <MetricsTabSkeleton />
      </div>
    </div>
  )
}
