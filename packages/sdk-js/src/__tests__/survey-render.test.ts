// @vitest-environment jsdom
// Shadow-DOM survey popover render layer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EVENT_SURVEY_SENT,
  EVENT_SURVEY_SHOWN,
  initSurveys,
  SURVEY_PROP_ID,
  SURVEY_PROP_RESPONSE,
  type Survey,
  type SurveyDefinition,
  type SurveyEventTrigger,
} from '../survey'
import { renderSurvey } from '../survey-render'

const host = () => document.querySelector('[data-clickroom-survey]') as HTMLElement | null
const shadow = () => host()?.shadowRoot ?? null
const popover = () => shadow()?.querySelector('.ckrm-popover') as HTMLElement | null
const q = (sel: string) => shadow()?.querySelector(sel) as HTMLElement | null
const qa = (sel: string) => Array.from(shadow()?.querySelectorAll(sel) ?? []) as HTMLElement[]

// ---- shared initSurveys helpers (used by both the single- and multi-survey suites) ----------
// Every mounted survey is its own `[data-clickroom-survey]` shadow host, appended to
// document.body in the order `surveysForEvent` iterates the seeded cache. These helpers let a
// test seed multiple surveys and drive/inspect a specific host by index, not just the first one.

const hosts = (): HTMLElement[] =>
  Array.from(document.querySelectorAll('[data-clickroom-survey]')) as HTMLElement[]
const qaIn = (h: HTMLElement, sel: string): HTMLElement[] =>
  Array.from(h.shadowRoot?.querySelectorAll(sel) ?? []) as HTMLElement[]
const qIn = (h: HTMLElement, sel: string): HTMLElement | null =>
  (h.shadowRoot?.querySelector(sel) as HTMLElement | null) ?? null

/** Seed the `ckrm_surveys` localStorage cache with one or more surveys. The signature mirrors
 *  `survey.ts`'s `versionSignature` (order-independent `{id:version}` join) — restore only reads
 *  `surveys`, but keeping the real shape avoids surprising the version gate. */
const seedCache = (...surveys: Survey[]): void => {
  const signature = surveys
    .map((s) => `${s.id}:${s.version}`)
    .sort()
    .join('|')
  localStorage.setItem('ckrm_surveys', JSON.stringify({ signature, surveys }))
}

/** A single-rating survey triggered by `incident_declared`, parametrized by frequency + id. */
const ratingSurvey = (frequency: string, id = 'srv_1'): Survey => ({
  id,
  version: 1,
  linkedFlagKey: null,
  definition: {
    version: 1,
    questions: [{ id: 'q1', type: 'rating', scale: 5 }],
    triggers: { events: ['incident_declared'], frequency },
  },
})

/** Pick a rating + submit within a SPECIFIC host's shadow root. */
const submitRatingIn = (h: HTMLElement, index: number): void => {
  qaIn(h, '.ckrm-rating')[index]?.click()
  ;(qIn(h, '.ckrm-btn-primary') as HTMLButtonElement | null)?.click()
}

/** Dismiss (close button) within a SPECIFIC host's shadow root. */
const dismissIn = (h: HTMLElement): void => {
  ;(qIn(h, '.ckrm-close') as HTMLButtonElement | null)?.click()
}

/** Back-compat: drive the FIRST mounted host (the original single-survey call signature). */
const submitRating = (index: number): void => {
  const h = host()
  if (h) submitRatingIn(h, index)
}

/** Read a per-survey `ckrm_survey_seen_<id>` SeenRecord straight out of localStorage. */
const readSeen = (id: string): Record<string, unknown> => {
  const raw = localStorage.getItem(`ckrm_survey_seen_${id}`)
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

/** Stub `/v1/surveys` so `initSurveys` restores synchronously from the seeded cache only. */
const stubSurveysFetch = (): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false }) as Response),
  )
}

