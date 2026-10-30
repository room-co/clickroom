import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc'

/** Backend minimum from `admin-impersonate.router.ts`'s `start` input schema — kept in sync
 * manually since the client can't import the server-side zod schema. */
const REASON_MIN_LENGTH = 10

interface ImpersonateResult {
  accessToken: string
  refreshToken: string
  sessionId: string
  user: { id: string; email: string; name: string | null }
  // Nullable per `AuthResult` (the same shape a normal login returns) — never actually null for
  // an impersonation start, since `createImpersonatedSession` requires an existing membership,
  // but the type is shared so this stays optional-safe.
  org: { id: string; name: string; slug: string } | null
}

/**
 * Reason-gated impersonation. `admin.impersonate.start` mints a real tenant
 * access/refresh pair — apps/admin and apps/web are separate origins, so
 * there is no way to silently hand that session to apps/web from here. Rather than build a
 * cross-origin token bridge the spec doesn't ask for, this dialog shows the minted tokens
 * (copyable) plus plain instructions for using them in apps/web, and a "Stop impersonation"
 * action once the admin is done. `sessionId` comes straight from `start`'s response.
 */
export function ImpersonateDialog({
  orgId,
  userId,
  userEmail,
  trigger,
}: {
  orgId: string
  userId: string
  userEmail: string
  trigger: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [result, setResult] = useState<ImpersonateResult | null>(null)
  const [copied, setCopied] = useState<'access' | 'refresh' | null>(null)

  const start = trpc.admin.impersonate.start.useMutation()
  const stop = trpc.admin.impersonate.stop.useMutation()

  function reset() {
    setReason('')
    setResult(null)
    setCopied(null)
  }

  async function onSubmit() {
    const data = await start.mutateAsync({ orgId, userId, reason })
    setResult(data)
  }

  async function onCopy(kind: 'access' | 'refresh', value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(kind)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      // Clipboard API can be unavailable (older browsers, insecure context) — the token is
      // still selectable/visible in the field, so this isn't a hard failure.
    }
  }

  async function onStop() {
    if (!result) return
    await stop.mutateAsync({ sessionId: result.sessionId })
    setOpen(false)
    reset()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      {open && !result ? (
        <ImpersonateForm
          userEmail={userEmail}
          reason={reason}
          onReasonChange={setReason}
          pending={start.isPending}
          error={start.error?.message ?? null}
          onCancel={() => setOpen(false)}
          onSubmit={onSubmit}
        />
      ) : null}
      {open && result ? (
        <ImpersonateSuccess
          result={result}
          copied={copied}
          onCopy={onCopy}
          stopPending={stop.isPending}
          onStop={onStop}
          onDone={() => setOpen(false)}
        />
      ) : null}
    </Dialog>
  )
}

function ImpersonateForm({
  userEmail,
  reason,
  onReasonChange,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  userEmail: string
  reason: string
  onReasonChange: (value: string) => void
  pending: boolean
  error: string | null
  onCancel: () => void
  onSubmit: () => void | Promise<void>
}) {
  const tooShort = reason.trim().length < REASON_MIN_LENGTH
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Impersonate {userEmail}</DialogTitle>
        <DialogDescription>
          Mints a real, time-boxed (30 minute) tenant session as this user. A reason is required and
          is written to the audit log.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="impersonate-reason">Reason</Label>
        <Textarea
          id="impersonate-reason"
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          placeholder="e.g. Reproducing support ticket #1234 — user reports flag evaluation returning stale value."
          rows={3}
        />
        <p className="text-xs text-muted-foreground">
          {reason.trim().length}/{REASON_MIN_LENGTH} characters minimum
        </p>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" disabled={pending || tooShort} onClick={onSubmit}>
          {pending ? 'Starting…' : 'Start impersonation'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function ImpersonateSuccess({
  result,
  copied,
  onCopy,
  stopPending,
  onStop,
  onDone,
}: {
  result: ImpersonateResult
  copied: 'access' | 'refresh' | null
  onCopy: (kind: 'access' | 'refresh', value: string) => void
  stopPending: boolean
  onStop: () => void | Promise<void>
  onDone: () => void
}) {
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Impersonation session started</DialogTitle>
        <DialogDescription>
          Signed in as {result.user.email}
          {result.org ? ` in ${result.org.name}` : ''}. Expires in 30 minutes.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          apps/admin and apps/web are separate origins, so this session can't be injected into
          apps/web automatically. Copy a token below and set it as apps/web's session (e.g. via its
          devtools) to view as this user, or hand these to the support engineer doing the repro.
        </p>
        <TokenField
          label="Access token"
          value={result.accessToken}
          kind="access"
          copied={copied}
          onCopy={onCopy}
        />
        <TokenField
          label="Refresh token"
          value={result.refreshToken}
          kind="refresh"
          copied={copied}
          onCopy={onCopy}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="destructive" onClick={onStop} disabled={stopPending}>
          {stopPending ? 'Ending…' : 'Stop impersonation'}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function TokenField({
  label,
  value,
  kind,
  copied,
  onCopy,
}: {
  label: string
  value: string
  kind: 'access' | 'refresh'
  copied: 'access' | 'refresh' | null
  onCopy: (kind: 'access' | 'refresh', value: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-md border border-input bg-input/30 px-2 py-1.5 text-xs">
          {value}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={() => onCopy(kind, value)}>
          {copied === kind ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}
