// @clickroom/sdk-js — shared types for the browser SDK.

// How the support widget behaves when `support` is enabled.
export type SupportMode = 'launcher' | 'manual' | 'both'

export interface SupportOptions {
  enabled: boolean
  /** 'launcher' (default) = today's behavior: auto-mount the FAB.
   *  'manual'  = fetch config + build the client, mount nothing. The host app places it
   *              (`<ClickroomSupport mode="inline" />` / `clickroom.support.mount()`).
   *  'both'    = auto-mount the FAB *and* allow manual mounts (FAB on marketing pages,
   *              full page at /support). */
  mode?: SupportMode
}

export interface ClickroomConfig {
  api_host: string
  autocapture: boolean
  capture_pageview: boolean
  // Opt-in survey delivery. When true, init() fetches + caches the survey config
  // from GET /v1/surveys and exposes the survey client. Off by default. The auto-popover
  // renderer is a separate layer wired on top of the client.
  surveys: boolean
  // Background re-fetch interval (ms) for the survey config. >0 re-fetches
  // GET /v1/surveys on that cadence so a survey created mid-session reaches a
  // long-lived page without a reload (mirrors PostHog's survey TTL refresh).
  // Only takes effect when `surveys` is true. Defaults to 5 min.
  survey_poll_interval: number
  // Opt-in support widget delivery. When enabled, init() fetches + caches the support
  // form config from GET /v1/support, gates each form on its linked flag and builds the client.
  // `mode` decides whether the FAB auto-mounts (see SupportMode). Off by default — zero bytes
  // fetched for existing embeds. Stored in the NORMALISED shape: a bare `support: true`
  // in ClickroomOptions normalises to `{ enabled: true, mode: 'launcher' }`.
  support: { enabled: boolean; mode: SupportMode }
  // Background re-fetch interval (ms) for the support config. >0 re-fetches
  // GET /v1/support on that cadence so a form created (or edited) mid-session reaches a
  // long-lived page without a reload. Only takes effect when `support` is true. Defaults to 5 min.
  support_poll_interval: number
}

export interface ClickroomOptions {
  api_host?: string
  autocapture?: boolean
  capture_pageview?: boolean
  // Opt-in: fetch + cache survey config and enable client-side survey triggers.
  // Unset (default) = off, no /v1/surveys fetch.
  surveys?: boolean
  // Opt-in: re-fetch the survey config every N ms (min 30000, enforced; 0 = off)
  // so a survey created mid-session reaches a long-lived page without a reload.
  // Unset (default) = the 5-min default from ClickroomConfig. Only applies when
  // `surveys` is true.
  survey_poll_interval?: number
  // Opt-in: fetch + cache the support form config and mount the support widget.
  // `true` (or `{ enabled: true }`) auto-mounts the FAB, exactly as before. Pass a SupportOptions
  // object to pick a `mode` — `'manual'` builds the client but mounts nothing, for a
  // host-placed inline page. Unset (default) = off, no /v1/support fetch.
  support?: boolean | SupportOptions
  // Opt-in: re-fetch the support config every N ms (min 30000, enforced; 0 = off) so a form
  // created mid-session reaches a long-lived page without a reload. Unset (default) = the
  // 5-min default from ClickroomConfig. Only applies when `support` is true.
  support_poll_interval?: number
  // Opt-in: re-fetch flag definitions every N ms (min 5000, enforced) so long-
  // lived pages see dashboard flag changes without an explicit identify()/
  // refreshFeatureFlags() call. Unset (default) = no polling, matching prior
  // behavior — fetch-once-on-demand until identify() re-fetches.
  feature_flag_poll_interval?: number
}

// Wire payload POSTed to {api_host}/capture inside `{ batch: EventPayload[] }`.
export interface EventPayload {
  event: string
  distinct_id: string
  // ISO8601 UTC with millisecond precision (new Date().toISOString()).
  timestamp: string
  properties: Record<string, unknown>
  elements_chain?: string
}

// Context handed to the autocapture module (implemented in ./autocapture).
export interface AutocaptureContext {
  config: ClickroomConfig
  capture(event: string, properties?: Record<string, unknown>, elementsChain?: string): void
}
