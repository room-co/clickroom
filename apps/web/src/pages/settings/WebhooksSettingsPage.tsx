// Frame `6a`: Settings › Webhooks.
//
// A standalone `/settings/webhooks` route rather than a `?tab=` on
// `SettingsPage`, for two reasons the tab shape cannot serve: frame `6c` opens
// this surface in a NEW TAB from the support builder's routing dropdown (which
// needs a real URL), and delivery history hangs off it as a child route
// (`/settings/webhooks/:webhookId/deliveries`, frame `7a`), which a tab param
// cannot express. `/settings/sso` is the precedent for a Settings surface too
// big for a tab.
//
// The old `?hook=<id>&view=history` deep link that opened the `5b` overlay is
// gone — `View history` is a plain link to the routed page.
//
// Exactly TWO queries back the whole page (constraint 8): one
// `webhooks.list` and one `webhooks.health`. Never a per-webhook `deliveries`
// call — health for every endpoint in the project comes back in a single
// windowed query server-side.
import {
  Ellipsis,
  History,
  Info,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Webhook,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { CopyButton } from '@/components/CopyButton'
import { PageHeader } from '@/components/PageHeader'
import { type HealthTone, StatusDot } from '@/components/StatusDot'
import { SkeletonTable } from '@/components/skeletons'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { formatRelative } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'
import { type SupportWebhookRow, WebhookFormSheet } from './WebhookFormSheet'

/** Failing rows carry the design's red wash — too faint for a Tailwind step. */
const FAILING_ROW_TINT = 'rgba(239,68,68,.04)'

/** The `6a` column template. One source so header and rows cannot drift. */
const COLUMNS = 'grid-cols-[minmax(0,1fr)_210px_92px_108px_84px_32px]'

/** Dates arrive as ISO strings over the wire (no superjson transformer). */
function relativeLabel(value: string | Date | null | undefined): string {
  if (!value) return 'Never'
  return formatRelative(value instanceof Date ? value.toISOString() : value)
}

export function WebhooksSettingsPage() {
  const projectId = useProjectId()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<SupportWebhookRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SupportWebhookRow | null>(null)
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)

  const listQuery = trpc.support.webhooks.list.useQuery(
    { projectId: projectId ?? '' },
    { enabled: !!projectId },
  )
  const healthQuery = trpc.support.webhooks.health.useQuery(
    { projectId: projectId ?? '' },
    { enabled: !!projectId },
  )

  const utils = trpc.useUtils()
  const update = trpc.support.webhooks.update.useMutation()
  const rotate = trpc.support.webhooks.rotateSecret.useMutation()
  const sendTest = trpc.support.webhooks.sendTest.useMutation()
  const remove = trpc.support.webhooks.delete.useMutation()

  const webhooks = (listQuery.data ?? []) as SupportWebhookRow[]
  const healthById = new Map((healthQuery.data ?? []).map((row) => [row.webhookId, row] as const))

  function openCreate() {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(webhook: SupportWebhookRow) {
    setEditing(webhook)
    setFormOpen(true)
  }

  async function toggleActive(webhook: SupportWebhookRow, active: boolean) {
    if (!projectId) return
    try {
      await update.mutateAsync({ projectId, id: webhook.id, patch: { active } })
      await utils.support.webhooks.list.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update webhook')
    }
  }

  async function handleSendTest(webhook: SupportWebhookRow) {
    if (!projectId) return
    try {
      const result = await sendTest.mutateAsync({ projectId, id: webhook.id })
      if (result.status === 'delivered') {
        toast.success(`Test delivered — ${result.code} in ${result.latencyMs}ms`)
      } else {
        toast.error(result.error ?? `Test failed — ${result.code ?? 'no response'}`)
      }
      await utils.support.webhooks.health.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send test')
    }
  }

  async function handleRotate(webhook: SupportWebhookRow) {
    if (!projectId) return
    try {
      const result = await rotate.mutateAsync({ projectId, id: webhook.id })
      await utils.support.webhooks.list.invalidate()
      setRevealedSecret(result.secret)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to rotate secret')
    }
  }

  async function handleDelete() {
    if (!projectId || !deleteTarget) return
    try {
      await remove.mutateAsync({ projectId, id: deleteTarget.id })
      await utils.support.webhooks.list.invalidate()
      setDeleteTarget(null)
      toast.success('Webhook deleted')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete webhook')
    }
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader
        title="Webhooks"
        subtitle="HTTP endpoints that receive support tickets and replies"
      >
        <Button type="button" size="sm" onClick={openCreate} className="text-xs">
          <Plus className="h-3 w-3" />
          New webhook
        </Button>
      </PageHeader>

      <div className="flex-1 p-4 md:p-5">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <div className="min-w-[820px]">
              <div
                className={cn(
                  'grid gap-3.5 border-b border-border px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground md:px-6',
                  COLUMNS,
                )}
              >
                <span>Endpoint</span>
                <span>Events</span>
                <span>Health</span>
                <span>Last delivery</span>
                <span>Status</span>
                <span />
              </div>

              {listQuery.isPending && <SkeletonTable rows={4} cols={6} header={false} />}

              {!listQuery.isPending && webhooks.length === 0 && (
                <div className="px-4 py-10 text-center md:px-6">
                  <Webhook className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" />
                  <div className="text-xs font-medium text-foreground">No webhooks yet</div>
                  <p className="mx-auto mt-1 max-w-sm text-[11px] leading-relaxed text-muted-foreground">
                    Create an endpoint to route new tickets to Slack, your API, or an inbox.
                  </p>
                  <Button type="button" size="sm" onClick={openCreate} className="mt-3 text-[11px]">
                    <Plus className="h-3 w-3" />
                    New webhook
                  </Button>
                </div>
              )}

              {webhooks.map((webhook) => {
                const health = healthById.get(webhook.id)
                const tone = (health?.health ?? 'idle') as HealthTone
                const lastDelivery = health?.lastDeliveryAt ?? webhook.lastDeliveryAt
                return (
                  <div
                    key={webhook.id}
                    className={cn(
                      'grid items-center gap-3.5 border-b border-border/50 px-4 py-3 last:border-0 md:px-6',
                      COLUMNS,
                    )}
                    style={tone === 'failing' ? { backgroundColor: FAILING_ROW_TINT } : undefined}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={cn(
                          'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md',
                          tone === 'failing' ? 'bg-red-500/10' : 'bg-muted',
                        )}
                      >
                        <Webhook
                          className={cn(
                            'h-3.5 w-3.5',
                            tone === 'failing' ? 'text-red-400' : 'text-muted-foreground',
                          )}
                        />
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[12.5px] font-medium text-foreground">
                            {webhook.name || webhook.url}
                          </span>
                          {webhook.autoDisabledAt && (
                            <span className="shrink-0 rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-[10px] text-red-400">
                              Auto-disabled
                            </span>
                          )}
                        </div>
                        <div className="truncate font-mono text-[10.5px] text-muted-foreground">
                          {webhook.url}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1">
                      {webhook.events.map((event) => (
                        <span
                          key={event}
                          className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground"
                        >
                          {event}
                        </span>
                      ))}
                    </div>

                    <StatusDot tone={tone} className="justify-self-start" />

                    <span className="text-[11px] text-muted-foreground">
                      {relativeLabel(lastDelivery)}
                    </span>

                    {/* Inline toggle, no confirm dialog: pausing is reversible and
                        loses nothing — the worker's claim predicate filters on
                        `active`, so deliveries queue rather than drop. */}
                    <Switch
                      checked={webhook.active}
                      onCheckedChange={(next) => toggleActive(webhook, next)}
                      aria-label={`${webhook.active ? 'Pause' : 'Resume'} ${webhook.name || webhook.url}`}
                    />

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Actions for ${webhook.name || webhook.url}`}
                          className="justify-self-end text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <Ellipsis className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem onSelect={() => openEdit(webhook)}>
                          <Pencil className="h-3.5 w-3.5" />
                          Edit
                        </DropdownMenuItem>
                        {/* A real link to frame `7a`'s routed page, in this tab:
                            nothing on this page is unsaved, so navigating away
                            costs nothing and Back returns here. */}
                        <DropdownMenuItem asChild>
                          <Link to={`/settings/webhooks/${webhook.id}/deliveries`}>
                            <History className="h-3.5 w-3.5" />
                            View history
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void handleSendTest(webhook)}>
                          <Send className="h-3.5 w-3.5" />
                          Send test
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void handleRotate(webhook)}>
                          <RefreshCw className="h-3.5 w-3.5" />
                          Rotate secret
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setDeleteTarget(webhook)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="flex items-start gap-2 px-4 py-3 md:px-6">
            <Info className="mt-px h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">
              Every request is signed with{' '}
              <span className="font-mono text-foreground/70">x-clickroom-signature</span>. Failed
              deliveries retry 5× with backoff.
            </span>
          </div>
        </div>
      </div>

      {projectId && (
        <WebhookFormSheet
          projectId={projectId}
          webhook={editing}
          open={formOpen}
          onOpenChange={setFormOpen}
          onSecretRevealed={setRevealedSecret}
        />
      )}

      {projectId && deleteTarget && (
        <DeleteWebhookDialog
          projectId={projectId}
          webhook={deleteTarget}
          pending={remove.isPending}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
        />
      )}

      {revealedSecret && (
        <SecretRevealModal secret={revealedSecret} onClose={() => setRevealedSecret(null)} />
      )}
    </div>
  )
}

/**
 * The delete guard (frames `6c` / last bullet). It lives here rather
 * than in the support builder because this is where deletion happens, but its
 * chips come from `webhooks.affectedForms` — a SEPARATE read, because the
 * dialog has to name the forms BEFORE anything is deleted, and `delete`'s
 * response arrives far too late for that.
 *
 * Deleting deliberately does not cascade into form definitions: the forms keep
 * running and post nowhere, which the copy states plainly instead of implying a
 * cleanup that never happens.
 */
function DeleteWebhookDialog({
  projectId,
  webhook,
  pending,
  onCancel,
  onConfirm,
}: {
  projectId: string
  webhook: SupportWebhookRow
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const formsQuery = trpc.support.webhooks.affectedForms.useQuery({
    projectId,
    id: webhook.id,
  })
  const forms = formsQuery.data ?? []

  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent className="border-red-500/20">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-sm">Delete this webhook?</AlertDialogTitle>
          <AlertDialogDescription className="text-[11.5px] leading-relaxed">
            {forms.length > 0 ? (
              <>
                It is routing tickets for{' '}
                <span className="font-medium text-foreground">
                  {forms.length} support {forms.length === 1 ? 'form' : 'forms'}
                </span>
                . They will keep creating tickets, but nothing will be posted to this endpoint.
              </>
            ) : (
              <>No support form routes at this endpoint. Deleting it affects nothing else.</>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {forms.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {forms.map((form) => (
              <span
                key={form.id}
                className="rounded border border-border bg-muted px-2 py-0.5 text-[10.5px] text-foreground"
              >
                {form.name}
              </span>
            ))}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} className="text-xs">
            Cancel
          </AlertDialogCancel>
          {/* Not `AlertDialogAction`: that closes the dialog on click, which
              would tear the confirm down before the mutation settles. */}
          <Button
            type="button"
            size="sm"
            onClick={onConfirm}
            disabled={pending}
            className="bg-red-500 text-xs text-white hover:bg-red-500/90"
          >
            {pending ? 'Deleting…' : 'Delete anyway'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * The once-only plaintext secret reveal, shown after `create` and after
 * `rotateSecret`.
 *
 * Structure copied from `ApiKeysPage`'s `KeyRevealModal` (hand-rolled overlay,
 * amber "you won't see this again" banner, `select-all break-all font-mono`
 * box) rather than extracted into a shared component — extracting it is an
 * explicit phase non-goal, since that modal is coupled to API-key copy and the
 * generic refactor is bigger than this phase earns.
 */
function SecretRevealModal({ secret, onClose }: { secret: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl shadow-black/50">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-teal-500/15">
              <KeyRound className="h-3.5 w-3.5 text-teal-400" />
            </div>
            <span className="text-sm font-semibold text-foreground">Signing secret</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
          <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
          <p className="text-[11px] leading-relaxed text-amber-300">
            Copy this secret now — it will <strong>never be shown again</strong>. Use it to verify
            the <span className="font-mono">x-clickroom-signature</span> header. A rotated secret
            replaces the old one after a 24h grace period.
          </p>
        </div>

        <div className="mb-4 overflow-hidden rounded-lg border border-border bg-muted/30">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="font-mono text-[10px] text-muted-foreground">Signing secret</span>
            <CopyButton value={secret} label="Copy" copiedIconClassName="text-teal-400" />
          </div>
          <div className="select-all break-all px-3 py-3 font-mono text-xs leading-relaxed text-foreground">
            {secret}
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-md bg-primary py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Done, I copied it
        </button>
      </div>
    </div>
  )
}
