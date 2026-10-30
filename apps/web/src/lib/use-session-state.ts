import { useEffect, useState } from 'react'
import { clearToken, getToken } from '@/lib/auth'
import { hasValidToken, refreshSession } from '@/lib/session'

export type SessionState = 'checking' | 'authed' | 'anon'

/**
 * Resolve whether the visitor currently has a session.
 *
 * A present, non-expired access token settles as `authed` immediately. Otherwise
 * (missing or expired token) we attempt exactly ONE cookie-based refresh before
 * concluding `anon` — so a tab reload after the access token expired restores the
 * session instead of dumping the user at /login. Only a genuinely absent/revoked
 * refresh cookie ends as `anon`.
 *
 * Shared by `RequireAuth` (bounce anon → /login) and `RedirectIfAuthed` (bounce
 * authed → /), so the two guards can't drift apart. `refreshSession()` is
 * single-flight, so mounting both costs one `auth.refresh` round trip.
 */
export function useSessionState(): SessionState {
  const [state, setState] = useState<SessionState>(() => (hasValidToken() ? 'authed' : 'checking'))

  useEffect(() => {
    if (state !== 'checking') return
    let cancelled = false
    refreshSession().then((ok) => {
      if (cancelled) return
      if (ok) {
        setState('authed')
      } else {
        if (getToken()) clearToken()
        setState('anon')
      }
    })
    return () => {
      cancelled = true
    }
  }, [state])

  return state
}
