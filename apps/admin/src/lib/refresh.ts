/**
 * Standalone `adminAuth.refresh` caller — a raw `fetch`, deliberately OUTSIDE the tRPC link chain
 * (`lib/trpc.ts`'s `retryOnUnauthorizedLink`). That link calls this module on a 401; if this were
 * itself a tRPC call routed back through the same client/link chain, a refresh failure would
 * recurse into another 401 → another refresh attempt.
 *
 * De-duplicated with an in-flight promise so concurrent 401s from a batched request (or several
 * queries firing at once on mount) trigger exactly one refresh call, not one each.
 */
import { TRPC_URL } from './api-origin'
import { setAccessToken } from './auth-store'

interface RefreshResponseBody {
  result?: {
    data?: {
      accessToken?: string
    }
  }
}

let inflight: Promise<string | null> | null = null

async function performRefresh(): Promise<string | null> {
  try {
    const res = await fetch(`${TRPC_URL}/adminAuth.refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (!res.ok) {
      setAccessToken(null)
      return null
    }
    const json = (await res.json()) as RefreshResponseBody
    const token = json.result?.data?.accessToken ?? null
    setAccessToken(token)
    return token
  } catch {
    setAccessToken(null)
    return null
  }
}

/** Resolves with the new access token, or null if the cookie-backed refresh failed/was absent. */
export function refreshAccessToken(): Promise<string | null> {
  if (!inflight) {
    inflight = performRefresh().finally(() => {
      inflight = null
    })
  }
  return inflight
}
