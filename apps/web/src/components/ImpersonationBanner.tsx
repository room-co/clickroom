import { useEffect, useState } from 'react'
import { logout } from '@/lib/session'
import { trpc } from '@/lib/trpc'

/** Format remaining milliseconds as `mm:ss`, floored at `00:00`. */
function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * Non-dismissible top banner shown for the duration of an impersonated
 * session (`auth.me` surfaces `impersonatedByAdminId`/
 * `impersonationExpiresAt` off the `Session` row — this renders whenever the
 * former is present and counts down to the latter.
 *
 * `apps/web` never holds an admin token (separate identity plane), so "Exit impersonation" cannot call `admin.impersonate.stop`
 * directly. Instead it calls the ordinary tenant `auth.logout`, which deletes
 * the same `Session` row by id — the same end state — then redirects to
 * `/login`. The countdown reaching zero does the same thing proactively,
 * since the session is rejected server-side past `impersonationExpiresAt`
 * regardless (any subsequent call would 401).
 */
export function ImpersonationBanner() {
  const { data } = trpc.auth.me.useQuery()
  const expiresAt = data?.impersonationExpiresAt ?? null
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!expiresAt) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [expiresAt])

  const remainingMs = expiresAt ? new Date(expiresAt).getTime() - now : null

  useEffect(() => {
    if (remainingMs !== null && remainingMs <= 0) {
      logout()
    }
  }, [remainingMs])

  if (!data?.impersonatedByAdminId) return null

  return (
    <div
      role="alert"
      className="w-full shrink-0 bg-destructive text-white px-3 py-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
    >
      <span className="text-sm font-medium break-words">
        Viewing as {data.user.email} — impersonated by an admin, ends in{' '}
        {formatRemaining(remainingMs ?? 0)}
      </span>
      <button
        type="button"
        onClick={() => logout()}
        className="inline-flex items-center justify-center rounded-md border border-white/40 px-3 py-1 text-sm font-medium shrink-0 hover:bg-white/10 transition-colors"
      >
        Exit impersonation
      </button>
    </div>
  )
}
