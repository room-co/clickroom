// Survey config client + trigger evaluation + `$survey_*` capture.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildSentProps,
  createSurveyClient,
  EVENT_SURVEY_DISMISSED,
  EVENT_SURVEY_SENT,
  EVENT_SURVEY_SHOWN,
  frequencyAllows,
  initSurveys,
  matchesEvent,
  matchesEventFilters,
  matchesUrl,
  parseFrequency,
  SURVEY_PROP_ID,
  SURVEY_PROP_ITERATION,
  SURVEY_PROP_QUESTION_ID,
  SURVEY_PROP_RESPONSE,
  SURVEY_PROP_RESPONSE_PREFIX,
  type Survey,
  type SurveyClientDeps,
} from '../survey'

// ---- in-memory localStorage stub ---------------------------------------

let storageMap: Map<string, string>

const makeStorage = (): Storage => {
  storageMap = new Map<string, string>()
  return {
    getItem: (k: string) => (storageMap.has(k) ? (storageMap.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      storageMap.set(k, String(v))
    },
    removeItem: (k: string) => {
      storageMap.delete(k)
    },
    key: (i: number) => Array.from(storageMap.keys())[i] ?? null,
    clear: () => storageMap.clear(),
    get length() {
      return storageMap.size
    },
  } as Storage
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---- fixtures -----------------------------------------------------------

const makeSurvey = (over: Partial<Survey> = {}): Survey => ({
  id: 'srv_1',
  version: 1,
  linkedFlagKey: 'flag-1',
  definition: {
    version: 1,
    questions: [{ id: 'q1', type: 'rating' }],
    triggers: { frequency: 'once' },
  },
  ...over,
})

const makeDeps = (
  over: Partial<SurveyClientDeps> = {},
): SurveyClientDeps & {
  captured: Array<{ event: string; props?: Record<string, unknown> }>
} => {
  const captured: Array<{ event: string; props?: Record<string, unknown> }> = []
  return {
    getApiHost: () => 'https://capture.example.com',
    getWriteKey: () => 'wk_test',
    isFeatureEnabled: () => true,
    capture: (event, props) => captured.push({ event, props }),
    now: () => 1_000_000,
    captured,
    ...over,
  }
}

// ---- frequency parsing --------------------------------------------------

describe('parseFrequency', () => {
  it('parses the three wire forms', () => {
    expect(parseFrequency('once')).toEqual({ kind: 'once' })
    expect(parseFrequency('always')).toEqual({ kind: 'always' })
    expect(parseFrequency('every_n_days:7')).toEqual({ kind: 'every_n_days', days: 7 })
  })

  it('defaults malformed / undefined to once', () => {
    expect(parseFrequency(undefined)).toEqual({ kind: 'once' })
    expect(parseFrequency('every_n_days:0')).toEqual({ kind: 'once' })
    expect(parseFrequency('garbage')).toEqual({ kind: 'once' })
  })
})

describe('frequencyAllows', () => {
  it('once: shows only when never shown or completed', () => {
    const s = makeSurvey({
      definition: { version: 1, questions: [], triggers: { frequency: 'once' } },
    })
    expect(frequencyAllows(s, 0, {})).toBe(true)
    expect(frequencyAllows(s, 0, { lastShownAt: 1 })).toBe(false)
    expect(frequencyAllows(s, 0, { completedAt: 1 })).toBe(false)
  })

  it('always: shows regardless of history', () => {
    const s = makeSurvey({
      definition: { version: 1, questions: [], triggers: { frequency: 'always' } },
    })
    expect(frequencyAllows(s, 0, { lastShownAt: 1, completedAt: 1 })).toBe(true)
  })

  it('every_n_days: honours the cooldown and never re-nags a completed survey', () => {
    const day = 24 * 60 * 60 * 1000
    const s = makeSurvey({
      definition: { version: 1, questions: [], triggers: { frequency: 'every_n_days:3' } },
    })
    expect(frequencyAllows(s, 0, {})).toBe(true)
    expect(frequencyAllows(s, 2 * day, { lastShownAt: 0 })).toBe(false)
    expect(frequencyAllows(s, 3 * day, { lastShownAt: 0 })).toBe(true)
    expect(frequencyAllows(s, 100 * day, { lastShownAt: 0, completedAt: 1 })).toBe(false)
  })
})

// ---- trigger matching ---------------------------------------------------

describe('matchesUrl', () => {
  it('absent match = any URL', () => {
    expect(matchesUrl(makeSurvey({ definition: { version: 1, questions: [] } }), '/x')).toBe(true)
  })

  it('string form = contains', () => {
    const s = makeSurvey({
      definition: { version: 1, questions: [], triggers: { urlMatch: '/checkout' } },
    })
    expect(matchesUrl(s, 'https://a.com/checkout/step-1')).toBe(true)
    expect(matchesUrl(s, 'https://a.com/home')).toBe(false)
  })

  it('object exact / regex forms', () => {
    const exact = makeSurvey({
      definition: {
        version: 1,
        questions: [],
        triggers: { urlMatch: { type: 'exact', value: '/p' } },
      },
    })
    expect(matchesUrl(exact, '/p')).toBe(true)
    expect(matchesUrl(exact, '/p/1')).toBe(false)

    const rx = makeSurvey({
      definition: {
        version: 1,
        questions: [],
        triggers: { urlMatch: { type: 'regex', value: '^/p/\\d+$' } },
      },
    })
    expect(matchesUrl(rx, '/p/42')).toBe(true)
    expect(matchesUrl(rx, '/p/x')).toBe(false)
  })
})

describe('matchesEvent', () => {
  it('matches declared trigger events only', () => {
    const s = makeSurvey({
      definition: { version: 1, questions: [], triggers: { events: ['purchase', 'signup'] } },
    })
    expect(matchesEvent(s, 'purchase')).toBe(true)
    expect(matchesEvent(s, 'pageview')).toBe(false)
    expect(matchesEvent(makeSurvey({ definition: { version: 1, questions: [] } }), 'x')).toBe(false)
  })

  it('requires both the event name AND every eventFilter to match', () => {
    const s = makeSurvey({
      definition: {
        version: 1,
        questions: [],
        triggers: {
          events: ['purchase'],
          eventFilters: [{ key: 'plan', operator: 'exact', value: 'pro' }],
        },
      },
    })
    // right event, matching filter
    expect(matchesEvent(s, 'purchase', { plan: 'pro' })).toBe(true)
    // right event, filter fails
    expect(matchesEvent(s, 'purchase', { plan: 'free' })).toBe(false)
    // wrong event short-circuits regardless of filters
    expect(matchesEvent(s, 'signup', { plan: 'pro' })).toBe(false)
  })
})

describe('matchesEventFilters', () => {
  it('empty / absent filters always pass', () => {
    expect(matchesEventFilters(undefined, { a: 1 })).toBe(true)
    expect(matchesEventFilters([], { a: 1 })).toBe(true)
    expect(matchesEventFilters(undefined, undefined)).toBe(true)
  })

  it('exact: loose string-coerced equality', () => {
    const f = [{ key: 'n', operator: 'exact' as const, value: 1 }]
    expect(matchesEventFilters(f, { n: 1 })).toBe(true)
    expect(matchesEventFilters(f, { n: '1' })).toBe(true) // coerced
    expect(matchesEventFilters(f, { n: 2 })).toBe(false)
  })

  it('is_not: not-equal, and a missing property passes', () => {
    const f = [{ key: 'plan', operator: 'is_not' as const, value: 'free' }]
    expect(matchesEventFilters(f, { plan: 'pro' })).toBe(true)
    expect(matchesEventFilters(f, { plan: 'free' })).toBe(false)
    expect(matchesEventFilters(f, {})).toBe(true) // missing → not the value
  })

  it('icontains: case-insensitive substring', () => {
    const f = [{ key: 'path', operator: 'icontains' as const, value: 'Checkout' }]
    expect(matchesEventFilters(f, { path: '/app/checkout/step' })).toBe(true)
    expect(matchesEventFilters(f, { path: '/home' })).toBe(false)
    expect(matchesEventFilters(f, {})).toBe(false) // missing fails
  })

  it('gt / lt: numeric comparison', () => {
    const gt = [{ key: 'total', operator: 'gt' as const, value: 100 }]
    expect(matchesEventFilters(gt, { total: 150 })).toBe(true)
    expect(matchesEventFilters(gt, { total: 50 })).toBe(false)
    expect(matchesEventFilters(gt, {})).toBe(false)

    const lt = [{ key: 'total', operator: 'lt' as const, value: 100 }]
    expect(matchesEventFilters(lt, { total: 50 })).toBe(true)
    expect(matchesEventFilters(lt, { total: 150 })).toBe(false)
    expect(matchesEventFilters(lt, {})).toBe(false)
  })

  it('is_set: property present and not null/undefined (value ignored)', () => {
    const f = [{ key: 'email', operator: 'is_set' as const }]
    expect(matchesEventFilters(f, { email: 'a@b.co' })).toBe(true)
    expect(matchesEventFilters(f, { email: '' })).toBe(true) // empty string is set
    expect(matchesEventFilters(f, { email: null })).toBe(false)
    expect(matchesEventFilters(f, {})).toBe(false)
  })

  it('all conditions must hold (AND semantics)', () => {
    const f = [
      { key: 'plan', operator: 'exact' as const, value: 'pro' },
      { key: 'total', operator: 'gt' as const, value: 10 },
    ]
    expect(matchesEventFilters(f, { plan: 'pro', total: 20 })).toBe(true)
    expect(matchesEventFilters(f, { plan: 'pro', total: 5 })).toBe(false)
  })
})

// ---- capture prop shaping ----------------------------------------------

describe('buildSentProps', () => {
  it('single-question: primary response + fan-out + id/iteration', () => {
    const s = makeSurvey({
      version: 3,
      definition: { version: 3, questions: [{ id: 'q1', type: 'rating' }] },
    })
    const props = buildSentProps(s, { q1: 9 })
    expect(props[SURVEY_PROP_ID]).toBe('srv_1')
    expect(props[SURVEY_PROP_ITERATION]).toBe(3)
    expect(props[SURVEY_PROP_QUESTION_ID]).toBe('q1')
    // Numeric rating answers are stringified so the MV's `JSONExtractString` captures them.
    expect(props[SURVEY_PROP_RESPONSE]).toBe('9')
    expect(props[`${SURVEY_PROP_RESPONSE_PREFIX}q1`]).toBe('9')
  })

  it('stringifies numeric (rating) answers but leaves string / array answers intact', () => {
    const s = makeSurvey({
      definition: {
        version: 1,
        questions: [
          { id: 'q1', type: 'rating' },
          { id: 'q2', type: 'open' },
          { id: 'q3', type: 'multiple_choice' },
        ],
      },
    })
    const props = buildSentProps(s, { q1: 4, q2: 'great', q3: ['a', 'b'] })
    // rating number → its string form
    expect(props[`${SURVEY_PROP_RESPONSE_PREFIX}q1`]).toBe('4')
    // string answer unchanged
    expect(props[`${SURVEY_PROP_RESPONSE_PREFIX}q2`]).toBe('great')
    // array (multiple choice) unchanged
    expect(props[`${SURVEY_PROP_RESPONSE_PREFIX}q3`]).toEqual(['a', 'b'])
  })

  it('multi-question: first answered is primary, every answer gets a fan-out key', () => {
    const s = makeSurvey({
      definition: {
        version: 1,
        questions: [
          { id: 'q1', type: 'rating' },
          { id: 'q2', type: 'open' },
        ],
      },
    })
    const props = buildSentProps(s, { q1: 5, q2: 'great' })
    expect(props[SURVEY_PROP_QUESTION_ID]).toBe('q1')
    expect(props[SURVEY_PROP_RESPONSE]).toBe('5')
    expect(props[`${SURVEY_PROP_RESPONSE_PREFIX}q1`]).toBe('5')
    expect(props[`${SURVEY_PROP_RESPONSE_PREFIX}q2`]).toBe('great')
  })
})

// ---- config client fetch + version gate --------------------------------

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as Response

describe('createSurveyClient — fetch + version gate', () => {
  it('fetches GET /v1/surveys with the write-key bearer and caches to localStorage', async () => {
    const survey = makeSurvey()
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      okJson({ surveys: [survey] }),
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const client = createSurveyClient(makeDeps())
    const got = await client.fetchSurveys()

    expect(got).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://capture.example.com/v1/surveys')
    expect(init?.method).toBe('GET')
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer wk_test')
    expect(storageMap.has('ckrm_surveys')).toBe(true)
  })

  it('version gate: unchanged signature does not rewrite the cache', async () => {
    const survey = makeSurvey()
    const fetchMock = vi.fn(async () => okJson({ surveys: [survey] }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const client = createSurveyClient(makeDeps())
    await client.fetchSurveys()
    const setSpy = vi.spyOn(localStorage, 'setItem')
    await client.fetchSurveys() // same version -> short-circuit
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('a bumped version re-persists the new config', async () => {
    let version = 1
    const fetchMock = vi.fn(async () => okJson({ surveys: [makeSurvey({ version })] }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const client = createSurveyClient(makeDeps())
    await client.fetchSurveys()
    version = 2
    await client.fetchSurveys()
    expect(client.getSurveys()[0].version).toBe(2)
  })

  it('never throws on a failed response — falls back to cache', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }) as Response) as unknown as typeof fetch,
    )
    const client = createSurveyClient(makeDeps())
    await expect(client.fetchSurveys()).resolves.toEqual([])
  })

  it('restores cached surveys from localStorage on construction', async () => {
    const survey = makeSurvey()
    const fetchMock = vi.fn(async () => okJson({ surveys: [survey] }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    await createSurveyClient(makeDeps()).fetchSurveys()

    // A fresh client (same storage) sees the persisted config without a fetch.
    const fresh = createSurveyClient(makeDeps())
    expect(fresh.getSurveys()).toHaveLength(1)
  })
})

// ---- eligibility + shouldShow ------------------------------------------

describe('createSurveyClient — eligibility + shouldShowSurvey', () => {
  it('gates eligibility on the linked flag', async () => {
    const fetchMock = vi.fn(async () =>
      okJson({ surveys: [makeSurvey({ linkedFlagKey: 'flag-1' })] }),
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const offClient = createSurveyClient(makeDeps({ isFeatureEnabled: () => false }))
    await offClient.fetchSurveys()
    expect(offClient.getEligibleSurveys()).toHaveLength(0)
    expect(offClient.shouldShowSurvey(offClient.getSurveys()[0])).toBe(false)

    const onClient = createSurveyClient(makeDeps({ isFeatureEnabled: () => true }))
    await onClient.fetchSurveys()
    expect(onClient.getEligibleSurveys()).toHaveLength(1)
    expect(onClient.shouldShowSurvey(onClient.getSurveys()[0])).toBe(true)
  })

  it('null linked flag = always eligible', () => {
    const client = createSurveyClient(makeDeps({ isFeatureEnabled: () => false }))
    expect(client.isEligible(makeSurvey({ linkedFlagKey: null }))).toBe(true)
  })

  it('surveysForEvent / surveysForUrl combine trigger + eligibility + frequency', async () => {
    const s = makeSurvey({
      linkedFlagKey: null,
      definition: {
        version: 1,
        questions: [{ id: 'q1', type: 'rating' }],
        triggers: { events: ['purchase'], urlMatch: '/checkout', frequency: 'always' },
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ surveys: [s] })) as unknown as typeof fetch)
    const client = createSurveyClient(makeDeps())
    await client.fetchSurveys()

    expect(client.surveysForEvent('purchase')).toHaveLength(1)
    expect(client.surveysForEvent('other')).toHaveLength(0)
    expect(client.surveysForUrl('https://a.com/checkout')).toHaveLength(1)
    expect(client.surveysForUrl('https://a.com/home')).toHaveLength(0)
  })

  it('surveysForEvent applies eventFilters against the fired properties', async () => {
    const s = makeSurvey({
      linkedFlagKey: null,
      definition: {
        version: 1,
        questions: [{ id: 'q1', type: 'rating' }],
        triggers: {
          events: ['purchase'],
          eventFilters: [{ key: 'plan', operator: 'exact', value: 'pro' }],
          frequency: 'always',
        },
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ surveys: [s] })) as unknown as typeof fetch)
    const client = createSurveyClient(makeDeps())
    await client.fetchSurveys()

    expect(client.surveysForEvent('purchase', { plan: 'pro' })).toHaveLength(1)
    expect(client.surveysForEvent('purchase', { plan: 'free' })).toHaveLength(0)
    // no properties → non-empty filter against missing prop fails
    expect(client.surveysForEvent('purchase')).toHaveLength(0)
  })
})

// ---- capture emission + frequency persistence --------------------------

describe('createSurveyClient — capture', () => {
  it('captureShown emits $survey_shown and records the display', () => {
    const deps = makeDeps()
    const client = createSurveyClient(deps)
    const s = makeSurvey()
    client.captureShown(s)

    expect(deps.captured[0].event).toBe(EVENT_SURVEY_SHOWN)
    expect(deps.captured[0].props?.[SURVEY_PROP_ID]).toBe('srv_1')
    expect(deps.captured[0].props?.[SURVEY_PROP_ITERATION]).toBe(1)
    // `once` survey now blocked from re-showing.
    expect(client.shouldShowSurvey(s)).toBe(false)
  })

  it('captureDismissed emits $survey_dismissed', () => {
    const deps = makeDeps()
    createSurveyClient(deps).captureDismissed(makeSurvey())
    expect(deps.captured[0].event).toBe(EVENT_SURVEY_DISMISSED)
    expect(deps.captured[0].props?.[SURVEY_PROP_ID]).toBe('srv_1')
  })

  it('captureSent emits $survey_sent with the response fan-out and marks completed', () => {
    const deps = makeDeps()
    const client = createSurveyClient(deps)
    const s = makeSurvey({ linkedFlagKey: null })
    client.captureSent(s, { q1: 10 })

    expect(deps.captured[0].event).toBe(EVENT_SURVEY_SENT)
    // Numeric rating answer is emitted as a string (survives the MV's JSONExtractString).
    expect(deps.captured[0].props?.[SURVEY_PROP_RESPONSE]).toBe('10')
    expect(deps.captured[0].props?.[`${SURVEY_PROP_RESPONSE_PREFIX}q1`]).toBe('10')
    // completed -> even an `always` frequency would still show, but `once` won't.
    expect(client.shouldShowSurvey(s)).toBe(false)
  })
})

// ---- background polling -------------------------------------------------

describe('initSurveys — background polling', () => {
  const POLL_MS = 30_000

  // A URL-triggered, always-eligible, always-frequency survey that matches the stubbed location.
  const urlSurvey = (over: Partial<Survey> = {}): Survey =>
    makeSurvey({
      linkedFlagKey: null,
      definition: {
        version: 1,
        questions: [{ id: 'q1', type: 'rating' }],
        triggers: { urlMatch: '/checkout', frequency: 'always' },
      },
      ...over,
    })

  // Flush the microtask queue so the initial fetch chain (fetch -> json -> evaluate -> startPolling)
  // settles before we advance fake timers.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('location', { href: 'https://a.com/checkout' })
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('surfaces a survey created mid-session on the next poll tick', async () => {
    let current: { surveys: Survey[] } = { surveys: [] }
    const fetchMock = vi.fn(async () => okJson(current))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const render = vi.fn()

    initSurveys({ ...makeDeps(), render, pollIntervalMs: POLL_MS })
    await flush()
    // No survey yet -> nothing rendered.
    expect(render).not.toHaveBeenCalled()

    // A survey appears mid-session; next tick fetches it and evaluates URL triggers.
    current = { surveys: [urlSurvey()] }
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(render).toHaveBeenCalledTimes(1)
    expect(render.mock.calls[0][0].id).toBe('srv_1')
  })

  it('cold-start: zero surveys at init still polls and picks up the first survey', async () => {
    let current: { surveys: Survey[] } = { surveys: [] }
    const fetchMock = vi.fn(async () => okJson(current))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const render = vi.fn()

    initSurveys({ ...makeDeps(), render, pollIntervalMs: POLL_MS })
    await flush()
    // Did NOT fire before the interval elapsed.
    expect(render).not.toHaveBeenCalled()

    current = { surveys: [urlSurvey()] }
    await vi.advanceTimersByTimeAsync(POLL_MS)
    // DID fire after the interval.
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('unchanged config does not re-evaluate — URL survey shows at most once', async () => {
    // Same survey object every fetch -> version gate returns the same array reference each tick.
    const current = { surveys: [urlSurvey()] }
    const fetchMock = vi.fn(async () => okJson(current))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const render = vi.fn()

    initSurveys({ ...makeDeps(), render, pollIntervalMs: POLL_MS })
    await flush()
    // Initial URL pass shows it once.
    expect(render).toHaveBeenCalledTimes(1)

    // Several unchanged ticks must not re-nag.
    await vi.advanceTimersByTimeAsync(POLL_MS * 4)
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('stop() halts polling — no further fetches', async () => {
    const current = { surveys: [] as Survey[] }
    const fetchMock = vi.fn(async () => okJson(current))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    let stop: (() => void) | null = null
    initSurveys({
      ...makeDeps(),
      render: vi.fn(),
      pollIntervalMs: POLL_MS,
      registerPollControl: (s) => {
        stop = s
      },
    })
    await flush()
    const callsAfterInit = fetchMock.mock.calls.length
    expect(stop).toBeTypeOf('function')

    ;(stop as unknown as () => void)()
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    // No polling fetches after stop().
    expect(fetchMock.mock.calls.length).toBe(callsAfterInit)
  })
})
