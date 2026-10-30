import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { getAccessToken, useAccessToken } from '@/lib/auth-store'
import { refreshAccessToken } from '@/lib/refresh'

/**
 * Route guard for everything under the authenticated shell. On mount, if there's no
 * in-memory access token (a fresh page load — the token never survives one, by design, see
 * `lib/auth-store.ts`), it attempts exactly one cookie-backed refresh so a returning admin with a
 * still-valid `clickroom_admin_rt` cookie doesn't have to log in again. Renders a spinner while
 * that one-time bootstrap is in flight — this is a pre-auth bootstrap moment, not an in-app data
 * fetch, so CLAUDE.md's skeleton-for-data-loading rule doesn't apply here.
 *
 * `<Outlet />`-based so `AppShell` can be composed as a child route element (or wrapped
 * around this) without this file needing to change shape.
 */
export function ProtectedAdminRoute() {
  const token = useAccessToken()
  const location = useLocation()
  const [bootstrapped, setBootstrapped] = useState(getAccessToken() !== null)

  useEffect(() => {
    if (getAccessToken()) {
      setBootstrapped(true)
      return
    }
    let cancelled = false
    refreshAccessToken().finally(() => {
      if (!cancelled) setBootstrapped(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!bootstrapped) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-background">
        <div
          role="status"
          aria-label="Loading"
          className="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary"
        />
      </div>
    )
  }

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return <Outlet />
}