const def = (questions: SurveyDefinition['questions']): SurveyDefinition => ({
  version: 1,
  questions,
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('renderSurvey — mounting + isolation', () => {
  it('creates a shadow-DOM host with an inline <style> and a dialog popover', () => {
    const h = renderSurvey(def([{ id: 'q1', type: 'open' }]), { onResponse: () => {} })
    expect(host()).not.toBeNull()
    expect(shadow()).not.toBeNull()
    // Styles live inside the shadow root, not the light DOM.
    expect(shadow()?.querySelector('style')).not.toBeNull()
    expect(document.head.querySelector('style')).toBeNull()
    const dlg = popover()
    expect(dlg?.getAttribute('role')).toBe('dialog')
    expect(dlg?.getAttribute('aria-modal')).toBe('true')
    h.destroy()
    expect(host()).toBeNull()
  })

  it('fires onShown once on mount', () => {
    const onShown = vi.fn()
    renderSurvey(def([{ id: 'q1', type: 'open' }]), { onResponse: () => {}, onShown })
    expect(onShown).toHaveBeenCalledTimes(1)
  })

  it('mounts into a provided container instead of document.body', () => {
    const box = document.createElement('div')
    document.body.appendChild(box)
    renderSurvey(def([{ id: 'q1', type: 'open' }]), { onResponse: () => {}, container: box })
    expect(box.querySelector('[data-clickroom-survey]')).not.toBeNull()
  })
})

describe('renderSurvey — question types', () => {
  it('renders a rating question as `scale` buttons and records the pick', () => {
    const onResponse = vi.fn()
    renderSurvey(def([{ id: 'r', type: 'rating', scale: 5, display: 'number' }]), { onResponse })
    const buttons = qa('.ckrm-rating')
    expect(buttons).toHaveLength(5)
    buttons[3].click() // value 4
    expect(buttons[3].getAttribute('aria-pressed')).toBe('true')
    // Submit (single question → primary button submits).
    ;(q('.ckrm-btn-primary') as HTMLButtonElement).click()
    expect(onResponse).toHaveBeenCalledWith({ r: 4 })
  })

  it('renders emoji + star ratings without numbers', () => {
    renderSurvey(def([{ id: 'r', type: 'rating', scale: 5, display: 'emoji' }]), {
      onResponse: () => {},
    })
    expect(qa('.ckrm-rating').every((b) => !/\d/.test(b.textContent ?? ''))).toBe(true)
  })

  it('renders an open question as a textarea', () => {
    const onResponse = vi.fn()
    renderSurvey(def([{ id: 'o', type: 'open' }]), { onResponse })
    const ta = q('.ckrm-textarea') as HTMLTextAreaElement
    expect(ta).not.toBeNull()
    ta.value = 'hello'
    ta.dispatchEvent(new Event('input'))
    ;(q('.ckrm-btn-primary') as HTMLButtonElement).click()
    expect(onResponse).toHaveBeenCalledWith({ o: 'hello' })
  })

  it('renders single_choice as radios and records one value', () => {
    const onResponse = vi.fn()
    renderSurvey(def([{ id: 's', type: 'single_choice', choices: ['a', 'b', 'c'] }]), {
      onResponse,
    })
    const radios = qa('input[type="radio"]') as HTMLInputElement[]
    expect(radios).toHaveLength(3)
    radios[1].checked = true
    radios[1].dispatchEvent(new Event('change'))
    ;(q('.ckrm-btn-primary') as HTMLButtonElement).click()
    expect(onResponse).toHaveBeenCalledWith({ s: 'b' })
  })

  it('renders multiple_choice as checkboxes and records an array', () => {
    const onResponse = vi.fn()
    renderSurvey(def([{ id: 'm', type: 'multiple_choice', choices: ['a', 'b', 'c'] }]), {
      onResponse,
    })
    const boxes = qa('input[type="checkbox"]') as HTMLInputElement[]
    boxes[0].checked = true
    boxes[0].dispatchEvent(new Event('change'))
    boxes[2].checked = true
    boxes[2].dispatchEvent(new Event('change'))
    ;(q('.ckrm-btn-primary') as HTMLButtonElement).click()
    expect(onResponse).toHaveBeenCalledWith({ m: ['a', 'c'] })
  })

  it('renders a link question as a CTA that opens the url and submits', () => {
    const onResponse = vi.fn()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    renderSurvey(def([{ id: 'l', type: 'link', link: 'https://x.test', buttonText: 'Go' }]), {
      onResponse,
    })
    const cta = q('.ckrm-btn-primary') as HTMLButtonElement
    expect(cta.textContent).toBe('Go')
    cta.click()
    expect(open).toHaveBeenCalledWith('https://x.test', '_blank', 'noopener')
    expect(onResponse).toHaveBeenCalledWith({ l: 'clicked' })
  })
})

describe('renderSurvey — multi-question stepping', () => {
  it('steps Next/Back across questions and submits the assembled payload', () => {
    const onResponse = vi.fn()
    renderSurvey(
      def([
        { id: 'q1', type: 'rating', scale: 5 },
        { id: 'q2', type: 'open' },
      ]),
      { onResponse },
    )
    // Step 1: rating. Primary button is "Next", disabled until answered.
    const nextBtn = () => q('.ckrm-btn-primary') as HTMLButtonElement
    expect(nextBtn().textContent).toBe('Next')
    expect(nextBtn().disabled).toBe(true)
    qa('.ckrm-rating')[2].click() // value 3
    expect(nextBtn().disabled).toBe(false)
    nextBtn().click()
    // Step 2: open textarea, submit button.
    expect(q('.ckrm-textarea')).not.toBeNull()
    expect(nextBtn().textContent).toBe('Submit')
    // Back to step 1, forward again — answer persists.
    ;(q('.ckrm-btn-ghost') as HTMLButtonElement).click()
    expect(qa('.ckrm-rating')[2].getAttribute('aria-pressed')).toBe('true')
    nextBtn().click()
    const ta = q('.ckrm-textarea') as HTMLTextAreaElement
    ta.value = 'note'
    ta.dispatchEvent(new Event('input'))
    nextBtn().click()
    expect(onResponse).toHaveBeenCalledWith({ q1: 3, q2: 'note' })
  })
})

describe('renderSurvey — dismiss + a11y', () => {
  it('close button calls onDismiss and unmounts', () => {
    const onDismiss = vi.fn()
    const onResponse = vi.fn()
    renderSurvey(def([{ id: 'o', type: 'open' }]), { onResponse, onDismiss })
    ;(q('.ckrm-close') as HTMLButtonElement).click()
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onResponse).not.toHaveBeenCalled()
    expect(host()).toBeNull()
  })

  it('ESC dismisses the popover', () => {
    const onDismiss = vi.fn()
    renderSurvey(def([{ id: 'o', type: 'open' }]), { onResponse: () => {}, onDismiss })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(host()).toBeNull()
  })

  it('moves focus into the popover on mount', () => {
    renderSurvey(def([{ id: 'o', type: 'open' }]), { onResponse: () => {} })
    // First focusable is the close button.
    expect(shadow()?.activeElement).not.toBeNull()
  })

  it('shows a thanks message after submit', () => {
    vi.useFakeTimers()
    renderSurvey(def([{ id: 'o', type: 'open' }]), {
      onResponse: () => {},
      appearance: { thanksMessage: 'Cheers!' },
    })
    ;(q('.ckrm-btn-primary') as HTMLButtonElement).click()
    expect(q('.ckrm-thanks')?.textContent).toBe('Cheers!')
    vi.useRealTimers()
  })
})

// ---- initSurveys event-trigger integration (the full popover → capture path) ----------------

describe('initSurveys — event-trigger render + capture', () => {
  beforeEach(() => {
    // Surveys are restored synchronously from the seeded localStorage cache; stub the background
    // `/v1/surveys` fetch so `initSurveys` never touches the real network.
    stubSurveysFetch()
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('emits $survey_shown on mount and $survey_sent (string response) on submit via capture', () => {
    const captured: Array<{ event: string; props?: Record<string, unknown> }> = []
    let trigger: SurveyEventTrigger = () => {}
    seedCache(ratingSurvey('always'))

    initSurveys({
      getApiHost: () => 'https://capture.example.com',
      getWriteKey: () => 'wk',
      isFeatureEnabled: () => true,
      capture: (event, props) => captured.push({ event, props }),
      registerEventTrigger: (t) => {
        trigger = t
      },
    })

    trigger('incident_declared', { severity: 'sev1' })
    expect(host()).not.toBeNull() // popover mounted
    expect(captured.map((c) => c.event)).toContain(EVENT_SURVEY_SHOWN)

    submitRating(3) // value 4
    const sent = captured.find((c) => c.event === EVENT_SURVEY_SENT)
    expect(sent).toBeDefined()
    // Rating answer is emitted as a STRING so the ClickHouse MV's JSONExtractString captures it.
    expect(sent?.props?.[SURVEY_PROP_RESPONSE]).toBe('4')
  })

  it("frequency 'always' re-shows + re-emits on a second matching event", () => {
    const captured: Array<{ event: string }> = []
    let trigger: SurveyEventTrigger = () => {}
    seedCache(ratingSurvey('always'))

    initSurveys({
      getApiHost: () => 'https://capture.example.com',
      getWriteKey: () => 'wk',
      isFeatureEnabled: () => true,
      capture: (event) => captured.push({ event }),
      registerEventTrigger: (t) => {
        trigger = t
      },
    })

    trigger('incident_declared')
    submitRating(3) // submit releases the open lock
    trigger('incident_declared') // second incident must re-open the popover

    expect(host()).not.toBeNull()
    expect(captured.filter((c) => c.event === EVENT_SURVEY_SHOWN)).toHaveLength(2)
  })

  it("frequency 'once' does NOT re-show after the first event", () => {
    const captured: Array<{ event: string }> = []
    let trigger: SurveyEventTrigger = () => {}
    seedCache(ratingSurvey('once'))

    initSurveys({
      getApiHost: () => 'https://capture.example.com',
      getWriteKey: () => 'wk',
      isFeatureEnabled: () => true,
      capture: (event) => captured.push({ event }),
      registerEventTrigger: (t) => {
        trigger = t
      },
    })

    trigger('incident_declared')
    submitRating(3)
    trigger('incident_declared') // `once` → blocked by frequencyAllows

    expect(captured.filter((c) => c.event === EVENT_SURVEY_SHOWN)).toHaveLength(1)
  })
})

// ---- per-survey (NOT global) exposure de-dup -------------------------------------------------
// Seen-state is keyed per survey (`ckrm_survey_seen_<id>`) and `openSurveyIds` is per survey.id,
// so two surveys sharing an event trigger are shown, dismissed, answered, and cooled-down
// INDEPENDENTLY. These tests seed >1 survey — the multi-survey path the single-survey suite above
// never exercises — and prove one survey's frequency/answer/dismiss never leaks onto another's.

describe('initSurveys — multiple active surveys (per-survey de-dup)', () => {
  interface Captured {
    event: string
    props?: Record<string, unknown>
  }

  const initWithTrigger = (captured: Captured[]): { fire: SurveyEventTrigger } => {
    let trigger: SurveyEventTrigger = () => {}
    initSurveys({
      getApiHost: () => 'https://capture.example.com',
      getWriteKey: () => 'wk',
      isFeatureEnabled: () => true,
      capture: (event, props) => captured.push({ event, props }),
      registerEventTrigger: (t) => {
        trigger = t
      },
    })
    return { fire: (name, props) => trigger(name, props) }
  }

  /** Ids that received a `$survey_shown` capture, in order. */
  const shownIds = (captured: Captured[]): string[] =>
    captured
      .filter((c) => c.event === EVENT_SURVEY_SHOWN)
      .map((c) => c.props?.[SURVEY_PROP_ID] as string)
  const shownCount = (captured: Captured[], id: string): number =>
    shownIds(captured).filter((x) => x === id).length

  beforeEach(() => {
    stubSurveysFetch()
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('two `once` surveys on the same event → BOTH mount, each with its own $survey_id', () => {
    const captured: Captured[] = []
    seedCache(ratingSurvey('once', 'srv_a'), ratingSurvey('once', 'srv_b'))
    const { fire } = initWithTrigger(captured)

    fire('incident_declared')

    // Two independent shadow hosts stacked in document.body — not a single de-duped popover.
    expect(hosts()).toHaveLength(2)
    expect(new Set(shownIds(captured))).toEqual(new Set(['srv_a', 'srv_b']))
  })

  it('answering survey A does NOT suppress B — completedAt is written per-survey only', () => {
    const captured: Captured[] = []
    seedCache(ratingSurvey('once', 'srv_a'), ratingSurvey('once', 'srv_b'))
    const { fire } = initWithTrigger(captured)

    fire('incident_declared')
    // host[0] is srv_a (seed/iteration order). Answer ONLY A.
    submitRatingIn(hosts()[0], 3)

    // A's completion is isolated to its own seen key; B's key never gains a completedAt.
    expect(typeof readSeen('srv_a').completedAt).toBe('number')
    expect(readSeen('srv_b').completedAt).toBeUndefined()
    // B was still shown (has its own lastShownAt), independent of A's answer.
    expect(typeof readSeen('srv_b').lastShownAt).toBe('number')

    // Re-firing does not re-show A (its own `once` gate), and A's answer left B's key untouched.
    fire('incident_declared')
    expect(shownCount(captured, 'srv_a')).toBe(1)
    expect(readSeen('srv_b').completedAt).toBeUndefined()
  })

  it('dismissing survey A does NOT suppress B — dismissedAt is written per-survey only', () => {
    const captured: Captured[] = []
    seedCache(ratingSurvey('once', 'srv_a'), ratingSurvey('once', 'srv_b'))
    const { fire } = initWithTrigger(captured)

    fire('incident_declared')
    dismissIn(hosts()[0]) // close A only

    expect(typeof readSeen('srv_a').dismissedAt).toBe('number')
    expect(readSeen('srv_b').dismissedAt).toBeUndefined()

    // A's `once` gate keeps it from re-showing; the dismissal never touched B's record.
    fire('incident_declared')
    expect(shownCount(captured, 'srv_a')).toBe(1)
    expect(readSeen('srv_b').dismissedAt).toBeUndefined()
  })

  it('mixed frequencies (once + always) on one event: only `always` re-shows', () => {
    const captured: Captured[] = []
    seedCache(ratingSurvey('once', 'srv_once'), ratingSurvey('always', 'srv_always'))
    const { fire } = initWithTrigger(captured)

    fire('incident_declared')
    expect(hosts()).toHaveLength(2)
    // Release both open-locks so the `always` survey is free to re-open on the next fire.
    for (const h of hosts()) dismissIn(h)

    fire('incident_declared')

    // `once` stays at a single exposure; `always` re-shows each time.
    expect(shownCount(captured, 'srv_once')).toBe(1)
    expect(shownCount(captured, 'srv_always')).toBe(2)
  })

  it('every_n_days cooldown is per-survey: a survey in cooldown stays suppressed while a fresh one shows', () => {
    const captured: Captured[] = []
    // A is inside its 7-day window (seeded with a just-now lastShownAt); B has never been shown.
    localStorage.setItem(
      'ckrm_survey_seen_srv_a',
      JSON.stringify({ lastShownAt: Date.now(), shownCount: 1 }),
    )
    seedCache(ratingSurvey('every_n_days:7', 'srv_a'), ratingSurvey('every_n_days:7', 'srv_b'))
    const { fire } = initWithTrigger(captured)

    fire('incident_declared')

    // Only B mounts — A's cooldown suppression does not spill onto B.
    expect(shownIds(captured)).toEqual(['srv_b'])
    expect(hosts()).toHaveLength(1)
  })
})
