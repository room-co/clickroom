import { AlertTriangle, BarChart3, MessageSquareText, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonTable } from '@/components/skeletons'
import { Badge } from '@/components/ui/badge'
import { formatTimestamp } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'
import { defaultEnvKey, useEnvironments } from '../flags/types'
import { NewSurveyDialog } from './NewSurveyDialog'
import { STATUS_BADGE, type SurveyDefinitionUI, type SurveyRow } from './types'

const TABLE_HEADERS = ['Name', 'Status', 'Questions', 'Linked flag', 'Modified', ''] as const

export function SurveysPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const location = useLocation()
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canManage = can('projects:manage')

  const [search, setSearch] = useState('')
  // `/surveys/new` opens the create dialog over the list (there is no dedicated
  // create page — the builder is edit-only). Closing routes back to `/surveys`.
  const creating = location.pathname.endsWith('/new')
  const [confirm, setConfirm] = useState<SurveyRow | null>(null)

  const surveysQuery = trpc.surveys.list.useQuery(
    { projectId: projectId as string },
    { enabled: !!projectId },
  )
  const del = trpc.surveys.delete.useMutation()

  // Resolve linked-flag keys (survey rows only carry `featureFlagId`).
  const environmentsQuery = useEnvironments(projectId)
  const environments = useMemo(() => environmentsQuery.data ?? [], [environmentsQuery.data])
  const env = defaultEnvKey(environments) ?? ''
  const flagsQuery = trpc.flags.list.useQuery(
    { projectId: projectId as string, env },
    { enabled: !!projectId && !!env },
  )
  const flagById = useMemo(() => {
    const rows = (flagsQuery.data ?? []) as unknown as { id: string; key: string; env: string }[]
    return new Map(rows.map((f) => [f.id, f]))
  }, [flagsQuery.data])

  const surveys = useMemo<SurveyRow[]>(
    () => (surveysQuery.data ?? []) as unknown as SurveyRow[],
    [surveysQuery.data],
  )
  const activeCount = surveys.filter((s) => s.status === 'active').length

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return surveys
    return surveys.filter((s) => s.name.toLowerCase().includes(q))
  }, [surveys, search])

  async function handleDelete(survey: SurveyRow) {
    if (!projectId) return
    try {
      await del.mutateAsync({ projectId, id: survey.id })
      await utils.surveys.list.invalidate()
      toast.success('Survey deleted')
      setConfirm(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete survey')
    }
  }

  if (!projectId) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <PageHeader title="Surveys" subtitle="No project selected" />
        <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
          <MessageSquareText className="mb-3 h-8 w-8 text-muted-foreground/30" />
          <div className="text-sm font-medium text-muted-foreground">No project selected</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader title="Surveys" subtitle={`${activeCount} active · ${surveys.length} total`}>
        {canManage && (
          <button
            type="button"
            onClick={() => navigate('/surveys/new')}
            className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            New Survey
          </button>
        )}
      </PageHeader>

      <div className="shrink-0 border-b border-border px-5 py-2.5">
        <div className="relative max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search surveys..."
            className="w-full rounded border border-border bg-muted/30 py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {surveysQuery.isPending ? (
          <div className="overflow-x-auto">
            <SkeletonTable rows={6} cols={TABLE_HEADERS.length} className="min-w-[720px] p-5" />
          </div>
        ) : surveysQuery.error ? (
          <div className="m-5 flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <div className="text-sm font-medium text-red-400">Failed to load surveys</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {surveysQuery.error.message}
              </div>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-xs">
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
                {filtered.map((survey) => {
                  const def = survey.definition as SurveyDefinitionUI | undefined
                  const questionCount = Array.isArray(def?.questions) ? def.questions.length : 0
                  const flag = flagById.get(survey.featureFlagId)
                  return (
                    <tr
                      key={survey.id}
                      onClick={() => navigate(`/surveys/${survey.id}/edit`)}
                      className="group cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/20"
                    >
                      <td className="whitespace-nowrap px-4 py-3 font-medium text-foreground transition-colors group-hover:text-primary">
                        {survey.name}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={STATUS_BADGE[survey.status]} className="capitalize">
                          {survey.status}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        {questionCount}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {flag ? (
                          <Link
                            to={`/flags/${encodeURIComponent(flag.key)}?env=${flag.env}`}
                            onClick={(e) => e.stopPropagation()}
                            className="font-mono text-[11px] text-primary hover:underline"
                          >
                            {flag.key}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-muted-foreground">
                        {formatTimestamp(String(survey.updatedAt))}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Link
                            to={`/surveys/${survey.id}/results`}
                            onClick={(e) => e.stopPropagation()}
                            title="View results"
                            aria-label="View results"
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                          >
                            <BarChart3 className="h-3.5 w-3.5" />
                          </Link>
                          {canManage && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setConfirm(survey)
                              }}
                              title="Delete survey"
                              aria-label="Delete survey"
                              className="rounded p-1 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {filtered.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <MessageSquareText className="mb-3 h-8 w-8 text-muted-foreground/30" />
                <div className="text-sm font-medium text-muted-foreground">No surveys found</div>
                <div className="mt-1 text-[11px] text-muted-foreground/60">
                  {search ? 'Try a different search.' : 'Create your first survey.'}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {creating && (
        <NewSurveyDialog
          projectId={projectId}
          onClose={() => navigate('/surveys')}
          onCreated={(id) => navigate(`/surveys/${id}/edit`)}
        />
      )}
      {confirm && (
        <ConfirmDelete
          name={confirm.name}
          pending={del.isPending}
          onConfirm={() => handleDelete(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

function ConfirmDelete({
  name,
  pending,
  onConfirm,
  onCancel,
}: {
  name: string
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
            <div className="text-sm font-semibold text-foreground">Delete this survey?</div>
            <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">{name}</span> and its linked flag will
              be removed. This cannot be undone.
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
