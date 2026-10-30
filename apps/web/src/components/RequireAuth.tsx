import { Navigate, Outlet } from 'react-router'
import { AppShellSkeleton } from '@/components/skeletons/AppShellSkeleton'
import { useSessionState } from '@/lib/use-session-state'

// Guard the authed app: only a genuinely absent/revoked session reaches /login.
// See `useSessionState` for how a session is resolved.
export function RequireAuth() {
  const state = useSessionState()

  if (state === 'checking') return <AppShellSkeleton />
  if (state === 'anon') return <Navigate to="/login" replace />
  return <Outlet />
}
