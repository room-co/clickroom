// @clickroom/sdk-js — survey config-fetch + trigger evaluation + `$survey_*` capture.
//
// This is the DATA/LOGIC layer only. It fetches the static survey config from the Rust
// `GET /v1/surveys` endpoint, caches it in localStorage with a version gate copying
// `flags.ts`, evaluates client-side triggers + display-frequency, gates eligibility on the flag
// client, and emits the `$survey_*` capture events. It does NOT render any DOM — the shadow-DOM
// popover is, which consumes the API exported here (fetch / trigger / eligibility / capture).
//
// -------------------------------------------------------------------------------------------------
// EXACT `$survey_*` property names — DO NOT rename without updating the ClickHouse MV.
// The `survey_events_mv` reads these from `properties` of `$survey_shown`/`$survey_dismissed`/
// `$survey_sent` events. The MV agent and this agent MUST agree on these strings:
//
//   $survey_id              → the survey id (string, ULID). Present on every survey event.
//   $survey_iteration       → the survey config version/iteration (number). MV column `interaction`
//                             is derived from the event NAME (shown|dismissed|sent), not a property.
//   $survey_response        → the PRIMARY response value (string). For a single-question survey this
//                             is that question's answer; for multi-question it is the first question's.
//   $survey_question_id     → the id of the question `$survey_response` belongs to.
//   $survey_response_<qid>  → per-question response, one key per answered question (the `*` fan-out).
//                             Multi-question breakdown reads these off the events table.
//
// Only `$survey_sent` carries `$survey_response*` / `$survey_question_id`; shown/dismissed carry
// just `$survey_id` + `$survey_iteration`.
// -------------------------------------------------------------------------------------------------

import { renderSurvey, type SurveyAppearance } from './survey-render'

export const SURVEY_PROP_ID = '$survey_id'
export const SURVEY_PROP_ITERATION = '$survey_iteration'
export const SURVEY_PROP_RESPONSE = '$survey_response'
export const SURVEY_PROP_QUESTION_ID = '$survey_question_id'
/** Prefix for the per-question fan-out: `$survey_response_<questionId>`. */
export const SURVEY_PROP_RESPONSE_PREFIX = '$survey_response_'

export const EVENT_SURVEY_SHOWN = '$survey_shown'
export const EVENT_SURVEY_DISMISSED = '$survey_dismissed'
export const EVENT_SURVEY_SENT = '$survey_sent'

// ---- config data model --------------------------------------------------

export type SurveyQuestionType = 'rating' | 'open' | 'single_choice' | 'multiple_choice' | 'link'

/** Loose question shape — the renderer and the tRPC schema own the strict
 *  discriminated union. This layer only needs `id` (for the response fan-out) and `type`. */
export interface SurveyQuestion {
  id: string
  type: SurveyQuestionType
  [k: string]: unknown
}

/** URL match: a bare string is treated as `contains`; the object form is explicit. */
export type SurveyUrlMatch = string | { type: 'exact' | 'contains' | 'regex'; value: string }

/** Display-frequency policy, persisted per survey id in localStorage.
 *  Wire form is a string: `"once"` | `"always"` | `"every_n_days:N"`. */
export type SurveyFrequency = 'once' | 'always' | string

/** Operators for filtering event triggers by the fired event's `properties`. */
export type SurveyEventFilterOperator = 'exact' | 'is_not' | 'icontains' | 'gt' | 'lt' | 'is_set'

/** A single event-property condition. `value` is ignored for `is_set`. */
export interface SurveyEventFilter {
  key: string
  operator: SurveyEventFilterOperator
  value?: unknown
}

export interface SurveyTriggers {
  /** Show when any of these custom events is captured. */
  events?: string[]
  /** Extra conditions on the fired event's `properties`; ALL must match. */
  eventFilters?: SurveyEventFilter[]
  /** Show only on URLs matching this. Absent = any URL. */
  urlMatch?: SurveyUrlMatch
  /** Show only after an element matching this CSS selector exists/clicked (renderer wires this). */
  selector?: string
  /** Delay before showing, once other triggers are satisfied. */
  delayMs?: number
  /** How often an eligible survey may re-show. Default `once`. */
  frequency?: SurveyFrequency
}

