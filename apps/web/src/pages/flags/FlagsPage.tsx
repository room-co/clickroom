import { AlertTriangle, Flag, MoreHorizontal, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { EnvironmentTabs } from '@/components/EnvironmentTabs'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonTable } from '@/components/skeletons'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useFlagsStream } from '@/hooks/useFlagsStream'
import { track } from '@/lib/analytics'
import { formatTimestamp } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'
import { EnvBadge, type FeatureFlagRow, FlagToggle, KindBadge } from './FlagBits'
import { FlagsOverviewTab } from './FlagsOverviewTab'
import { NewFlagDialog } from './NewFlagDialog'
import {
  defaultEnvKey,
  type Environment,
  type FlagEnv,
  rolloutSummary,
  toFlagFilters,
  useEnvironments,
} from './types'

type FlagsView = 'list' | 'overview'
const FLAGS_VIEWS: readonly FlagsView[] = ['list', 'overview']

/** `?view=` is valid to land on directly; anything else falls back to 'list'. */
function parseViewParam(raw: string | null): FlagsView {
  return raw && (FLAGS_VIEWS as readonly string[]).includes(raw) ? (raw as FlagsView) : 'list'
}

/** `?env=` is valid to land on directly (if it names a real environment);
 * anything else falls back to the project's `isDefault` environment. */
function parseEnvParam(raw: string | null, environments: Environment[]): FlagEnv {
  if (raw && environments.some((e) => e.key === raw)) return raw
  return defaultEnvKey(environments) ?? raw ?? ''
}

const TABLE_HEADERS = [
  '',
  'Name',
  'Key',
  'Kind',
  'Targeting',
  'Environment',
  'Tags',
  'Modified',
  '',
] as const

