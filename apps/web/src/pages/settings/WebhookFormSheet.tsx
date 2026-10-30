// Frame `6b`: the create / edit webhook sheet.
//
// One component for both modes: `webhook === null` creates, otherwise it is the
// same form populated with a "Save changes" footer. The two things that make
// this more than a form:
//
//  1. **Send test works before the first save.** `webhooks.sendTest` accepts an
//     unsaved `{ url, events }` precisely so a customer can prove the endpoint
//     is reachable before committing a row (see the router's block comment on
//     why enqueue-and-poll was rejected). The inline result strip is the whole
//     point of the control — a toast that disappears is not a wiring check.
//  2. **The plaintext signing secret is shown exactly once.** It is minted
//     server-side and never readable again (constraint 7: the control plane
//     cannot decrypt it), so the reveal is handed up via `onSecretRevealed` and
//     rendered by the page's once-only overlay.
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { SecretField } from '@/components/SecretField'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'

/**
 * Mirrors `supportWebhookEventSchema` (`support.schema.ts:646`). Declared
 * locally rather than imported: the schema lives behind the router package's
 * server entrypoint, and this is the same posture `SettingsPage` takes for
 * `OrgRole`.
 */
export type SupportWebhookEvent =
  | 'ticket.created'
  | 'ticket.replied'
  | 'ticket.updated'
  | 'ticket.resolved'
  | 'ticket.reopened'

/** The `list` row after `publicWebhook` has stripped both secret columns. */
export type SupportWebhookRow = {
  id: string
  name: string
  url: string
  events: string[]
  active: boolean
  secretHint: string | null
  lastDeliveryAt: string | Date | null
  autoDisabledAt: string | Date | null
  consecutiveFailures: number
}

/**
 * The checkbox list. `ticket.replied` keeps its shipped WIRE name — renaming it
 * would silently change what live customers receive — and carries the "Message"
 * label the design asks for beside it (decision 1).
 *
 * `ticket.updated` has been in the enum since and has never been
 * emitted. It stays listed (and off by default) because removing it would break
 * anyone already subscribed; the description says so rather than pretending.
 */
const WEBHOOK_EVENTS: {
  value: SupportWebhookEvent
  label?: string
  description: string
  defaultOn: boolean
}[] = [
  {
    value: 'ticket.created',
    description: 'A new ticket is filed, after any AI auto-reply',
    defaultOn: true,
  },
  {
    value: 'ticket.replied',
    label: 'Message',
    description: 'The end-user or an agent posts a reply',
    defaultOn: true,
  },
  {
    value: 'ticket.resolved',
    description: 'A ticket is marked solved by either side',
    defaultOn: true,
  },
  {
    value: 'ticket.reopened',
    description: 'A solved ticket receives a new message',
    defaultOn: false,
  },
  {
    value: 'ticket.updated',
    description: 'Reserved — subscribable, but not emitted yet',
    defaultOn: false,
  },
]

const DEFAULT_EVENTS = WEBHOOK_EVENTS.filter((e) => e.defaultOn).map((e) => e.value)

/**
 * Client mirror of the server's `httpsUrl` refinement (`support.schema.ts:665`),
 * so `http://` is refused at the form rather than at delivery time. The server
 * check remains the authority — this only decides what the button does.
 */
function httpsUrlError(value: string): string | null {
  if (value.trim().length === 0) return 'Endpoint URL is required.'
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return 'Enter a valid URL.'
  }
  return parsed.protocol === 'https:' ? null : 'Endpoint URL must be https://'
}

type TestResult = {
  status: 'delivered' | 'failed'
  code: number | null
  latencyMs: number
  body: string
  error: string | null
}