export interface SurveyDefinition {
  version: number
  questions: SurveyQuestion[]
  appearance?: Record<string, unknown>
  triggers?: SurveyTriggers
}

export interface Survey {
  id: string
  definition: SurveyDefinition
  /** Config version (bumped on every edit) — stamped as `$survey_iteration`. */
  version: number
  /** Linked feature flag that gates eligibility. Null = always eligible. */
  linkedFlagKey: string | null
}

export interface SurveysResponse {
  surveys: Survey[]
}

/** A completed survey response: `{ [questionId]: answer }`. */
export type SurveyResponse = Record<string, unknown>

// ---- storage helpers (SSR-safe) -----------------------------------------

const SURVEYS_STORAGE_KEY = 'ckrm_surveys'
const SEEN_KEY_PREFIX = 'ckrm_survey_seen_'
const DAY_MS = 24 * 60 * 60 * 1000

const safeLocalStorage = (): Storage | null => {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

// ---- frequency policy ---------------------------------------------------

type ParsedFrequency =
  | { kind: 'once' }
  | { kind: 'always' }
  | { kind: 'every_n_days'; days: number }

/** Parse the wire frequency (`once` | `always` | `every_n_days:N`). Unknown/malformed → `once`. */
export function parseFrequency(raw: SurveyFrequency | undefined): ParsedFrequency {
  if (!raw || raw === 'once') return { kind: 'once' }
  if (raw === 'always') return { kind: 'always' }
  const m = /^every_n_days:(\d+)$/.exec(raw)
  if (m) {
    const days = Number(m[1])
    if (Number.isFinite(days) && days > 0) return { kind: 'every_n_days', days }
  }
  return { kind: 'once' }
}

/** Per-survey display record persisted in localStorage. */
interface SeenRecord {
  /** epoch ms of the most recent `$survey_shown`. */
  lastShownAt?: number
  /** number of times shown. */
  shownCount?: number
  /** epoch ms of the `$survey_sent` (completed), if ever. */
  completedAt?: number
  /** epoch ms of the last `$survey_dismissed`, if ever. */
  dismissedAt?: number
}

const seenStorageKey = (surveyId: string): string => `${SEEN_KEY_PREFIX}${surveyId}`

const readSeen = (surveyId: string): SeenRecord => {
  try {
    const raw = safeLocalStorage()?.getItem(seenStorageKey(surveyId))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as SeenRecord
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    // ignore corrupt record
  }
  return {}
}

const writeSeen = (surveyId: string, rec: SeenRecord): void => {
  try {
    safeLocalStorage()?.setItem(seenStorageKey(surveyId), JSON.stringify(rec))
  } catch {
    // ignore quota / disabled storage
  }
}

/** Frequency gate only (ignores eligibility + momentary event/url/selector triggers). Exported
 *  so the renderer can reason about re-nag independently of the flag/trigger checks. */
export function frequencyAllows(
  survey: Survey,
  now: number,
  seen: SeenRecord = readSeen(survey.id),
): boolean {
  const policy = parseFrequency(survey.definition.triggers?.frequency)
  switch (policy.kind) {
    case 'always':
      return true
    case 'once':
      // Show once ever — a completed OR previously-shown survey never re-shows.
      return seen.completedAt === undefined && seen.lastShownAt === undefined
    case 'every_n_days': {
      // A completed survey never re-nags; otherwise honour the N-day cooldown.
      if (seen.completedAt !== undefined) return false
      if (seen.lastShownAt === undefined) return true
      return now - seen.lastShownAt >= policy.days * DAY_MS
    }
    default:
      return false
  }
}

// ---- trigger matching (pure) --------------------------------------------

/** True when `url` satisfies the survey's `urlMatch` (absent match = any URL). */
export function matchesUrl(survey: Survey, url: string): boolean {
  const match = survey.definition.triggers?.urlMatch
  if (match == null) return true
  if (typeof match === 'string') return url.includes(match)
  switch (match.type) {
    case 'exact':
      return url === match.value
    case 'contains':
      return url.includes(match.value)
    case 'regex':
      try {
        return new RegExp(match.value).test(url)
      } catch {
        return false
      }
    default:
      return false
  }
}

/**
 * True when every `eventFilters` condition holds against the fired event's `properties`.
 * Absent/empty filters pass trivially. A missing property (`undefined`/`null`) fails
 * `exact`/`icontains`/`gt`/`lt`/`is_set`, but passes `is_not` (a missing value is, correctly,
 * "not the target value"). `exact` compares string-coerced (loose) so `1 === "1"`.
 */
export function matchesEventFilters(
  filters: SurveyEventFilter[] | undefined,
  properties?: Record<string, unknown>,
): boolean {
  if (!Array.isArray(filters) || filters.length === 0) return true
  const props = properties ?? {}
  return filters.every((f) => {
    const actual = props[f.key]
    const present = actual !== undefined && actual !== null
    switch (f.operator) {
      case 'exact':
        return present && String(actual) === String(f.value)
      case 'is_not':
        // Missing property is "not the value" → passes.
        return !present || String(actual) !== String(f.value)
      case 'icontains':
        return present && String(actual).toLowerCase().includes(String(f.value).toLowerCase())
      case 'gt':
        return present && Number(actual) > Number(f.value)
      case 'lt':
        return present && Number(actual) < Number(f.value)
      case 'is_set':
        return present
      default:
        return false
    }
  })
}

/** True when the survey is triggered by the given custom event name AND all event filters match. */
export function matchesEvent(
  survey: Survey,
  eventName: string,
  properties?: Record<string, unknown>,
): boolean {
  const triggers = survey.definition.triggers
  const events = triggers?.events
  if (!Array.isArray(events) || !events.includes(eventName)) return false
  return matchesEventFilters(triggers?.eventFilters, properties)
}

/** True when the survey declares a CSS-selector trigger (the renderer wires the DOM match). */
export function hasSelectorTrigger(survey: Survey): boolean {
  return typeof survey.definition.triggers?.selector === 'string'
}

// ---- version gate -------------------------------------------------------

// Surveys have no cheap `/version` endpoint (unlike flags): the per-survey `version` fields ride
// inside the full `/v1/surveys` payload. So the gate is computed from the fetched config — an
// order-independent signature over `{id, version}` pairs. When it matches the cached signature the
// fetch short-circuits: the in-memory parsed surveys are kept as-is and localStorage is not
// rewritten, exactly the "short-circuit unchanged configs" intent of flags.ts's version gate.
const versionSignature = (surveys: Survey[]): string =>
  surveys
    .map((s) => `${s.id}:${s.version}`)
    .sort()
    .join('|')

interface CachedSurveys {
  signature: string
  surveys: Survey[]
}

// ---- capture property shaping -------------------------------------------

const baseSurveyProps = (survey: Survey): Record<string, unknown> => ({
  [SURVEY_PROP_ID]: survey.id,
  [SURVEY_PROP_ITERATION]: survey.version,
})

/** Coerce a numeric answer (e.g. a rating `4`) to its string form so it survives the ClickHouse
 *  `survey_events_mv`'s `JSONExtractString(properties, '$survey_response')` — which returns `''`
 *  for any non-string JSON value, silently losing rating/scale answers. Strings, arrays (multiple
 *  choice) and every other type pass through unchanged; the results `buildSurveyScore` path re-
 *  parses the stringified number via `toFloat64OrNull`, so `"4"` still scores as `4`. */
const coerceAnswer = (answer: unknown): unknown =>
  typeof answer === 'number' ? String(answer) : answer

/** Build the `$survey_sent` properties from a completed response map. The first question in the
 *  definition supplies the primary `$survey_response` / `$survey_question_id`; every answered
 *  question also gets a `$survey_response_<qid>` fan-out key. */
export function buildSentProps(survey: Survey, response: SurveyResponse): Record<string, unknown> {
  const props: Record<string, unknown> = baseSurveyProps(survey)
  const questions = survey.definition.questions ?? []

  // Primary response = first defined question that has an answer (falls back to first question).
  const primary = questions.find((q) => response[q.id] !== undefined) ?? questions[0]
  if (primary) {
    props[SURVEY_PROP_QUESTION_ID] = primary.id
    if (response[primary.id] !== undefined)
      props[SURVEY_PROP_RESPONSE] = coerceAnswer(response[primary.id])
  }

  // Per-question fan-out.
  for (const [questionId, answer] of Object.entries(response)) {
    if (answer === undefined) continue
    props[`${SURVEY_PROP_RESPONSE_PREFIX}${questionId}`] = coerceAnswer(answer)
  }
  return props
}

// ---- client -------------------------------------------------------------

export interface SurveyClientDeps {
  getApiHost: () => string
  getWriteKey: () => string
  /** From the SDK's flag client — a survey is eligible iff its linked flag is enabled. */
  isFeatureEnabled: (key: string) => boolean
  /** Emit an event through the SDK core (`captureInternal`). */
  capture: (event: string, properties?: Record<string, unknown>) => void
  /** Clock — injectable for tests. Defaults to `Date.now`. */
  now?: () => number
}

export interface SurveyClient {
  /** All fetched surveys (in-memory, or restored from localStorage). */
  getSurveys(): Survey[]
  /** Fetch `/v1/surveys`, version-gate, cache. Never throws — falls back to the cached config. */
  fetchSurveys(): Promise<Survey[]>
  /** Whether the survey's linked flag is enabled (null flag = always eligible). */
  isEligible(survey: Survey): boolean
  /** Fetched surveys whose linked flag is enabled. */
  getEligibleSurveys(): Survey[]
  /** Eligibility + display-frequency gate. Does NOT check momentary event/url/selector triggers —
   *  those are matched via `matchesEvent`/`matchesUrl`/`hasSelectorTrigger` by the renderer. */
  shouldShowSurvey(survey: Survey): boolean
  /** Eligible surveys triggered by a custom event (matching its `properties` filters), still
   *  within their frequency budget. */
  surveysForEvent(eventName: string, properties?: Record<string, unknown>): Survey[]
  /** Eligible surveys triggered by a URL, still within their frequency budget. */
  surveysForUrl(url: string): Survey[]
  /** Emit `$survey_shown` and record the display for the frequency policy. */
  captureShown(survey: Survey): void
  /** Emit `$survey_dismissed` and record the dismissal. */
  captureDismissed(survey: Survey): void
  /** Emit `$survey_sent` (with the response fan-out) and mark the survey completed. */
  captureSent(survey: Survey, response: SurveyResponse): void
  /** Drop the in-memory + persisted survey config cache (NOT the per-survey seen records). */
  clear(): void
}

export function createSurveyClient(deps: SurveyClientDeps): SurveyClient {
  const now = deps.now ?? (() => Date.now())

  let surveys: Survey[] = restoreCache()
  let lastSignature: string = versionSignature(surveys)

  function restoreCache(): Survey[] {
    try {
      const raw = safeLocalStorage()?.getItem(SURVEYS_STORAGE_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as CachedSurveys
      if (parsed && Array.isArray(parsed.surveys)) return parsed.surveys
    } catch {
      // ignore corrupt cache
    }
    return []
  }

  const persist = (): void => {
    try {
      const payload: CachedSurveys = { signature: lastSignature, surveys }
      safeLocalStorage()?.setItem(SURVEYS_STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // ignore quota / disabled storage
    }
  }

  const buildUrl = (): string => {
    const base = deps.getApiHost().replace(/\/+$/, '')
    return `${base}/v1/surveys`
  }

  const parseSurveys = (data: unknown): Survey[] | null => {
    const list = (data as SurveysResponse | undefined)?.surveys
    if (!Array.isArray(list)) return null
    // Keep only well-formed entries with a usable definition.
    return list.filter(
      (s): s is Survey =>
        !!s &&
        typeof s.id === 'string' &&
        typeof s.version === 'number' &&
        !!s.definition &&
        Array.isArray(s.definition.questions),
    )
  }

  const fetchSurveys = async (): Promise<Survey[]> => {
    try {
      if (typeof fetch !== 'function') return surveys
      const res = await fetch(buildUrl(), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${deps.getWriteKey()}`,
        },
      })
      if (!res.ok) return surveys // fall back to existing cache
      const next = parseSurveys(await res.json())
      if (!next) return surveys
      const signature = versionSignature(next)
      // Version gate: unchanged config short-circuits — keep the parsed cache, skip the rewrite.
      if (signature === lastSignature && surveys.length === next.length) return surveys
      surveys = next
      lastSignature = signature
      persist()
      return surveys
    } catch {
      // Network / parse failure — keep whatever cache we have (incl. localStorage).
      return surveys
    }
  }

  const isEligible = (survey: Survey): boolean => {
    if (survey.linkedFlagKey == null) return true
    return deps.isFeatureEnabled(survey.linkedFlagKey)
  }

  const shouldShowSurvey = (survey: Survey): boolean =>
    isEligible(survey) && frequencyAllows(survey, now())

  const getEligibleSurveys = (): Survey[] => surveys.filter(isEligible)

  const surveysForEvent = (eventName: string, properties?: Record<string, unknown>): Survey[] =>
    surveys.filter((s) => matchesEvent(s, eventName, properties) && shouldShowSurvey(s))

  const surveysForUrl = (url: string): Survey[] =>
    surveys.filter((s) => matchesUrl(s, url) && shouldShowSurvey(s))

  const captureShown = (survey: Survey): void => {
    deps.capture(EVENT_SURVEY_SHOWN, baseSurveyProps(survey))
    const rec = readSeen(survey.id)
    writeSeen(survey.id, {
      ...rec,
      lastShownAt: now(),
      shownCount: (rec.shownCount ?? 0) + 1,
    })
  }

  const captureDismissed = (survey: Survey): void => {
    deps.capture(EVENT_SURVEY_DISMISSED, baseSurveyProps(survey))
    const rec = readSeen(survey.id)
    writeSeen(survey.id, { ...rec, dismissedAt: now() })
  }

  const captureSent = (survey: Survey, response: SurveyResponse): void => {
    deps.capture(EVENT_SURVEY_SENT, buildSentProps(survey, response))
    const rec = readSeen(survey.id)
    writeSeen(survey.id, { ...rec, completedAt: now() })
  }

  return {
    getSurveys: () => surveys,
    fetchSurveys,
    isEligible,
    getEligibleSurveys,
    shouldShowSurvey,
    surveysForEvent,
    surveysForUrl,
    captureShown,
    captureDismissed,
    captureSent,
    clear: () => {
      surveys = []
      lastSignature = ''
      try {
        safeLocalStorage()?.removeItem(SURVEYS_STORAGE_KEY)
      } catch {
        // ignore
      }
    },
  }
}

// ---- init hook ----------------------------------------------------------

/** Optional render layer. Given the client + the surveys ready to show, it mounts the
 *  popover. Kept out of this module so the fetch/trigger/capture layer stays DOM-free and inert
 *  when no renderer is wired. */
export type SurveyRenderer = (survey: Survey, client: SurveyClient) => void

/** Drives event-triggered surveys: called with each captured event's name + `properties` so the
 *  survey's `events` list AND `eventFilters` can be evaluated against the actual event. */
export type SurveyEventTrigger = (eventName: string, properties?: Record<string, unknown>) => void

export interface InitSurveysConfig extends SurveyClientDeps {
  /** Overrides the default shadow-DOM popover renderer. Omitted = the built-in `renderSurvey`
   * is used when a DOM is present; `null` forces the inert data-only mode. */
  render?: SurveyRenderer | null
  /** Receives the event-trigger evaluator so the SDK core can forward captured events (name +
   *  properties) into the survey render path. Optional — omit for the inert data-only mode. */
  registerEventTrigger?: (trigger: SurveyEventTrigger) => void
  /** Background re-fetch interval in ms. `>0` enables the TTL poll loop; `0`/`undefined` keeps the
   *  fetch-once-on-init behavior. The SDK core floors this before passing it in. */
  pollIntervalMs?: number
  /** Receives a `stop()` that halts the background poll loop (parity with `registerEventTrigger` /
   *  the feature-flag polling teardown in `index.ts`). Optional — omit if you never need to stop. */
  registerPollControl?: (stop: () => void) => void
}

/**
 * The default render layer: mount the shadow-DOM popover for a triggered+eligible survey.
 * Emits `$survey_shown` on mount, `$survey_sent` on submit, `$survey_dismissed` on close — all
 * through the client, which also persists the display so frequency policy prevents re-nag. Kept
 * here (not in `survey-render.ts`) so the pure renderer stays free of the config client.
 */
export const defaultSurveyRenderer: SurveyRenderer = (survey, client) => {
  if (typeof document === 'undefined') return
  renderSurvey(survey.definition, {
    appearance: survey.definition.appearance as SurveyAppearance | undefined,
    onShown: () => client.captureShown(survey),
    onResponse: (response) => client.captureSent(survey, response),
    onDismiss: () => client.captureDismissed(survey),
  })
}

/** True when the survey needs a custom event to fire (so it must NOT auto-show on page load). */
const isEventTriggered = (survey: Survey): boolean => {
  const events = survey.definition.triggers?.events
  return Array.isArray(events) && events.length > 0
}

/**
 * Build the survey client, warm the config cache, and — when a renderer is available — drive the
 * shadow-DOM popover for URL-triggered surveys on load (respecting `delayMs` + display-frequency).
 * Wired from `index.ts` behind the `surveys` config option, mirroring how autocapture is
 * initialized. Pass `render: null` for the inert data-only mode (fetch + capture API, shows
 * nothing). Event/selector-triggered surveys are left for the caller to drive via
 * `client.surveysForEvent(...)` + the exported `renderSurvey`. Never throws.
 */
export function initSurveys(config: InitSurveysConfig): SurveyClient {
  const client = createSurveyClient(config)
  const render =
    config.render === null
      ? undefined
      : (config.render ?? (typeof document !== 'undefined' ? defaultSurveyRenderer : undefined))

  // Guard against mounting a SECOND popover for a survey whose popover is still on screen — but
  // NOT against ever re-showing it. A `frequency: 'always'` survey must re-open on every matching
  // event; a per-page "already shown" set (the old bug) permanently suppressed it after the first
  // fire. The `openSurveyIds` lock is released the moment the popover is dismissed or submitted (via
  // the wrapped client below), so the next event re-shows it. Longer-lived frequency policies
  // (`once`, `every_n_days`) are still enforced by `shouldShowSurvey` → `frequencyAllows`.
  const openSurveyIds = new Set<string>()

  // The renderer sees a client whose terminal callbacks (dismiss/submit) also release the open
  // lock, so an `always` survey can re-open next time. `captureShown`/emission are untouched —
  // events still flow through the real client → `captureInternal`.
  const renderClient: SurveyClient = {
    ...client,
    captureDismissed: (survey: Survey) => {
      openSurveyIds.delete(survey.id)
      client.captureDismissed(survey)
    },
    captureSent: (survey: Survey, response: SurveyResponse) => {
      openSurveyIds.delete(survey.id)
      client.captureSent(survey, response)
    },
  }

  const show = (survey: Survey): void => {
    if (!render || openSurveyIds.has(survey.id)) return
    // Re-check the frequency/eligibility gate at show time (a delay may have elapsed).
    if (!client.shouldShowSurvey(survey)) return
    openSurveyIds.add(survey.id)
    try {
      render(survey, renderClient)
    } catch {
      // render is best-effort; never break the SDK — release the lock so a retry can re-show.
      openSurveyIds.delete(survey.id)
    }
  }

  const evaluateUrl = (): void => {
    if (!render) return
    try {
      const url = typeof location !== 'undefined' ? location.href : ''
      for (const survey of client.surveysForUrl(url)) {
        if (isEventTriggered(survey)) continue // wait for the event, don't auto-show on load
        const delay = Number(survey.definition.triggers?.delayMs ?? 0)
        if (delay > 0) setTimeout(() => show(survey), delay)
        else show(survey)
      }
    } catch {
      // never break the SDK
    }
  }

  // Drive event-triggered surveys: an event fires → show every eligible survey whose `events`
  // list includes it AND whose `eventFilters` match the fired `properties` (respecting `delayMs`).
  const evaluateEvent: SurveyEventTrigger = (eventName, properties) => {
    if (!render) return
    try {
      for (const survey of client.surveysForEvent(eventName, properties)) {
        const delay = Number(survey.definition.triggers?.delayMs ?? 0)
        if (delay > 0) setTimeout(() => show(survey), delay)
        else show(survey)
      }
    } catch {
      // never break the SDK
    }
  }
  config.registerEventTrigger?.(evaluateEvent)

  // ---- background TTL poll ---------------------------------
  //
  // Re-fetch `/v1/surveys` on an interval so a survey created mid-session reaches a long-lived
  // page (dashboard / SPA that never reloads) without a refresh. Two deliberate divergences from
  // PostHog's survey poll:
  //
  //  1. COLD START: PostHog only starts its poll when the project had ≥1 survey at load, so a
  //     project that shipped its FIRST survey after a client loaded never surfaces it until reload.
  //     We start the loop whenever `pollIntervalMs > 0`, even from zero surveys — and also on the
  //     initial fetch's `.catch`, so a transient first-fetch failure still retries.
  //
  //  2. CHANGE DETECTION BY REFERENCE EQUALITY: `fetchSurveys()` returns the SAME array reference
  //     when the version gate short-circuits (config unchanged) and a NEW reference when it
  //     changed. `refresh()` re-evaluates URL triggers ONLY when the reference changed, so an
  //     unchanged tick doesn't re-nag a `frequency: 'always'` URL survey every interval. Event-
  //     triggered surveys need no re-eval — `evaluateEvent` reads the live in-memory list on the
  //     next captured event.
  const pollIntervalMs = Number(config.pollIntervalMs ?? 0)

  // refresh() = re-fetch + re-run the URL pass ONLY if the config reference actually changed.
  const refresh = (): void => {
    const before = client.getSurveys()
    client
      .fetchSurveys()
      .then((after) => {
        if (after !== before) evaluateUrl()
      })
      .catch(() => {
        // fetchSurveys already swallows errors; belt-and-suspenders.
      })
  }

  const startPolling = (): void => {
    if (pollIntervalMs <= 0) return
    if (typeof document === 'undefined' || typeof setInterval !== 'function') return

    let intervalId: ReturnType<typeof setInterval> | null = null
    let stopped = false

    const clearTimer = (): void => {
      if (intervalId !== null) {
        clearInterval(intervalId)
        intervalId = null
      }
    }

    const startTimer = (): void => {
      if (stopped || intervalId !== null) return
      intervalId = setInterval(refresh, pollIntervalMs)
    }

    // Mirror PostHog: pause the interval while the tab is hidden, and on becoming visible again
    // catch up immediately (refresh) then restart. Once stopped, visibility changes are inert.
    const onVisibility = (): void => {
      try {
        if (document.hidden) {
          clearTimer()
        } else if (!stopped) {
          refresh()
          startTimer()
        }
      } catch {
        // never break the SDK
      }
    }

    const stop = (): void => {
      stopped = true
      clearTimer()
    }

    try {
      document.addEventListener('visibilitychange', onVisibility)
    } catch {
      // visibility handling is best-effort
    }

    // Don't run the interval while the tab is already hidden on start.
    if (!document.hidden) startTimer()

    config.registerPollControl?.(stop)
  }

  // Non-blocking: warm the config cache, run the URL-trigger pass, then start the poll loop.
  // Start polling on BOTH resolve and reject so cold-start (zero surveys) and a transient initial
  // failure both keep retrying on the interval.
  client
    .fetchSurveys()
    .then(() => {
      evaluateUrl()
      startPolling()
    })
    .catch(() => {
      // fetchSurveys already swallows errors; belt-and-suspenders.
      startPolling()
    })
  return client
}
