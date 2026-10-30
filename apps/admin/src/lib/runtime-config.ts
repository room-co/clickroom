/**
 * Runtime configuration — mirrors apps/web/src/lib/runtime-config.ts.
 * `/config.js` sets `window.__CLICKROOM_CONFIG__`; empty string = same-origin / unset.
 * `VITE_API_ORIGIN` remains as a dev fallback only.
 */
declare global {
  interface Window {
    __CLICKROOM_CONFIG__?: {
      apiOrigin?: string
      captureHost?: string
      deployment?: string
      writeKey?: string
    }
  }
}

/** API origin for tRPC (relative `/trpc` when empty, i.e. same-origin or dev proxy). */
export function getApiOrigin(): string {
  const value = typeof window === 'undefined' ? '' : window.__CLICKROOM_CONFIG__?.apiOrigin
  const configured = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
  return configured || import.meta.env.VITE_API_ORIGIN || ''
}
