/**
 * In-memory admin access-token store — deliberately NOT localStorage/sessionStorage. The refresh
 * token lives in the httpOnly `clickroom_admin_rt` cookie (packages/auth/src/admin-tokens.ts); the
 * access token must not survive a page reload except by that cookie-backed refresh
 * (`lib/refresh.ts`), so it's held in a module-level variable only, exposed to React via
 * `useSyncExternalStore` so components re-render when login/logout flips it.
 */
import { useSyncExternalStore } from 'react'

let accessToken: string | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function getAccessToken(): string | null {
  return accessToken
}

export function setAccessToken(token: string | null) {
  if (accessToken === token) return
  accessToken = token
  emit()
}

function subscribe(callback: () => void) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

export function useAccessToken(): string | null {
  return useSyncExternalStore(subscribe, getAccessToken, getAccessToken)
}
