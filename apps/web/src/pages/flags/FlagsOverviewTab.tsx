import { BarChart3, Flag } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { RangeFilter } from '@/components/RangeFilter'
import { SkeletonCard, SkeletonStatRow } from '@/components/skeletons'
import { formatNumber } from '@/lib/format'
import { type RangeKey, rangeFromKey } from '@/lib/range'
import { trpc } from '@/lib/trpc'
import { EnvBadge, KpiCard } from './FlagBits'
import { defaultEnvKey, useEnvironments } from './types'

/**
 * Cross-flag "at a glance" view: total/active flag counts, evaluations per
 * env, and a top-flags-by-evaluations leaderboard. Sits alongside the
 * per-env flag list as a separate tab on FlagsPage.
 */
export function FlagsOverviewTab({ projectId }: { projectId: string }) {
  const [rangeKey, setRangeKey] = useState<RangeKey>('30d')
  const range = useMemo(() => rangeFromKey(rangeKey), [rangeKey])
  const navigate = useNavigate()

  const overview = trpc.events.flagsOverview.useQuery(
    { projectId, range },
    { enabled: !!projectId },
  )
  const counts = trpc.flags.counts.useQuery({ projectId }, { enabled: !!projectId })
  const environmentsQuery = useEnvironments(projectId)
  const environments = useMemo(() => environmentsQuery.data ?? [], [environmentsQuery.data])

  const totalFlags = counts.data?.reduce((sum, c) => sum + c.total, 0) ?? 0
  const activeFlags = counts.data?.reduce((sum, c) => sum + c.active, 0) ?? 0
  const totalEvals = overview.data?.totalEvals ?? 0
  const uniqueUsers = overview.data?.uniqueUsers ?? 0

  const envRows = useMemo(() => {
    const evalsByEnv = new Map(overview.data?.byEnv.map((e) => [e.env, e]) ?? [])
    const countsByEnv = new Map(counts.data?.map((c) => [c.env, c]) ?? [])
    const maxCalls = Math.max(1, ...(overview.data?.byEnv.map((e) => e.calls) ?? [0]))
    return environments.map(({ key: env, color }) => ({
      env,
      color,
      calls: evalsByEnv.get(env)?.calls ?? 0,
      users: evalsByEnv.get(env)?.users ?? 0,
      total: countsByEnv.get(env)?.total ?? 0,
      active: countsByEnv.get(env)?.active ?? 0,
      maxCalls,
    }))
  }, [overview.data, counts.data, environments])

  const topFlags = overview.data?.topFlags ?? []
  // First load only — `isPending`, not `isLoading`, so a background refetch of any one of the
  // three queries (e.g. changing the range refetches `overview`) doesn't re-skeleton the tab.
  const isInitialLoad = overview.isPending || counts.isPending || environmentsQuery.isPending

  if (isInitialLoad) {
    return (
      <div className="w-full space-y-5 p-5">
        {/* KPIs */}
        <SkeletonStatRow count={4} />
        {/* Evaluations per env · Top flags */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1fr]">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={5} />
        </div>
      </div>
    )
  }

  return (
    <div className="w-full space-y-5 p-5">
      <div className="flex items-center justify-end">
        <RangeFilter value={rangeKey} onChange={setRangeKey} />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Total flags" value={formatNumber(totalFlags)} sub="across all envs" />
        <KpiCard label="Active flags" value={formatNumber(activeFlags)} sub="currently enabled" />
        <KpiCard
          label={`Evaluations (${rangeKey})`}
          value={formatNumber(totalEvals)}
          sub="all flags, all envs"
        />
        <KpiCard label="Unique users" value={formatNumber(uniqueUsers)} sub="identified users" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1fr]">
        {/* Evaluations per env */}
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="mb-4 text-sm font-medium text-foreground">
            Evaluations per environment
          </div>
          <div className="space-y-4">
            {envRows.map((row) => (
              <div key={row.env}>
                <div className="mb-1.5 flex items-center justify-between">
                  <EnvBadge env={row.env} color={row.color} />
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatNumber(row.calls)} evals · {row.active}/{row.total} active
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-700"
                    style={{ width: `${(row.calls / row.maxCalls) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top flags */}
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3.5">
            <div className="text-sm font-medium text-foreground">Top flags</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">Most evaluations</div>
          </div>
          {topFlags.length > 0 ? (
            <div className="overflow-x-auto">
              <div className="divide-y divide-border">
                {topFlags.map((f, i) => (
                  <button
                    key={f.flagKey}
                    type="button"
                    onClick={() => {
                      const env = defaultEnvKey(environments)
                      navigate(`/flags/${encodeURIComponent(f.flagKey)}${env ? `?env=${env}` : ''}`)
                    }}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/20"
                  >
                    <span className="w-4 shrink-0 font-mono text-[10px] text-muted-foreground/50">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[11px] text-foreground">
                        {f.flagKey}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-xs text-foreground">
                        {formatNumber(f.calls)}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground/50">
                        {formatNumber(f.users)} users
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center py-10">
              <BarChart3 className="mb-2 h-8 w-8 text-muted-foreground/20" />
              <div className="text-[11px] text-muted-foreground">No evaluations yet</div>
            </div>
          )}
        </div>
      </div>

      {totalFlags === 0 && (
        <div className="flex flex-col items-center py-16 text-center">
          <Flag className="mb-3 h-8 w-8 text-muted-foreground/30" />
          <div className="text-sm font-medium text-muted-foreground">No flags yet</div>
          <div className="mt-1 text-[11px] text-muted-foreground/60">
            Create a flag to start seeing metrics here.
          </div>
        </div>
      )}
    </div>
  )
}
