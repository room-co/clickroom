import type { AppRouter } from '@clickroom/trpc-router'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { TRPC_URL } from './api-origin'
import { clearLocalSession, getToken, setToken } from './auth'

// A dedicated, plain tRPC client for the refresh call ONLY. It is NOT wrapped by
// the retry `fetch` in trpc-provider.tsx, so calling `auth.refresh` here can never
// recurse into itself. `auth.refresh` takes no input and authenticates via the
// httpOnly `clickroom_rt` cookie, so no Authorization header is needed — but the
// cookie only rides a cross-origin prod request when `credentials` is explicit.
const refreshClient = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: TRPC_URL,
      fetch: (input, init) => fetch(input, { ...init, credentials: 'include' }),
    }),
  ],
})

// `auth.logout` is an authed procedure, so unlike `refresh` it needs the Bearer token
// AND the cookie (the server clears the cookie on the response). Kept out of the app's
// main tRPC client for the same reason as `refreshClient`: no retry-on-401 wrapper, so
// logging out with a dead token can't recurse.
const authedClient = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: TRPC_URL,
      headers: () => {
        const token = getToken()
        return token ? { authorization: `Bearer ${token}` } : {}
      },
      fetch: (input, init) => fetch(input, { ...init, credentials: 'include' }),
    }),
  ],
})

// Single-flight guard: concurrent 401s (or a proactive timer racing a query) share
// ONE in-flight refresh promise so exactly one `auth.refresh` hits the server.
let inFlight: Promise<boolean> | null = null

/**
 * Refresh the access token via `auth.refresh` (cookie-based). Persists the new
 * token on success. Single-flight: concurrent callers await the same request.
 * Returns true on success, false on any failure (no/revoked cookie, network).
 */
export function refreshSession(): Promise<boolean> {
  if (inFlight) return inFlight
  inFlight = refreshClient.auth.refresh
    .mutate()
    .then((res) => {
      setToken(res.accessToken)
      return true
    })
    .catch(() => false)
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/**
 * Log out for real: revoke the session server-side (which deletes the DB row and
 * clears the httpOnly `clickroom_rt` cookie), then drop local state and bounce to
 * /login.
 *
 * The server call is mandatory, not cosmetic. Clearing localStorage alone leaves the
 * refresh cookie alive, and `RedirectIfAuthed` on /login would rehydrate from it and
 * throw the user straight back into the app — i.e. logout would silently do nothing.
 *
 * Best-effort: the two 401 fallbacks in `trpc-provider.tsx` / `useAskAIChat.ts` call
 * this with an already-dead token, so `auth.logout` (an authed procedure) will reject.
 * Swallow it — local state must be cleared and the user sent to /login either way.
 */
export async function logout(): Promise<void> {
  try {
    await authedClient.auth.logout.mutate()
  } catch {
    // Session already gone server-side; nothing left to revoke.
  }
  clearLocalSession()
  window.location.href = '/login'
}

/** Decode a JWT's `exp` claim (seconds since epoch), or null if unreadable. */
export function decodeExp(token: string | null): number | null {
  if (!token) return null
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    const payload = JSON.parse(json) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

/**
 * True when the token is absent, unreadable, or within `skewMs` of expiry.
 * A missing `exp` is treated as expired (fail-safe → triggers a refresh).
 */
export function isExpired(token: string | null, skewMs = 0): boolean {
  const exp = decodeExp(token)
  if (exp === null) return true
  return Date.now() >= exp * 1000 - skewMs
}

/** Convenience: current stored token is present and not (near-)expired. */
export function hasValidToken(skewMs = 0): boolean {
  return !!getToken() && !isExpired(getToken(), skewMs)
}
