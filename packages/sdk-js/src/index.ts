// @clickroom/sdk-js — clickroom-js browser SDK core (autocapture + flags)..

import { initAutocapture } from './autocapture'
import { classifyChannel } from './channel'
import { parseDevice } from './device'
import { createFlagClient, type FlagClient, type FlagMap } from './flags'
import { createSessionManager, type SessionManager } from './session'
import {
  type CreatedTicket,
  defaultSupportRenderer,
  initSupport,
  type SupportClient,
  type SupportEventTrigger,
} from './support'
import type { SupportRenderHandle } from './support-render'
import { initSurveys, type SurveyClient, type SurveyEventTrigger } from './survey'
import { createTransport, type Transport } from './transport'
import type { AutocaptureContext, ClickroomConfig, ClickroomOptions, EventPayload } from './types'
import { parseUtm } from './utm'

export const PACKAGE_NAME = '@clickroom/sdk-js'

const LIB_NAME = 'clickroom-js'
// Stamped on every event as `$lib_version` — keep in lockstep with package.json.
const LIB_VERSION = '0.10.0'

const DID_KEY = 'ckrm_did'
const STORAGE_PREFIX = 'ckrm_'

/** Capture host of the hosted Clickroom Cloud. Self-hosters pass their own `api_host`. */
export const CLICKROOM_CLOUD_HOST = 'https://capture.clickroom.co'

// No default `api_host`: a hardcoded host silently sent self-hosters' events to the
// wrong place (the transport swallows send failures by design). `init()` resolves it from
// `opts.api_host`, else from the origin the CDN bundle was loaded from, else refuses to start.
const DEFAULT_CONFIG: ClickroomConfig = {
  api_host: '',
  autocapture: true,
  capture_pageview: true,
  surveys: false,
  survey_poll_interval: 300000,
  support: { enabled: false, mode: 'launcher' },
  support_poll_interval: 300000,
}

const isBrowser = (): boolean => typeof window !== 'undefined'

// Floor for `feature_flag_poll_interval` — keeps a misconfigured caller from
// hammering the flags endpoint (mirrors the intent of sdk-node's mandatory
// `pollInterval`, just defensive instead of required).
const MIN_FLAG_POLL_INTERVAL_MS = 5_000

// Floor for `survey_poll_interval` — stops a misconfigured caller from hammering
// GET /v1/surveys. Higher than the flag floor since survey config changes rarely.
const MIN_SURVEY_POLL_INTERVAL_MS = 30_000

// Floor for `support_poll_interval` — same reasoning as the survey floor: support form config
// changes rarely, so a misconfigured caller must not hammer GET /v1/support.
const MIN_SUPPORT_POLL_INTERVAL_MS = 30_000

type FlagListener = (flags: Record<string, boolean | string>) => void

interface State {
  initialized: boolean
  warnedNotInit: boolean
  writeKey: string
  config: ClickroomConfig
  distinctId: string
  // True once `identify()` has run — gates the support client's `listForUser` between the local
  // token store (anonymous) and the server's cross-device list (identified). Reset by `reset()`.
  identified: boolean
  personProperties: Record<string, unknown>
  transport: Transport | null
  session: SessionManager | null
  // Referrer/channel/UTM context, computed once per session (on the first
  // captured event of that session id) and reused for every subsequent event
  // — mirrors how `$session_id` itself is scoped per session, not per event.
  sessionContext: { sessionId: string; props: Record<string, unknown> } | null
  teardownAutocapture: (() => void) | null
  flagListeners: FlagListener[]
  flagClient: FlagClient | null
  flagsLoaded: boolean
  emittedFlagCalls: Set<string>
  flagPollId: ReturnType<typeof setInterval> | null
  surveyClient: SurveyClient | null
  // Set by `initSurveys` — forwards each captured event (name + properties) into the survey
  // event-trigger render path so `events`/`eventFilters` can be evaluated. Null when surveys off.
  surveyEventTrigger: SurveyEventTrigger | null
  // Stop handle for the survey background poll loop (set by `initSurveys`). Null when surveys
  // off or polling disabled.
  surveyPollStop: (() => void) | null
  supportClient: SupportClient | null
  // Set by `initSupport` — forwards each captured event into the support client so the
  // `recentEvents` context ring fills and `triggers.events` can auto-open. Null when support off.
  supportEventTrigger: SupportEventTrigger | null
  // Stop handle for the support background poll loop (set by `initSupport`).
  supportPollStop: (() => void) | null
  // Live accessor for the handles `initSupport` auto-mounted (the FAB from `support: true`), so
  // `clickroom.support.open()/.close()` can drive it. Null when support is off / mode is 'manual'.
  supportMountedHandles: (() => SupportRenderHandle[]) | null
}

