import clickroom from '@clickroom/sdk-js'
import { getCaptureHost, getWriteKey } from './runtime-config'

/**
 * Dogfooding wrapper around `@clickroom/sdk-js` — Clickroom's own dashboard
 * tracking its own usage. No-ops entirely when
 * no write key is configured (runtime `writeKey`, or `VITE_CLICKROOM_WRITE_KEY` in dev), so local/self-host builds
 * without dogfood config never touch the SDK and never warn. Call sites
 * should import `track`/`identifyUser`/`resetAnalytics` from here — never the
 * SDK directly — so the dogfood config stays centralized in one place.
 */

const writeKey = getWriteKey()
const apiHost = getCaptureHost()

const enabled = Boolean(writeKey)

let initialized = false

// The dogfood project is shared by every Clickroom customer org's users (one
// write key, many orgs) — unlike a normal customer install where org_id is
// implicit. Every event needs org_id stamped on its own properties (not just
// as an identify() person trait) so the internal project can break down
// usage by org. Set once, alongside identify(), by the same call site that
// resolves {user, org} (see AppShell's identify effect).
let currentOrgId: string | undefined

/** sessionStorage key AppShell's identify effect dedupes against — shared here so `resetAnalytics` can clear it. */
export const IDENTIFY_SIG_STORAGE_KEY = 'ckrm_ui_identify_sig'

/** Sets the org_id every subsequent `track()` call stamps onto its event. */
export function setAnalyticsOrgContext(orgId: string | null | undefined): void {
  currentOrgId = orgId ?? undefined
}

/**
 * Initializes the SDK once. Safe to call multiple times (idempotent) and
 * safe to call with no write key configured (no-op).
 */
export function initAnalytics(): void {
  if (!enabled || initialized) return
  initialized = true
  clickroom.init(writeKey as string, {
    api_host: apiHost,
    autocapture: true,
    capture_pageview: true,
    feature_flag_poll_interval: 60_000,
  })
}

/** Captures a custom event, stamped with org_id when known. No-ops if analytics isn't configured. */
export function track(event: string, props?: Record<string, unknown>): void {
  if (!enabled) return
  clickroom.capture(event, currentOrgId ? { ...props, org_id: currentOrgId } : props)
}

/** Identifies the current user. No-ops if analytics isn't configured. */
export function identifyUser(id: string, traits?: Record<string, unknown>): void {
  if (!enabled) return
  clickroom.identify(id, traits)
}

/** Resets the SDK's identity/session state (call on logout). No-ops if analytics isn't configured. */
export function resetAnalytics(): void {
  currentOrgId = undefined
  try {
    window.sessionStorage.removeItem(IDENTIFY_SIG_STORAGE_KEY)
  } catch {
    // ignore
  }
  if (!enabled) return
  clickroom.reset()
}
