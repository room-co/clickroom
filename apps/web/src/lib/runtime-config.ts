/**
 * Runtime configuration.
 *
 * `/config.js` (loaded by index.html before the bundle) sets
 * `window.__CLICKROOM_CONFIG__`. In containers it is rendered at start from
 * `config.js.template` via envsubst, so one image serves any deployment. Every
 * value is a string; an empty string means "same-origin / unset".
 *
 * `VITE_*` build-time vars remain as dev fallbacks only.
 */
export interface RuntimeConfig {
  /** Origin of apps/api, e.g. `https://api.example.com`. Empty = same origin. */
  apiOrigin: string
  /** Capture host events are sent to. Empty = `${location.origin}/capture`. */
  captureHost: string
  /** `self_host` | `cloud` (empty = unknown). */
  deployment: string
  /** Write key for dashboard self-instrumentation. Empty = off. */
  writeKey: string
}

declare global {
  interface Window {
    __CLICKROOM_CONFIG__?: Partial<RuntimeConfig>
  }
}

function read(key: keyof RuntimeConfig): string {
  const value = typeof window === 'undefined' ? undefined : window.__CLICKROOM_CONFIG__?.[key]
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
}

/** API origin for tRPC (relative `/trpc` when empty, i.e. same-origin or dev proxy). */
export function getApiOrigin(): string {
  return read('apiOrigin') || import.meta.env.VITE_API_ORIGIN || ''
}

/**
 * API origin for raw fetches / user-visible URLs (SSO, Ask AI, MCP). Never relative to a
 * different dev port: in `vite dev` with nothing configured it falls back to the api dev server.
 */
export function getApiBase(): string {
  const configured = getApiOrigin()
  if (configured) return configured
  return import.meta.env.DEV ? 'http://localhost:3000' : ''
}

/** Absolute API origin for display (MCP URL, etc.): resolves same-origin to `location.origin`. */
export function getAbsoluteApiOrigin(): string {
  return getApiBase() || window.location.origin
}

/** Absolute capture host for SDK snippets and the dashboard's own analytics. */
export function getCaptureHost(): string {
  const configured = read('captureHost') || import.meta.env.VITE_CLICKROOM_API_HOST || ''
  if (configured) return configured
  if (import.meta.env.DEV) return 'http://localhost:3001'
  return `${window.location.origin}/capture`
}

export function getDeployment(): string {
  return read('deployment') || import.meta.env.VITE_CLICKROOM_DEPLOYMENT || ''
}

export function getWriteKey(): string {
  return read('writeKey') || import.meta.env.VITE_CLICKROOM_WRITE_KEY || ''
}