const state: State = {
  initialized: false,
  warnedNotInit: false,
  writeKey: '',
  config: { ...DEFAULT_CONFIG },
  distinctId: '',
  identified: false,
  personProperties: {},
  transport: null,
  session: null,
  sessionContext: null,
  teardownAutocapture: null,
  flagListeners: [],
  flagClient: null,
  flagsLoaded: false,
  emittedFlagCalls: new Set(),
  flagPollId: null,
  surveyClient: null,
  surveyEventTrigger: null,
  surveyPollStop: null,
  supportClient: null,
  supportEventTrigger: null,
  supportPollStop: null,
  supportMountedHandles: null,
}

// ---- storage helpers (SSR-safe) ----------------------------------------

const safeLocalStorage = (): Storage | null => {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

const safeSessionStorage = (): Storage | null => {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage
  } catch {
    return null
  }
}

const storageGet = (key: string): string | null => {
  try {
    return safeLocalStorage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

const storageSet = (key: string, value: string): void => {
  try {
    safeLocalStorage()?.setItem(key, value)
  } catch {
    // ignore
  }
}

const storageRemove = (key: string): void => {
  try {
    safeLocalStorage()?.removeItem(key)
  } catch {
    // ignore
  }
}

const generateId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // fall through
  }
  // Fallback: not RFC-compliant but unique enough for an anonymous id.
  return `ckrm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
}

const loadOrCreateDistinctId = (): string => {
  const existing = storageGet(DID_KEY)
  if (existing) return existing
  const fresh = generateId()
  storageSet(DID_KEY, fresh)
  return fresh
}

// ---- property enrichment ------------------------------------------------

const baseProperties = (): Record<string, unknown> => {
  const props: Record<string, unknown> = {
    $lib: LIB_NAME,
    $lib_version: LIB_VERSION,
  }
  try {
    if (typeof location !== 'undefined') {
      props.$current_url = location.href
      props.$host = location.host
      props.$pathname = location.pathname
    }
    if (typeof document !== 'undefined') {
      props.$referrer = document.referrer
    }
    if (typeof window !== 'undefined' && window.screen) {
      props.$screen_height = window.screen.height
      props.$screen_width = window.screen.width
    }
    if (typeof window !== 'undefined') {
      props.$viewport_height = window.innerHeight
      props.$viewport_width = window.innerWidth
    }
    if (typeof navigator !== 'undefined') {
      Object.assign(props, parseDevice(navigator.userAgent, navigator.language))
    }
  } catch {
    // ignore — best-effort enrichment
  }
  return props
}

// Parses `document.referrer` + `location.search`'s utm_* params into
// `$utm_*`/`$channel_type` properties. Computed once per session (see
// `getSessionContextProps` below) rather than on every event.
const buildSessionContextProps = (): Record<string, unknown> => {
  try {
    const search = typeof location !== 'undefined' ? location.search : ''
    const referrer = typeof document !== 'undefined' ? document.referrer : ''
    const hostname = typeof location !== 'undefined' ? location.hostname : ''
    const utm = parseUtm(search)
    return { ...utm, $channel_type: classifyChannel(referrer, utm, hostname) }
  } catch {
    return {}
  }
}

// Returns the current session's cached channel/UTM props, recomputing only
// when the session id has rotated (new session -> re-parse the current URL).
const getSessionContextProps = (sessionId: string | undefined): Record<string, unknown> => {
  if (!sessionId) return buildSessionContextProps()
  if (!state.sessionContext || state.sessionContext.sessionId !== sessionId) {
    state.sessionContext = { sessionId, props: buildSessionContextProps() }
  }
  return state.sessionContext.props
}

// ---- core capture -------------------------------------------------------

const warnNotInit = (): void => {
  if (state.warnedNotInit) return
  state.warnedNotInit = true
  try {
    console.warn('[clickroom] capture() called before init(); event dropped')
  } catch {
    // ignore
  }
}

// Internal capture — accepts an optional elements_chain (used by autocapture).
const captureInternal = (
  event: string,
  properties?: Record<string, unknown>,
  elementsChain?: string,
): void => {
  if (!state.initialized || !state.transport) {
    warnNotInit()
    return
  }
  try {
    const sessionId = state.session?.getSessionId()
    const sessionProps = sessionId
      ? { $session_id: sessionId, $window_id: state.session?.getWindowId() }
      : {}
    const payload: EventPayload = {
      event,
      distinct_id: state.distinctId,
      timestamp: new Date().toISOString(),
      properties: {
        ...baseProperties(),
        ...sessionProps,
        ...getSessionContextProps(sessionId),
        ...(properties ?? {}),
      },
    }
    if (elementsChain) payload.elements_chain = elementsChain
    state.transport.enqueue(payload)
    // Drive event-triggered surveys off the captured event. Forward the merged property map so
    // survey `eventFilters` can match against both base + caller-supplied props. Skip internal
    // `$survey_*` events to avoid re-entrancy (captureShown → capture → trigger → show → …).
    if (state.surveyEventTrigger && !event.startsWith('$survey_')) {
      state.surveyEventTrigger(event, payload.properties)
    }
    // Same forwarding for support: fills the `recentEvents` ring that rides on a new ticket's
    // context bundle, and drives `triggers.events` auto-open. `$support_*` is skipped for the
    // same re-entrancy reason (captureShown → capture → trigger → show → …).
    if (state.supportEventTrigger && !event.startsWith('$support_')) {
      state.supportEventTrigger(event, payload.properties)
    }
  } catch {
    // never throw
  }
}

// ---- feature flags ------------------------------------------------------

// Flatten the cached flag results into the listener-facing map: `{ key: variant|enabled }`.
const flagFlatMap = (cache: FlagMap): Record<string, boolean | string> => {
  const flat: Record<string, boolean | string> = {}
  for (const [key, r] of Object.entries(cache)) {
    if (!r.enabled) continue
    flat[key] = r.variant != null ? r.variant : true
  }
  return flat
}

const fireFlagListeners = (): void => {
  if (!state.flagClient) return
  const flat = flagFlatMap(state.flagClient.getCache())
  for (const cb of state.flagListeners) {
    try {
      cb(flat)
    } catch {
      // a listener must not break the others
    }
  }
}

// Version-gated flag refresh: cheap version check first, only paying for a
// full fetch (+ exposure) when the version actually changed. Always notifies
// listeners afterward — matches the pre-existing "always notify after a
// refresh call finishes" contract, incl. fresh subscribers via onFeatureFlags.
// Never throws.
const refreshFlags = (force = false): void => {
  if (!state.flagClient) return
  state.flagClient
    .checkVersionAndMaybeFetch(force)
    .then(() => {
      state.flagsLoaded = true
      fireFlagListeners()
    })
    .catch(() => {
      // checkVersionAndMaybeFetch already swallows errors; belt-and-suspenders.
    })
}

// Emit a `$feature_flag_called` exposure event at most once per (key, response)
// per identity. Never throws — feature-flag reads must stay SSR-safe.
const maybeEmitFlagCall = (key: string, response: boolean | string): void => {
  try {
    // No real value yet — don't emit a misleading `false` before flags load.
    if (!state.flagsLoaded) return
    // Exposure-tracking gate: only flags under measurement carry
    // `track: true` in the server blob. Operational gates (untracked) must not
    // mint `$feature_flag_called` exposures — that was the phantom-user source.
    if (!state.flagClient?.getCache()[key]?.track) return
    const resp = String(response)
    const dedup = `${key}:${resp}`
    if (state.emittedFlagCalls.has(dedup)) return
    state.emittedFlagCalls.add(dedup)
    captureInternal('$feature_flag_called', {
      $feature_flag: key,
      $feature_flag_response: resp,
    })
  } catch {
    // never throw from a flag read
  }
}

// ---- public API ---------------------------------------------------------

// Host inferred by the CDN bundle (global.ts) from its own <script src>. Internal.
let inferredApiHost = ''

/** @internal Used by the CDN IIFE entry only. */
export function __setInferredApiHost(host: string): void {
  inferredApiHost = host
}

function init(writeKey: string, opts?: ClickroomOptions): void {
  if (state.initialized) return
  if (!isBrowser()) {
    // SSR: no-op init. Public methods remain safe no-ops.
    return
  }
  const apiHost = opts?.api_host || inferredApiHost
  if (!apiHost) {
    console.warn(
      '[clickroom] init() needs an `api_host` (e.g. your self-hosted capture URL, or ' +
        `CLICKROOM_CLOUD_HOST = "${CLICKROOM_CLOUD_HOST}"). The SDK is disabled.`,
    )
    return
  }

  state.writeKey = writeKey
  // Normalise `support` once, up front, into the config's `{ enabled, mode }` shape. A bare
  // `support: true` MUST behave byte-identically to today → `{ enabled: true, mode: 'launcher' }`.
  const support =
    opts?.support === true
      ? { enabled: true, mode: 'launcher' as const }
      : opts?.support === false || opts?.support == null
        ? { enabled: false, mode: 'launcher' as const }
        : { enabled: opts.support.enabled !== false, mode: opts.support.mode ?? 'launcher' }
  state.config = {
    api_host: apiHost,
    autocapture: opts?.autocapture ?? DEFAULT_CONFIG.autocapture,
    capture_pageview: opts?.capture_pageview ?? DEFAULT_CONFIG.capture_pageview,
    surveys: opts?.surveys ?? DEFAULT_CONFIG.surveys,
    survey_poll_interval: opts?.survey_poll_interval ?? DEFAULT_CONFIG.survey_poll_interval,
    support,
    support_poll_interval: opts?.support_poll_interval ?? DEFAULT_CONFIG.support_poll_interval,
  }

  state.distinctId = loadOrCreateDistinctId()
  // Session id lives in localStorage (origin-wide — one visit across every tab);
  // the window id lives in sessionStorage (per tab).
  state.session = createSessionManager({
    now: () => Date.now(),
    storage: safeLocalStorage,
    sessionStorage: safeSessionStorage,
    genId: generateId,
  })
  // Clearing the primary-window flag on unload is what lets a reload keep its window
  // id while a duplicated tab (flag still set in the cloned sessionStorage) mints a new one.
  try {
    window.addEventListener('beforeunload', () => state.session?.clearPrimaryWindow())
  } catch {
    // ignore — window-id clone detection is best-effort
  }
  state.transport = createTransport(
    () => state.config,
    () => state.writeKey,
  )
  state.flagClient = createFlagClient({
    getApiHost: () => state.config.api_host,
    getWriteKey: () => state.writeKey,
    getDistinctId: () => state.distinctId,
    getPersonProperties: () => state.personProperties,
  })
  state.initialized = true

  // Non-blocking: load flags for this distinct id, then notify listeners.
  refreshFlags()

  // Opt-in poll: re-fetch on an interval so long-lived pages (dashboards,
  // SPAs that rarely re-identify) see flag changes without a page reload.
  // Off by default — identical to pre-poll behavior when unset.
  if (opts?.feature_flag_poll_interval) {
    const intervalMs = Math.max(opts.feature_flag_poll_interval, MIN_FLAG_POLL_INTERVAL_MS)
    state.flagPollId = setInterval(() => refreshFlags(), intervalMs)
  }

  if (state.config.autocapture) {
    const ctx: AutocaptureContext = {
      config: state.config,
      capture: captureInternal,
    }
    try {
      state.teardownAutocapture = initAutocapture(ctx)
    } catch {
      // autocapture is best-effort; never break init
    }
  } else if (state.config.capture_pageview) {
    // Autocapture owns $pageview when enabled (incl. the first).
    // Only emit the initial pageview here when autocapture is off.
    captureInternal('$pageview')
  }

  // Opt-in survey delivery. Builds the survey client, warms the
  // /v1/surveys config cache, and gates eligibility on the flag client. Inert
  // (fetch + capture API only, shows nothing) until the render layer is
  // wired on top. Best-effort — never break init.
  if (state.config.surveys) {
    try {
      state.surveyClient = initSurveys({
        getApiHost: () => state.config.api_host,
        getWriteKey: () => state.writeKey,
        isFeatureEnabled: (key) => state.flagClient?.isFeatureEnabled(key) ?? false,
        capture: captureInternal,
        registerEventTrigger: (trigger) => {
          state.surveyEventTrigger = trigger
        },
        // `survey_poll_interval` of 0 disables polling; otherwise floor it so a misconfigured
        // caller can't hammer /v1/surveys.
        pollIntervalMs:
          state.config.survey_poll_interval > 0
            ? Math.max(state.config.survey_poll_interval, MIN_SURVEY_POLL_INTERVAL_MS)
            : 0,
        registerPollControl: (stop) => {
          state.surveyPollStop = stop
        },
      })
    } catch {
      // survey delivery is best-effort; never break init
    }
  }

  // Opt-in support widget. Builds the support client, warms the /v1/support config
  // cache, gates each form on the flag client and mounts the shadow-DOM widget. Off by default —
  // an existing embed fetches zero extra bytes. Best-effort — never break init.
  if (state.config.support.enabled) {
    try {
      state.supportClient = initSupport({
        // `mode` gates EXACTLY ONE call site: the FAB auto-mount at the end of initSupport.
        // 'launcher'/'both' → auto-mount; 'manual' → build the client, mount nothing.
        autoMount: state.config.support.mode !== 'manual',
        getApiHost: () => state.config.api_host,
        getWriteKey: () => state.writeKey,
        isFeatureEnabled: (key) => state.flagClient?.isFeatureEnabled(key) ?? false,
        capture: captureInternal,
        getDistinctId: () => state.distinctId,
        getPersonProperties: () => state.personProperties,
        getActiveFlags: () => (state.flagClient ? flagFlatMap(state.flagClient.getCache()) : {}),
        isIdentified: () => state.identified,
        registerEventTrigger: (trigger) => {
          state.supportEventTrigger = trigger
        },
        // `support_poll_interval` of 0 disables polling; otherwise floor it so a misconfigured
        // caller can't hammer /v1/support.
        pollIntervalMs:
          state.config.support_poll_interval > 0
            ? Math.max(state.config.support_poll_interval, MIN_SUPPORT_POLL_INTERVAL_MS)
            : 0,
        registerPollControl: (stop) => {
          state.supportPollStop = stop
        },
        registerMountedHandles: (getHandles) => {
          state.supportMountedHandles = getHandles
        },
      })
    } catch {
      // support delivery is best-effort; never break init
    }
  }
}

function capture(event: string, properties?: Record<string, unknown>): void {
  captureInternal(event, properties)
}

function identify(distinctId: string, personProps?: Record<string, unknown>): void {
  if (!state.initialized) {
    warnNotInit()
    return
  }
  const previousId = state.distinctId
  state.distinctId = distinctId
  state.identified = true
  storageSet(DID_KEY, distinctId)
  if (personProps) state.personProperties = { ...state.personProperties, ...personProps }
  captureInternal('$identify', {
    $set: personProps ?? {},
    ...(previousId !== distinctId ? { $anon_distinct_id: previousId } : {}),
  })
  // New identity re-exposes flags — drop the dedup set.
  state.emittedFlagCalls.clear()
  // Distinct id / person props changed — the cached flags were evaluated under
  // the old identity, so force a refetch that bypasses the version gate.
  // Without `force`, an org-targeted flag stays at its pre-identify (anonymous)
  // fallthrough value until the flag's server version happens to change.
  refreshFlags(true)
}

function reset(): void {
  try {
    // Clear all cached clickroom keys (flags, did, etc.).
    const ls = safeLocalStorage()
    if (ls) {
      const toRemove: string[] = []
      for (let i = 0; i < ls.length; i += 1) {
        const key = ls.key(i)
        if (key?.startsWith(STORAGE_PREFIX)) toRemove.push(key)
      }
      for (const key of toRemove) storageRemove(key)
    }
  } catch {
    // ignore
  }
  state.distinctId = generateId()
  state.identified = false
  storageSet(DID_KEY, state.distinctId)
  // New identity starts a fresh session.
  state.session?.reset()
  state.sessionContext = null
  // Drop cached flags + person props for the previous identity.
  state.personProperties = {}
  state.flagsLoaded = false
  state.emittedFlagCalls.clear()
  state.flagClient?.clear()
}

// ---- feature flags (public getters) -------------------------------------

function isFeatureEnabled(key: string): boolean {
  const result = state.flagClient?.isFeatureEnabled(key) ?? false
  maybeEmitFlagCall(key, result)
  return result
}

function getFeatureFlag(key: string): boolean | string {
  const result = state.flagClient?.getFeatureFlag(key) ?? false
  maybeEmitFlagCall(key, result)
  return result
}

function getFeatureFlagPayload(key: string): unknown {
  return state.flagClient?.getFeatureFlagPayload(key) ?? null
}

function onFeatureFlags(cb: (flags: Record<string, boolean | string>) => void): void {
  state.flagListeners.push(cb)
  // If flags are already loaded, fire immediately with the current map.
  if (state.flagsLoaded && state.flagClient) {
    try {
      cb(flagFlatMap(state.flagClient.getCache()))
    } catch {
      // ignore listener errors
    }
  }
}

/** Manually re-fetch flag definitions and notify `onFeatureFlags` listeners.
 * Same trigger `identify()` already uses internally — exposed directly so a
 * consumer can refresh on its own signal (a manual "reload flags" button, a
 * websocket/SSE event from elsewhere, etc.) without faking an identify call.
 * Version-gated (identity is unchanged here) — use `identify()` when the
 * distinct id / person props change and the cache must be re-evaluated. */
function refreshFeatureFlags(): void {
  refreshFlags()
}

/** The active survey client built by `init({ surveys: true })`, or `null` when survey delivery
 * is off / init hasn't run. Exposed so the headless React API (`./react`) can read the fetched
 * config + drive `$survey_*` capture off the same singleton instead of duplicating the client. */
function getSurveyClient(): SurveyClient | null {
  return state.surveyClient
}

/** The active support client built by `init({ support: true })`, or `null` when the support
 * widget is off / init hasn't run. Exposed so the headless React API (`./react`) can read the
 * fetched config + file tickets through the same singleton instead of building a second client. */
function getSupportClient(): SupportClient | null {
  return state.supportClient
}

/** Stop the `feature_flag_poll_interval` loop started in `init()`, if any. */
function stopFeatureFlagPolling(): void {
  if (state.flagPollId !== null) {
    clearInterval(state.flagPollId)
    state.flagPollId = null
  }
}

/** Stop the `survey_poll_interval` background loop started by `initSurveys`, if any. */
function stopSurveyPolling(): void {
  state.surveyPollStop?.()
  state.surveyPollStop = null
}

/** Stop the `support_poll_interval` background loop started by `initSupport`, if any. */
function stopSupportPolling(): void {
  state.supportPollStop?.()
  state.supportPollStop = null
}

// ---- public support namespace -------------------------

/** The most-recently `mount()`ed support handle — the first thing `clickroom.support.open()/
 *  .close()` steer, so a host's own "Help" nav item drives the surface it placed itself. Cleared
 *  when that handle is destroyed, at which point the pair fall back to the FAB `init({ support:
 *  true })` auto-mounted (reachable via `state.supportMountedHandles`). */
let primarySupportHandle: SupportRenderHandle | null = null

function trackSupportHandle(handle: SupportRenderHandle | null): SupportRenderHandle | null {
  if (!handle) return handle
  primarySupportHandle = handle
  const origDestroy = handle.destroy.bind(handle)
  handle.destroy = () => {
    if (primarySupportHandle === handle) primarySupportHandle = null
    origDestroy()
  }
  return handle
}

/** The surface `mount()` opens on. A bare `ticketId` with no explicit view deep-links straight to
 *  that thread; otherwise the caller's `view`, defaulting to the frame 4a `'home'`. The
 *  view→step mapping (`'new'` = the compose form) lives in `defaultSupportRenderer`. */
function resolveMountView(
  view: SupportMountOptions['view'],
  ticketId: string | undefined,
): NonNullable<SupportMountOptions['view']> {
  if (view) return view
  return ticketId != null ? 'thread' : 'home'
}

export interface SupportMountOptions {
  /** Where to mount — an element or a `document.querySelector` string. */
  el: HTMLElement | string
  /** `'inline'` (default) fills the container as a page; `'launcher'` mounts the FAB into it. */
  mode?: 'inline' | 'launcher'
  /** Which eligible form to mount. Omitted = the first eligible form. */
  formId?: string
  /** Initial surface. Inline (frame 4a): `'home'` (default) the search-first landing, `'search'`,
   *  `'bot'`; plus `'tickets'` the list, `'new'` a fresh conversation, `'thread'`. */
  view?: 'home' | 'search' | 'bot' | 'new' | 'tickets' | 'thread'
  /** Inline home posture (frame 4a): `'search'` (default) vs `'conversations'`. Falls back to
   *  conversations automatically when the form has no docs source connected. */
  home?: 'search' | 'conversations'
  /** Deep-link a specific thread (implies `view: 'thread'` when `view` is omitted). */
  ticketId?: string
  /** Fires when the user opens a thread, so the host can sync its own URL. */
  onTicketOpen?: (ticket: { id: string; number?: number }) => void
  /** Fires after a ticket is filed. */
  onTicketCreated?: (ticket: CreatedTicket) => void
}

/**
 * Mount the support surface into a host element, wired to the singleton support client (identity,
 * event context, form analytics, realtime replies — identical to the FAB). Returns the existing
 * `SupportRenderHandle` (`open()/close()/refresh()/destroy()`). Call `destroy()` on route leave.
 * Returns `null` when support is off, no matching form is eligible, or there is no DOM.
 */
function mountSupport(opts: SupportMountOptions): SupportRenderHandle | null {
  const client = state.supportClient
  if (!client || typeof document === 'undefined') return null

  const container =
    typeof opts.el === 'string' ? document.querySelector<HTMLElement>(opts.el) : opts.el
  if (!container) return null

  const forms = client.getEligibleForms()
  const form = opts.formId ? forms.find((f) => f.id === opts.formId) : forms[0]
  if (!form) return null

  const inline = (opts.mode ?? 'inline') === 'inline'

  // Same wiring as the auto-mounted FAB and `<ClickroomSupport />`: telemetry, seeded tickets,
  // the ticket API, realtime replies and `$support_*` capture all come from
  // `defaultSupportRenderer`. This function only resolves the host element + form and picks the
  // opening surface — there is exactly one copy of the callback block.
  const handle = defaultSupportRenderer(form, client, {
    container,
    // Inline forces `layout: 'inline'` (the renderer then drops the launcher/scrim/focus trap and
    // defaults `autoFocus` false); launcher passes no appearance so it reads the definition
    // exactly as the FAB does. Other appearance keys always fall back to the definition.
    ...(inline ? { appearance: { layout: 'inline' as const } } : {}),
    view: resolveMountView(opts.view, opts.ticketId),
    home: opts.home,
    ticketId: opts.ticketId,
    onTicketOpen: opts.onTicketOpen,
    onTicketCreated: opts.onTicketCreated,
  })

  return trackSupportHandle(handle ?? null)
}

/** The handle `open()`/`close()` steer: an explicit `mount()` when the host made one, else the FAB
 *  `init({ support: true })` auto-mounted (the common case — a customer's own "Help" nav item
 *  driving the default launcher). Null when support is off or nothing has mounted yet. */
function activeSupportHandle(): SupportRenderHandle | null {
  if (primarySupportHandle) return primarySupportHandle
  try {
    return state.supportMountedHandles?.()[0] ?? null
  } catch {
    // never break the SDK
    return null
  }
}

/** Open the support surface — the one a host mounted via `clickroom.support.mount()`, else the
 *  auto-mounted FAB. For a customer's own "Help" nav item. No-op when nothing is mounted. */
function openSupport(): void {
  activeSupportHandle()?.open()
}

/** Close the support surface `open()` would have opened. No-op when nothing is mounted. */
function closeSupport(): void {
  activeSupportHandle()?.close()
}

const supportApi = {
  mount: mountSupport,
  open: openSupport,
  close: closeSupport,
  getClient: getSupportClient,
}

// ---- singleton + named exports ------------------------------------------

const clickroom = {
  init,
  capture,
  identify,
  reset,
  isFeatureEnabled,
  getFeatureFlag,
  getFeatureFlagPayload,
  onFeatureFlags,
  refreshFeatureFlags,
  stopFeatureFlagPolling,
  stopSurveyPolling,
  stopSupportPolling,
  support: supportApi,
}

export type {
  CreatedTicket,
  CreateTicketInput,
  PresignedUpload,
  RecentEvent,
  StoredTicket,
  SupportAppearance,
  SupportChannel,
  SupportClient,
  SupportContext,
  SupportDefinition,
  SupportField,
  SupportFieldType,
  SupportForm,
  SupportFormAnalytics,
  SupportFormsResponse,
  SupportLayout,
  SupportPosition,
  SupportRouting,
  SupportSource,
  SupportTicketMessage,
  SupportTicketStreamHandlers,
  SupportTicketSubscription,
  SupportTicketSummary,
  SupportTicketThread,
  SupportTracking,
  SupportTriggers,
} from './support'
export {
  buildSupportContext,
  bumpStoredTicketUnread,
  createFormTelemetry,
  createSupportClient,
  defaultSupportRenderer,
  EVENT_SUPPORT_CSAT,
  EVENT_SUPPORT_DEFLECTED,
  EVENT_SUPPORT_OPENED,
  EVENT_SUPPORT_SHOWN,
  EVENT_SUPPORT_TICKET_CREATED,
  EVENT_SUPPORT_TICKET_RESOLVED,
  findStoredTicket,
  forgetTicket,
  initSupport,
  readStoredTickets,
  rememberTicket,
  setStoredTicketUnread,
} from './support'
// Bug-report payload shapes. Hand-mirrored by `supportBugReportSchema` (which pins itself
// against them with a `satisfies` guard) and by the Rust sanitizer — keep all three in sync.
export type {
  BugConsoleEntry,
  BugEnvironment,
  BugNetworkEntry,
  SupportBugReport,
} from './support-bug'
// Pure shadow-DOM render layer — import-reusable by the web builder's preview pane,
// no live SDK / config fetch / `$support_*` events required.
export type {
  RenderSupportOptions,
  SupportRenderHandle,
  SupportStep,
  SupportSubmission,
  SupportTicketRow,
  SupportView,
} from './support-render'
export { renderSupport } from './support-render'
export type {
  Survey,
  SurveyClient,
  SurveyDefinition,
  SurveyEventFilter,
  SurveyEventFilterOperator,
  SurveyQuestion,
  SurveyResponse,
  SurveysResponse,
  SurveyTriggers,
} from './survey'
export {
  buildSentProps,
  createSurveyClient,
  defaultSurveyRenderer,
  frequencyAllows,
  hasSelectorTrigger,
  initSurveys,
  matchesEvent,
  matchesEventFilters,
  matchesUrl,
  parseFrequency,
} from './survey'
// Pure shadow-DOM render layer — import-reusable by the web builder's preview pane,
// no live SDK / config fetch / `$survey_*` events required.
export type {
  RenderSurveyOptions,
  SurveyAppearance,
  SurveyPosition,
  SurveyRenderHandle,
} from './survey-render'
export { renderSurvey } from './survey-render'
export type {
  AutocaptureContext,
  ClickroomConfig,
  ClickroomOptions,
  EventPayload,
  SupportMode,
  SupportOptions,
} from './types'
export {
  capture,
  getFeatureFlag,
  getFeatureFlagPayload,
  getSupportClient,
  getSurveyClient,
  identify,
  init,
  isFeatureEnabled,
  mountSupport,
  onFeatureFlags,
  refreshFeatureFlags,
  reset,
  stopFeatureFlagPolling,
  stopSupportPolling,
  stopSurveyPolling,
  supportApi as support,
}
export default clickroom
