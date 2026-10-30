import { AlertTriangle, Pencil, Plus, Trash2, Users2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonTable } from '@/components/skeletons'
import { Button } from '@/components/ui/button'
import { formatTimestamp } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'

type SegmentRow = {
  id: string
  name: string
  description: string | null
  updatedAt: string
}

export function SegmentsPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canManageProjects = can('projects:manage')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const enabled = !!projectId

  const segmentsQuery = trpc.segments.list.useQuery({ projectId: projectId as string }, { enabled })
  const del = trpc.segments.delete.useMutation()

  const segments = useMemo<SegmentRow[]>(
    () => (segmentsQuery.data ?? []) as unknown as SegmentRow[],
    [segmentsQuery.data],
  )

  async function handleDelete(id: string) {
    if (!projectId) return
    try {
      await del.mutateAsync({ projectId, id })
      await utils.segments.list.invalidate()
      toast.success('Segment deleted')
      setDeleteTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete segment')
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
        title="Segments"
        subtitle={`${segments.length} segment${segments.length === 1 ? '' : 's'}`}
      >
        {canManageProjects && (
          <Button size="sm" onClick={() => navigate('/segments/new')}>
            <Plus className="w-3.5 h-3.5" />
            New segment
          </Button>
        )}
      </PageHeader>

      <div className="flex-1 overflow-auto p-4 md:p-6">
        {segmentsQuery.isPending ? (
          <div className="overflow-x-auto rounded-lg border border-border">
            <SkeletonTable rows={5} cols={4} />
          </div>
        ) : segmentsQuery.error ? (
          <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <div className="text-sm font-medium text-red-400">Failed to load segments</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {segmentsQuery.error.message}
              </div>
            </div>
          </div>
        ) : segments.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
            <Users2 className="mb-3 h-8 w-8 text-muted-foreground/30" />
            <div className="text-sm font-medium text-muted-foreground">No segments yet</div>
            <div className="mt-1 mb-4 text-[11px] text-muted-foreground/60">
              Create a segment to group users by behavior or attributes.
            </div>
            {canManageProjects && (
              <Button size="sm" onClick={() => navigate('/segments/new')}>
                <Plus className="w-3.5 h-3.5" />
                New segment
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
                    Description
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Updated
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground" />
                </tr>
              </thead>
              <tbody>
                {segments.map((segment) => (
                  <tr
                    key={segment.id}
                    onClick={() => navigate(`/segments/${segment.id}/edit`)}
                    className="group cursor-pointer border-b border-border/50 transition-colors last:border-b-0 hover:bg-muted/20"
                  >
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-foreground transition-colors group-hover:text-primary">
                      {segment.name}
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-muted-foreground">
                      {segment.description || '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-muted-foreground">
                      {formatTimestamp(segment.updatedAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-0.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            navigate(`/segments/${segment.id}/edit`)
                          }}
                          title="Edit segment"
                          className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-foreground"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        {canManageProjects && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setDeleteTarget(segment.id)
                            }}
                            title="Delete segment"
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
          title="Delete this segment?"
          body={`"${segments.find((s) => s.id === deleteTarget)?.name}" will be removed from your saved segments.`}
          confirmLabel="Delete segment"
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
