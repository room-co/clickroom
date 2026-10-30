import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { trpc } from '@/lib/trpc'

/**
 * Persistent identity footer. This console can impersonate
 * customers, so the signed-in admin's own identity must always be visible on
 * screen as a reminder of who is acting — kept permanently visible (not
 * collapsible/hideable, not tucked inside the off-canvas mobile sidebar) by
 * rendering it as its own full-width bar in `AppShell`, outside the
 * collapsible sidebar entirely.
 *
 * Loading state: `isPending` (not bare `isLoading`) drives a minimal inline
 * pulsing skeleton per CLAUDE.md — this app has no skeleton component
 * library yet (that's concern), so a local placeholder is enough
 * for this one spot.
 */
export function ShellFooter() {
  const me = trpc.adminAuth.me.useQuery()

  return (
    <footer className="flex h-10 shrink-0 items-center justify-between gap-3 border-t border-border bg-sidebar px-3 text-xs">
      {me.isPending ? (
        <div className="h-3.5 w-40 animate-pulse rounded bg-muted" aria-hidden="true" />
      ) : me.data ? (
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate font-medium text-foreground" title={me.data.email}>
            {me.data.email}
          </span>
          <span
            className={
              me.data.twoFactorEnabled
                ? 'inline-flex items-center gap-1 text-muted-foreground'
                : 'inline-flex items-center gap-1 text-destructive'
            }
          >
            {me.data.twoFactorEnabled ? (
              <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <ShieldAlert className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            {me.data.twoFactorEnabled ? '2FA on' : '2FA off'}
          </span>
        </div>
      ) : (
        <span className="text-muted-foreground">Signed-in admin unavailable</span>
      )}
      <span className="hidden shrink-0 text-muted-foreground sm:inline">
        Every action here is audited and attributable
      </span>
    </footer>
  )
}