export function FlagsPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canWriteFlags = can('flags:write')
  const [searchParams, setSearchParams] = useSearchParams()
  const view = parseViewParam(searchParams.get('view'))
  const environmentsQuery = useEnvironments(projectId)
  const environments = useMemo(() => environmentsQuery.data ?? [], [environmentsQuery.data])
  const env = parseEnvParam(searchParams.get('env'), environments)
  useFlagsStream(projectId)

  function setView(next: FlagsView) {
    // replace (not push) — switching a subtab is a filter change, not new
    // navigation history; keeps back/forward from stepping through every tab.
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        params.set('view', next)
        return params
      },
      { replace: true },
    )
  }

  function setEnv(next: FlagEnv) {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        params.set('env', next)
        return params
      },
      { replace: true },
    )
  }

  const flagsQuery = trpc.flags.list.useQuery(
    { projectId: projectId as string, env },
    { enabled: !!projectId && !!env },
  )
  const toggle = trpc.flags.toggle.useMutation()
  const del = trpc.flags.delete.useMutation()

  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState<FeatureFlagRow | null>(null)

  const flags = useMemo<FeatureFlagRow[]>(
    () => (flagsQuery.data ?? []) as unknown as FeatureFlagRow[],
    [flagsQuery.data],
  )
  const envColorByKey = useMemo(
    () => Object.fromEntries(environments.map((e) => [e.key, e.color])),
    [environments],
  )
  const activeCount = flags.filter((f) => f.active).length

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return flags
    return flags.filter(
      (f) => f.key.toLowerCase().includes(q) || (f.name?.toLowerCase().includes(q) ?? false),
    )
  }, [flags, search])

  function openFlag(flag: FeatureFlagRow) {
    navigate(`/flags/${encodeURIComponent(flag.key)}?env=${flag.env}`)
  }

  async function handleToggle(flag: FeatureFlagRow, active: boolean) {
    if (!projectId) return
    try {
      await toggle.mutateAsync({ projectId, id: flag.id, active })
      track('flag_toggled', { flag_key: flag.key, environment: flag.env, enabled: active })
      await utils.flags.list.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle flag')
    }
  }

  async function handleDelete(flag: FeatureFlagRow) {
    if (!projectId) return
    try {
      await del.mutateAsync({ projectId, id: flag.id })
      await utils.flags.list.invalidate()
      toast.success('Flag deleted')
      setConfirm(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete flag')
    }
  }

  if (!projectId) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <PageHeader title="Feature Flags" subtitle="No project selected" />
        <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
          <Flag className="mb-3 h-8 w-8 text-muted-foreground/30" />
          <div className="text-sm font-medium text-muted-foreground">No project selected</div>
          <div className="mt-1 text-[11px] text-muted-foreground/60">
            Select a project to manage its feature flags.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader title="Feature Flags" subtitle={`${activeCount} active · ${flags.length} total`}>
        {canWriteFlags && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            New Flag
          </button>
        )}
      </PageHeader>

      {/* Subtabs — grouped in one sticky block so they stick together as a unit
          without either bar needing to know the other's height. */}
      <div className="sticky top-0 z-20 shrink-0 bg-background">
        {/* View switcher */}
        <div className="border-b border-border px-5 py-2">
          <div className="overflow-x-auto">
            <Tabs value={view} onValueChange={(v) => setView(v as FlagsView)}>
              <TabsList className="w-max">
                <TabsTrigger value="list" className="min-w-[84px] shrink-0">
                  List
                </TabsTrigger>
                <TabsTrigger value="overview" className="min-w-[84px] shrink-0">
                  Overview
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        {/* Environment switcher — only meaningful for the List view */}
        {view === 'list' && (
          <EnvironmentTabs
            environments={environments}
            value={env}
            onValueChange={(v) => setEnv(v as FlagEnv)}
          />
        )}
      </div>

      {view === 'overview' ? (
        <div className="flex-1 overflow-auto">
          <FlagsOverviewTab projectId={projectId} />
        </div>
      ) : (
        <>
          {/* Search */}
          <div className="shrink-0 border-b border-border px-5 py-2.5">
            <div className="relative max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search flags..."
                className="w-full rounded border border-border bg-muted/30 py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>
          </div>

          {/* Table / states */}
          <div className="flex-1 overflow-auto">
            {flagsQuery.isPending ? (
              <div className="overflow-x-auto">
                <SkeletonTable rows={6} cols={TABLE_HEADERS.length} className="min-w-[900px] p-5" />
              </div>
            ) : flagsQuery.error ? (
              <div className="m-5 flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                <div>
                  <div className="text-sm font-medium text-red-400">
                    Failed to load feature flags
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {flagsQuery.error.message}
                  </div>
                </div>
              </div>
            ) : (
              <>
                <table className="w-full border-collapse text-xs">
                  <thead className="sticky top-0 z-10 bg-background">
                    <tr className="border-b border-border">
                      {TABLE_HEADERS.map((h, i) => (
                        <th
                          // biome-ignore lint/suspicious/noArrayIndexKey: static header cells
                          key={i}
                          className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((flag) => (
                      <tr
                        key={flag.id}
                        onClick={() => openFlag(flag)}
                        className="group cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/20"
                      >
                        {/* Toggle */}
                        <td className="px-4 py-3">
                          <FlagToggle
                            size="sm"
                            enabled={flag.active}
                            onToggle={() => handleToggle(flag, !flag.active)}
                            disabled={!canWriteFlags}
                          />
                        </td>
                        {/* Name */}
                        <td className="whitespace-nowrap px-4 py-3 font-medium text-foreground transition-colors group-hover:text-primary">
                          {flag.name ?? flag.key}
                        </td>
                        {/* Key */}
                        <td className="whitespace-nowrap px-4 py-3 font-mono text-muted-foreground">
                          {flag.key}
                        </td>
                        {/* Kind */}
                        <td className="px-4 py-3">
                          <KindBadge filters={toFlagFilters(flag.filters)} />
                        </td>
                        {/* Targeting */}
                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                          {rolloutSummary(flag.filters)}
                        </td>
                        {/* Environment */}
                        <td className="px-4 py-3">
                          <EnvBadge env={flag.env} color={envColorByKey[flag.env]} />
                        </td>
                        {/* Tags */}
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {flag.tags.map((tag) => (
                              <span
                                key={tag}
                                className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        </td>
                        {/* Modified */}
                        <td className="whitespace-nowrap px-4 py-3 font-mono text-muted-foreground">
                          {formatTimestamp(flag.updatedAt)}
                        </td>
                        {/* Actions */}
                        <td className="px-4 py-3">
                          {canWriteFlags && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setConfirm(flag)
                              }}
                              title="Delete flag"
                              className="rounded p-1 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400"
                              aria-label="Delete flag"
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {filtered.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    <Flag className="mb-3 h-8 w-8 text-muted-foreground/30" />
                    <div className="text-sm font-medium text-muted-foreground">No flags found</div>
                    <div className="mt-1 text-[11px] text-muted-foreground/60">
                      {search ? 'Try a different search.' : 'Create your first feature flag.'}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* Overlays */}
      {creating && (
        <NewFlagDialog
          projectId={projectId}
          initialEnv={env}
          onClose={() => setCreating(false)}
          onCreated={() => setCreating(false)}
        />
      )}
      {confirm && (
        <ConfirmDelete
          flagKey={confirm.key}
          pending={del.isPending}
          onConfirm={() => handleDelete(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

// ── Delete confirmation ──────────────────────────────────────────────────────

function ConfirmDelete({
  flagKey,
  pending,
  onConfirm,
  onCancel,
}: {
  flagKey: string
  pending: boolean
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
            <div className="text-sm font-semibold text-foreground">Delete this flag?</div>
            <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-mono text-foreground">{flagKey}</span> will stop evaluating for
              all SDKs. This cannot be undone.
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-1.5">
              <Trash2 className="h-3.5 w-3.5" />
              {pending ? 'Deleting…' : 'Delete forever'}
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
