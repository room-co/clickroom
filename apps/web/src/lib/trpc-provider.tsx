import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { httpBatchLink, TRPCClientError } from '@trpc/client'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { TRPC_URL } from './api-origin'
import { getToken } from './auth'
import { decodeExp, isExpired, logout, refreshSession } from './session'
import { trpc } from './trpc'

// Custom fetch for the tRPC link: on a 401 (expired/invalid access token) for a
// logged-in user, silently refresh the token ONCE and retry the request with the
// fresh bearer. The `getToken()` guard skips refresh when there is no session
// (e.g. a bad-credentials 401 on the login page) so we never loop.
async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // `credentials: 'include'` is what carries the httpOnly refresh cookie on the
  // cross-origin prod request (app.clickroom.co -> api.clickroom.co); omitting it
  // is a no-op in dev's same-origin proxy but silently breaks refresh in prod.
  const withCreds: RequestInit = { ...init, credentials: 'include' }
  const res = await fetch(input, withCreds)
  if (res.status !== 401 || !getToken()) return res

  const ok = await refreshSession()
  if (!ok) {
    logout()
    return res
  }

  // Retry once with the refreshed bearer swapped in. One batched request carries a
  // single Authorization header, so one refresh + one retry covers the whole batch.
  const headers = new Headers(init?.headers)
  headers.set('authorization', `Bearer ${getToken()}`)
  return fetch(input, { ...withCreds, headers })
}

// Final-fallback logout: if a request still surfaces UNAUTHORIZED after the retry
// path (e.g. refresh failed), send a logged-in user to /login. Guarded on a token
// being present so a login-page failure doesn't redirect-loop.
function handleAuthError(err: unknown): void {
  if (err instanceof TRPCClientError && err.data?.code === 'UNAUTHORIZED' && getToken()) {
    logout()
  }
}

// Proactively refresh shortly before the access token expires and whenever the tab
// regains focus with a stale token, so interactive sessions never hit a mid-action
// 401. All paths funnel through the single-flight `refreshSession`.
function SessionKeeper() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const REFRESH_SKEW_MS = 60_000 // refresh ~1 min before expiry

    function schedule() {
      if (timer.current) clearTimeout(timer.current)
      const exp = decodeExp(getToken())
      if (exp === null) return
      const fireAt = exp * 1000 - REFRESH_SKEW_MS - Date.now()
      timer.current = setTimeout(
        () => {
          if (getToken()) refreshSession().then(schedule)
        },
        Math.max(0, fireAt),
      )
    }

    function onVisible() {
      if (document.visibilityState !== 'visible') return
      if (getToken() && isExpired(getToken(), REFRESH_SKEW_MS)) {
        refreshSession().then(schedule)
      }
    }

    schedule()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      if (timer.current) clearTimeout(timer.current)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [])

  return null
}

export function TrpcProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: handleAuthError }),
        mutationCache: new MutationCache({ onError: handleAuthError }),
      }),
  )
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          // Relative in dev (proxied to :3000 by vite.config.ts); absolute in prod
          // via VITE_API_ORIGIN. See lib/api-origin.ts.
          url: TRPC_URL,
          fetch: authFetch,
          headers: () => {
            const token = getToken()
            return { authorization: token ? `Bearer ${token}` : '' }
          },
        }),
      ],
    }),
  )

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <SessionKeeper />
        {children}
      </QueryClientProvider>
    </trpc.Provider>
  )
}
