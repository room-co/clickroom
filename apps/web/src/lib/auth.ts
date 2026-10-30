import { resetAnalytics } from '@/lib/analytics'

const TOKEN_KEY = 'ckrm_token'
const PROJECT_KEY = 'ckrm_ui_project_id'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export function isAuthed(): boolean {
  return !!getToken()
}

/**
 * Drop all client-side session state. Does NOT revoke the refresh cookie — that's
 * server-side and lives in `logout()` (lib/session.ts), which is what UI should call.
 */
export function clearLocalSession(): void {
  resetAnalytics()
  clearToken()
  localStorage.removeItem(PROJECT_KEY)
}
