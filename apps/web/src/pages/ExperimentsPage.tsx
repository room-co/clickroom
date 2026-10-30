import { AlertTriangle, FlaskConical, Pencil, Plus, Trash2, TrendingUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { EnvironmentTabs } from '@/components/EnvironmentTabs'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonTable } from '@/components/skeletons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatTimestamp } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'
import { defaultEnvKey, type Environment, type FlagEnv, useEnvironments } from './flags/types'

type ExperimentStatus = 'draft' | 'running' | 'complete' | 'archived'

type ExperimentRow = {
  id: string
  name: string
  status: ExperimentStatus
  updatedAt: string
}

const statusVariant: Record<ExperimentStatus, 'default' | 'secondary' | 'outline' | 'destructive'> =
  {
    draft: 'outline',
    running: 'default',
    complete: 'secondary',
    archived: 'destructive',
  }

function StatusBadge({ status }: { status: ExperimentStatus }) {
  return (
    <Badge variant={statusVariant[status] ?? 'outline'} className="capitalize">
      {status}
    </Badge>
  )
}

/** `?env=` is valid to land on directly (if it names a real environment);
 * anything else falls back to the project's `isDefault` environment. */
function parseEnvParam(raw: string | null, environments: Environment[]): FlagEnv {
  if (raw && environments.some((e) => e.key === raw)) return raw
  return defaultEnvKey(environments) ?? raw ?? ''
}

export function ExperimentsPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canManageProjects = can('projects:manage')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const environmentsQuery = useEnvironments(projectId)
  const environments = useMemo(() => environmentsQuery.data ?? [], [environmentsQuery.data])
  const env = parseEnvParam(searchParams.get('env'), environments)
  const enabled = !!projectId

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

  const experimentsQuery = trpc.experiments.list.useQuery(
    { projectId: projectId as string, env },
    { enabled: enabled && !!env },
  )
  const del = trpc.experiments.delete.useMutation()

  const experiments = useMemo<ExperimentRow[]>(
    () => (experimentsQuery.data ?? []) as unknown as ExperimentRow[],
    [experimentsQuery.data],
  )

  async function handleDelete(id: string) {
    if (!projectId) return
    try {
      await del.mutateAsync({ projectId, id })
      await utils.experiments.list.invalidate()
      toast.success('Experiment deleted')
      setDeleteTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete experiment')
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
        title="Experiments"
        subtitle={`${experiments.length} experiment${experiments.length === 1 ? '' : 's'}`}
      >
        {canManageProjects && (
          <Button size="sm" onClick={() => navigate('/experiments/new')}>
            <Plus className="w-3.5 h-3.5" />
            New experiment
          </Button>
        )}
      </PageHeader>

      <EnvironmentTabs environments={environments} value={env} onValueChange={(v) => setEnv(v)} />

      <div className="flex-1 overflow-auto p-4 md:p-6">
        {experimentsQuery.isPending ? (
          <div className="overflow-x-auto rounded-lg border border-border">
            <SkeletonTable rows={5} cols={4} />
          </div>
        ) : experimentsQuery.error ? (
          <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <div className="text-sm font-medium text-red-400">Failed to load experiments</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {experimentsQuery.error.message}
              </div>
            </div>
          </div>
        ) : experiments.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
            <FlaskConical className="mb-3 h-8 w-8 text-muted-foreground/30" />
            <div className="text-sm font-medium text-muted-foreground">No experiments yet</div>
            <div className="mt-1 mb-4 text-[11px] text-muted-foreground/60">
              Create an experiment to test a hypothesis across variants.
            </div>
            {canManageProjects && (
              <Button size="sm" onClick={() => navigate('/experiments/new')}>
                <Plus className="w-3.5 h-3.5" />
                New experiment
              </Button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-background">
                <tr className="border-b border-border">
                  <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Name
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Status
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Updated
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground" />
                </tr>
              </thead>
              <tbody>
                {experiments.map((experiment) => (
                  <tr
                    key={experiment.id}
                    onClick={() => navigate(`/experiments/${experiment.id}/edit`)}
                    className="group cursor-pointer border-b border-border/50 transition-colors last:border-b-0 hover:bg-muted/20"
                  >
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-foreground transition-colors group-hover:text-primary">
                      {experiment.name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <StatusBadge status={experiment.status} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-muted-foreground">
                      {formatTimestamp(experiment.updatedAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-0.5">
                        {(experiment.status === 'running' || experiment.status === 'complete') && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              navigate(`/experiments/${experiment.id}/results`)
                            }}
                            title="View results"
                            className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-foreground"
                          >
                            <TrendingUp className="h-3 w-3" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            navigate(`/experiments/${experiment.id}/edit`)
                          }}
                          title="Edit experiment"
                          className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-foreground"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        {canManageProjects && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setDeleteTarget(experiment.id)
                            }}
                            title="Delete experiment"
                            className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-red-500/10 hover:text-red-400"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this experiment?"
          body={`"${experiments.find((e) => e.id === deleteTarget)?.name}" will be removed. The linked feature flag is not deleted.`}
          confirmLabel="Delete experiment"
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
