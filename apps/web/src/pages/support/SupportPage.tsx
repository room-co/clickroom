import { AlertTriangle, Inbox, LifeBuoy, Plus, Search, Trash2 } from 'lucide-react'
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
import { NewSupportFormDialog } from './NewSupportFormDialog'
import {
  CHANNEL_LABELS,
  STATUS_BADGE,
  type SupportDefinitionUI,
  type SupportFormRow,
} from './types'

const TABLE_HEADERS = [
  'Name',
  'Status',
  'Channel',
  'Fields',
  'Linked flag',
  'Modified',
  '',
] as const

export function SupportPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const location = useLocation()
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canManage = can('projects:manage')

  const [search, setSearch] = useState('')
  // `/support/new` opens the create dialog over the list (there is no dedicated
  // create page — the builder is edit-only). Closing routes back to `/support`.
  const creating = location.pathname.endsWith('/new')
  const [confirm, setConfirm] = useState<SupportFormRow | null>(null)

  const formsQuery = trpc.support.list.useQuery(
    { projectId: projectId as string },
    { enabled: !!projectId },
  )
  const del = trpc.support.delete.useMutation()

  // Resolve linked-flag keys (form rows only carry `featureFlagId`).
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

  const forms = useMemo<SupportFormRow[]>(
    () => (formsQuery.data ?? []) as unknown as SupportFormRow[],
    [formsQuery.data],
  )
  const activeCount = forms.filter((f) => f.status === 'active').length

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return forms
    return forms.filter((f) => f.name.toLowerCase().includes(q))
  }, [forms, search])

  async function handleDelete(form: SupportFormRow) {
    if (!projectId) return
    try {
      await del.mutateAsync({ projectId, id: form.id })
      await utils.support.list.invalidate()
      toast.success('Support form deleted')
      setConfirm(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete support form')
    }
  }

  if (!projectId) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <PageHeader title="Support" subtitle="No project selected" />
        <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
          <LifeBuoy className="mb-3 h-8 w-8 text-muted-foreground/30" />
          <div className="text-sm font-medium text-muted-foreground">No project selected</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader title="Support" subtitle={`${activeCount} active · ${forms.length} total`}>
        {canManage && (
          <button
            type="button"
            onClick={() => navigate('/support/new')}
            className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            New Form
          </button>
        )}
      </PageHeader>

      <div className="shrink-0 border-b border-border px-5 py-2.5">
        <div className="relative max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search support forms..."
            className="w-full rounded border border-border bg-muted/30 py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {formsQuery.isPending ? (
          <div className="overflow-x-auto">
            <SkeletonTable rows={6} cols={TABLE_HEADERS.length} className="min-w-[820px] p-5" />
          </div>
        ) : formsQuery.error ? (
          <div className="m-5 flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <div className="text-sm font-medium text-red-400">Failed to load support forms</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {formsQuery.error.message}
              </div>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-xs">
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
                {filtered.map((form) => {
                  const def = form.definition as SupportDefinitionUI | undefined
                  const fieldCount = Array.isArray(def?.fields) ? def.fields.length : 0
                  const channel = def?.channel ?? 'contact'
                  const flag = flagById.get(form.featureFlagId)
                  return (
                    <tr
                      key={form.id}
                      onClick={() => navigate(`/support/${form.id}/edit`)}
                      className="group cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/20"
                    >
                      <td className="whitespace-nowrap px-4 py-3 font-medium text-foreground transition-colors group-hover:text-primary">
                        {form.name}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={STATUS_BADGE[form.status]} className="capitalize">
                          {form.status}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        {CHANNEL_LABELS[channel] ?? channel}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        {fieldCount}
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
                        {formatTimestamp(String(form.updatedAt))}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Link
                            to={`/support/${form.id}/inbox`}
                            onClick={(e) => e.stopPropagation()}
                            title="Open inbox"
                            aria-label="Open inbox"
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                          >
                            <Inbox className="h-3.5 w-3.5" />
                          </Link>
                          {canManage && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setConfirm(form)
                              }}
                              title="Delete support form"
                              aria-label="Delete support form"
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
                <LifeBuoy className="mb-3 h-8 w-8 text-muted-foreground/30" />
                <div className="text-sm font-medium text-muted-foreground">
                  No support forms found
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground/60">
                  {search ? 'Try a different search.' : 'Create your first support form.'}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {creating && (
        <NewSupportFormDialog
          projectId={projectId}
          onClose={() => navigate('/support')}
          onCreated={(id) => navigate(`/support/${id}/edit`)}
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
            <div className="text-sm font-semibold text-foreground">Delete this support form?</div>
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