export function WebhookFormSheet({
  projectId,
  webhook,
  open,
  onOpenChange,
  onSecretRevealed,
}: {
  projectId: string
  /** `null` → create mode. */
  webhook: SupportWebhookRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once with the plaintext secret minted by `create`. */
  onSecretRevealed: (secret: string) => void
}) {
  const isEdit = webhook !== null

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<SupportWebhookEvent[]>(DEFAULT_EVENTS)
  const [submitted, setSubmitted] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  // Repopulate whenever the sheet opens or swaps which webhook it is editing —
  // otherwise reopening for a different row would show the previous one's URL.
  useEffect(() => {
    if (!open) return
    setName(webhook?.name ?? '')
    setUrl(webhook?.url ?? '')
    setEvents(webhook ? (webhook.events as SupportWebhookEvent[]) : [...DEFAULT_EVENTS])
    setSubmitted(false)
    setTestResult(null)
  }, [open, webhook])

  const utils = trpc.useUtils()
  const create = trpc.support.webhooks.create.useMutation()
  const update = trpc.support.webhooks.update.useMutation()
  const rotate = trpc.support.webhooks.rotateSecret.useMutation()
  const sendTest = trpc.support.webhooks.sendTest.useMutation()

  const urlError = httpsUrlError(url)
  const nameError = name.trim().length === 0 ? 'Name is required.' : null
  const eventsError = events.length === 0 ? 'Select at least one event.' : null
  const saving = create.isPending || update.isPending

  // Editing a live endpoint's URL invalidates whatever the last test proved.
  const urlChanged = isEdit && webhook !== null && url.trim() !== webhook.url

  function toggleEvent(value: SupportWebhookEvent) {
    setEvents((prev) => (prev.includes(value) ? prev.filter((e) => e !== value) : [...prev, value]))
  }

  async function handleSendTest() {
    if (urlError) {
      setSubmitted(true)
      return
    }
    setTestResult(null)
    try {
      // Both `id` and `url` go up when editing: the router signs with the saved
      // secret but POSTs to the URL currently in the field, so the test proves
      // the endpoint you are about to save rather than the one already stored.
      const result = await sendTest.mutateAsync({
        projectId,
        ...(webhook ? { id: webhook.id } : {}),
        url: url.trim(),
        ...(events.length > 0 ? { events } : {}),
      })
      setTestResult(result)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send test')
    }
  }

  async function handleRotate() {
    if (!webhook) return
    try {
      const result = await rotate.mutateAsync({ projectId, id: webhook.id })
      await utils.support.webhooks.list.invalidate()
      onSecretRevealed(result.secret)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to rotate secret')
    }
  }

  async function handleSubmit() {
    setSubmitted(true)
    if (urlError || nameError || eventsError) return
    try {
      if (webhook) {
        await update.mutateAsync({
          projectId,
          id: webhook.id,
          patch: { name: name.trim(), url: url.trim(), events },
        })
        await utils.support.webhooks.list.invalidate()
        toast.success('Webhook updated')
        onOpenChange(false)
      } else {
        const created = await create.mutateAsync({
          projectId,
          name: name.trim(),
          url: url.trim(),
          events,
        })
        await utils.support.webhooks.list.invalidate()
        onOpenChange(false)
        // The plaintext secret in this response is the only time it is readable.
        onSecretRevealed(created.secret)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save webhook')
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Full-width below `md` per the repo's responsiveness rules; the design's
          560px only applies once there is room for it. `sm:max-w-none` defeats
          `SheetContent`'s built-in `sm:max-w-sm`. */}
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-none md:max-w-[560px]">
        <SheetHeader>
          <SheetTitle className="text-sm">{isEdit ? 'Edit webhook' : 'New webhook'}</SheetTitle>
          <SheetDescription className="text-[11px]">
            HTTP endpoints that receive support tickets and replies.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-4">
          {/* Name */}
          <div>
            <Label htmlFor="webhook-name" className="mb-1.5 text-[11px] text-muted-foreground">
              Name
            </Label>
            <Input
              id="webhook-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Ticket sync — internal API"
              className="text-xs"
            />
            {submitted && nameError && (
              <p className="mt-1.5 text-[10px] text-red-400">{nameError}</p>
            )}
          </div>

          {/* Endpoint URL */}
          <div>
            <Label htmlFor="webhook-url" className="mb-1.5 text-[11px] text-muted-foreground">
              Endpoint URL
            </Label>
            <Input
              id="webhook-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.acme.co/hooks/tickets"
              className={cn('font-mono text-xs', submitted && urlError && 'border-red-500/40')}
            />
            {submitted && urlError ? (
              <p className="mt-1.5 text-[10px] text-red-400">{urlError}</p>
            ) : (
              <p className="mt-1.5 text-[10px] text-muted-foreground">
                Must be HTTPS. We POST JSON and expect a 2xx within 10s.
              </p>
            )}
            {urlChanged && (
              <p className="mt-1.5 flex items-start gap-1.5 text-[10px] text-amber-400">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                Endpoint URL changed — send a test before saving to confirm the new URL responds.
              </p>
            )}
          </div>

          {/* Events */}
          <div>
            <span className="mb-2 block text-[11px] font-medium text-muted-foreground">Events</span>
            <div className="flex flex-col gap-2.5">
              {WEBHOOK_EVENTS.map((event) => (
                <label
                  key={event.value}
                  htmlFor={`webhook-event-${event.value}`}
                  className="flex cursor-pointer items-start gap-2.5"
                >
                  <Checkbox
                    id={`webhook-event-${event.value}`}
                    checked={events.includes(event.value)}
                    onCheckedChange={() => toggleEvent(event.value)}
                    className="mt-0.5"
                  />
                  <span className="flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-foreground">{event.value}</span>
                      {event.label && (
                        <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          {event.label}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[10.5px] text-muted-foreground">
                      {event.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {submitted && eventsError && (
              <p className="mt-2 text-[10px] text-red-400">{eventsError}</p>
            )}
          </div>

          {/* Signing secret */}
          <div>
            <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
              Signing secret
            </span>
            {isEdit ? (
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                {/* Mask only — no `value`. The control plane cannot decrypt the
                    stored secret (constraint 7), so `whsec_••••3f7a` is all
                    there is until the customer rotates. */}
                <SecretField
                  masked={`whsec_••••${webhook?.secretHint ?? '••••'}`}
                  copyable={false}
                  label="signing secret"
                  valueClassName="text-xs"
                  className="flex-1"
                />
                <button
                  type="button"
                  onClick={handleRotate}
                  disabled={rotate.isPending}
                  className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-primary transition-opacity hover:opacity-80 disabled:opacity-50"
                >
                  {rotate.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                  Rotate
                </button>
              </div>
            ) : (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                Generated when you create the webhook, and shown once.
              </div>
            )}
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              Verify the <span className="font-mono">x-clickroom-signature</span> header on your
              side. Rotating invalidates the old secret after a 24h grace period.
            </p>
          </div>

          {/* Send test — works before the first save */}
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card px-3.5 py-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="flex-1">
              <div className="text-xs font-medium text-foreground">Send a test payload</div>
              <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                Posts a sample <span className="font-mono">ticket.created</span> so you can confirm
                the wiring.
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSendTest}
              disabled={sendTest.isPending}
              className="shrink-0 text-[11px]"
            >
              {sendTest.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              Send test
            </Button>
          </div>

          {testResult && <TestResultStrip result={testResult} />}
        </div>

        <SheetFooter className="flex-row justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSubmit}
            disabled={saving}
            className="text-xs"
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            {isEdit ? 'Save changes' : 'Create webhook'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/**
 * The inline result strip — teal `200 OK in 214ms`, or red with the status line
 * and a snippet of what the endpoint actually said. A response body is the
 * difference between "it failed" and "your auth token is wrong", so the failure
 * branch renders it rather than swallowing it.
 */
function TestResultStrip({ result }: { result: TestResult }) {
  const delivered = result.status === 'delivered'
  const snippet = result.body.trim().slice(0, 400)

  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2.5',
        delivered ? 'border-teal-500/20 bg-teal-500/5' : 'border-red-500/20 bg-red-500/5',
      )}
    >
      {delivered ? (
        <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-teal-400" />
      ) : (
        <XCircle className="mt-px h-3.5 w-3.5 shrink-0 text-red-400" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground">
          {delivered ? (
            <>
              Test delivered — <span className="font-mono text-teal-400">{result.code} OK</span> in{' '}
              {result.latencyMs}ms
            </>
          ) : (
            <>
              Test failed —{' '}
              <span className="font-mono text-red-400">{result.code ?? 'no response'}</span> in{' '}
              {result.latencyMs}ms
              {result.error ? ` · ${result.error}` : ''}
            </>
          )}
        </div>
        {!delivered && snippet.length > 0 && (
          <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-muted/40 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
            {snippet}
          </pre>
        )}
      </div>
    </div>
  )
}
