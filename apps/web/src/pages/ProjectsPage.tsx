import { AlertTriangle, Check, Copy, FolderKanban, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonTable } from '@/components/skeletons'
import { track } from '@/lib/analytics'
import { formatDate } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { setProjectId, useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'

type Project = {
  id: string
  name: string
  timezone: string
  domain: string | null
  dataRetentionDays: number
  createdAt: string
}

const TIMEZONE_OPTIONS = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
]

// ── Confirm dialog for destructive actions ────────────────────────────────────

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pending,
  onConfirm,
  onCancel,
}: {
  title: string
  body: string
  confirmLabel: string
  pending?: boolean
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
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Create / edit slide-over ───────────────────────────────────────────────────

function ProjectPanel({
  project,
  onClose,
  onSaved,
}: {
  project: Project | null
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!project
  const [name, setName] = useState(project?.name ?? '')
  const [timezone, setTimezone] = useState(project?.timezone ?? 'UTC')
  const [domain, setDomain] = useState(project?.domain ?? '')
  const [error, setError] = useState('')

  const create = trpc.projects.create.useMutation()
  const update = trpc.projects.update.useMutation()
  const pending = create.isPending || update.isPending

  async function handleSave() {
    if (!name.trim()) {
      setError('Project name is required.')
      return
    }
    setError('')
    try {
      if (isEdit) {
        await update.mutateAsync({
          id: project.id,
          name: name.trim(),
          timezone,
          domain: domain.trim() ? domain.trim() : null,
        })
        toast.success('Project updated')
      } else {
        const created = await create.mutateAsync({ name: name.trim() })
        track('project_created', { project_id: created.id })
        toast.success('Project created')
      }
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save project')
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div className="relative ml-auto flex h-full w-full flex-col border-l border-border bg-card shadow-2xl shadow-black/40 md:max-w-[420px]">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/15">
              <FolderKanban className="h-3.5 w-3.5 text-primary" />
            </div>
            <span className="text-sm font-semibold text-foreground">
              {isEdit ? 'Edit project' : 'New project'}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-auto p-5">
          <div>
            <label
              htmlFor="project-name"
              className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
            >
              Project name
            </label>
            <input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. acme.co, Mobile App"
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs text-foreground transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/60"
            />
          </div>

          {isEdit && project && (
            <div>
              <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
                Project ID
              </span>
              <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
                {project.id}
              </div>
            </div>
          )}

          {isEdit && (
            <>
              <div>
                <label
                  htmlFor="project-domain"
                  className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
                >
                  Domain
                </label>
                <input
                  id="project-domain"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="https://acme.co"
                  className="w-full rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs text-foreground transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/60"
                />
              </div>

              <div>
                <span className="mb-2 block text-[11px] font-medium text-muted-foreground">
                  Timezone
                </span>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="w-full rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs text-foreground transition-colors focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/60"
                >
                  {TIMEZONE_OPTIONS.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {error && <p className="text-[11px] font-medium text-red-400">{error}</p>}
        </div>

        <div className="flex shrink-0 gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="flex-1 rounded-md border border-border py-2 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={pending}
            className="flex-1 rounded-md bg-primary py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function ProjectsPage() {
  const { can } = useAuth()
  const canManageProjects = can('projects:manage')
  const activeProjectId = useProjectId()
  const utils = trpc.useUtils()
  const projectsQuery = trpc.projects.list.useQuery()
  const del = trpc.projects.delete.useMutation()

  const [panel, setPanel] = useState<'create' | Project | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const projects = projectsQuery.data ?? []

  async function copyId(id: string) {
    await navigator.clipboard.writeText(id)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  async function handleDelete(project: Project) {
    try {
      await del.mutateAsync({ id: project.id })
      await utils.projects.list.invalidate()
      if (project.id === activeProjectId) {
        const remaining = projects.filter((p) => p.id !== project.id)
        if (remaining[0]) setProjectId(remaining[0].id)
      }
      toast.success('Project deleted')
      setConfirmDelete(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete project')
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        title="Projects"
        subtitle={`${projects.length} project${projects.length !== 1 ? 's' : ''}`}
      >
        {canManageProjects && (
          <button
            type="button"
            onClick={() => setPanel('create')}
            className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            New project
          </button>
        )}
      </PageHeader>

      <div className="flex-1 overflow-auto">
        {projectsQuery.isPending ? (
          <div className="overflow-x-auto">
            <SkeletonTable rows={4} cols={canManageProjects ? 7 : 6} className="p-5" />
          </div>
        ) : projectsQuery.error ? (
          <div className="m-5 flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <div className="text-sm font-medium text-red-400">Failed to load projects</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {projectsQuery.error.message}
              </div>
            </div>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <FolderKanban className="mb-3 h-8 w-8 text-muted-foreground/30" />
            <div className="text-sm font-medium text-muted-foreground">No projects yet</div>
            <div className="mt-1 text-[11px] text-muted-foreground/60">
              Create your first project to start tracking events.
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-background">
                <tr className="border-b border-border">
                  {[
                    'Name',
                    'Project ID',
                    'Timezone',
                    'Domain',
                    'Created',
                    ...(canManageProjects ? [''] : []),
                  ].map((h) => (
                    <th
                      key={h}
                      className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {projects.map((project: Project) => (
                  <tr
                    key={project.id}
                    className="border-b border-border/50 transition-colors hover:bg-muted/20"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div
                          className={cn(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            project.id === activeProjectId
                              ? 'bg-teal-400'
                              : 'bg-muted-foreground/40',
                          )}
                        />
                        <span className="whitespace-nowrap font-medium text-foreground">
                          {project.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => copyId(project.id)}
                        className="flex items-center gap-1.5 font-mono text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {copiedId === project.id ? (
                          <Check className="h-3 w-3 text-teal-400" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                        {project.id.slice(0, 14)}…
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {project.timezone}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {project.domain ?? <span className="text-muted-foreground/40">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {formatDate(project.createdAt)}
                    </td>
                    {canManageProjects && (
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setPanel(project)}
                            title="Edit project"
                            className="rounded p-1.5 text-muted-foreground/60 transition-colors hover:bg-primary/10 hover:text-primary"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(project)}
                            title="Delete project"
                            className="rounded p-1.5 text-muted-foreground/60 transition-colors hover:bg-red-500/10 hover:text-red-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {panel && (
        <ProjectPanel
          project={panel === 'create' ? null : panel}
          onClose={() => setPanel(null)}
          onSaved={async () => {
            await utils.projects.list.invalidate()
            setPanel(null)
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Permanently delete this project?"
          body={`This deletes "${confirmDelete.name}" and all its events, sessions, API keys, and configuration. This cannot be undone.`}
          confirmLabel="Delete forever"
          pending={del.isPending}
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}
