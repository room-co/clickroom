import { Navigate, Outlet } from 'react-router'
import { AuthSpinner } from '@/components/auth-ui'
import { useSessionState } from '@/lib/use-session-state'

// The mirror image of `RequireAuth`, wrapping the public auth pages (/login,
// /signup). Without this, arriving at /login with a live session — the normal
// path when clicking "Login" on the marketing site — renders the form and makes
// an already-authenticated user sign in again.
//
// A spinner rather than a skeleton: there's no app shell to mirror on these
// pages, and this is a session probe, not a data fetch.
export function RedirectIfAuthed() {
  const state = useSessionState()

  if (state === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
        <AuthSpinner />
      </div>
    )
  }
  if (state === 'authed') return <Navigate to="/" replace />
  return <Outlet />
}
