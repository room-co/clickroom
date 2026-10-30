// @clickroom/sdk-js — shadow-DOM-isolated survey popover RENDER layer.
//
// This is the PURE render layer. It takes a `SurveyDefinition` + callbacks and paints a
// shadow-DOM-isolated popover — it has ZERO dependency on the fetch/trigger/capture layer
// (`survey.ts`'s `SurveyClient`). Only TYPES are imported from `survey.ts`, and those erase at
// compile time, so there is no runtime coupling: `renderSurvey` can be imported and mounted by
// the web builder's preview pane WITHOUT a live SDK, config fetch, or `$survey_*` events.
//
// No external UI deps — hand-rolled DOM. Every style is injected inside the shadow root so
// host-page CSS can neither leak in nor leak out.

import type { SurveyDefinition, SurveyQuestion, SurveyResponse } from './survey'

// ---- appearance ---------------------------------------------------------

export type SurveyPosition = 'bottom_right' | 'bottom_left' | 'center'

/** Loose appearance config carried on `definition.appearance` (all optional). */
export interface SurveyAppearance {
  position?: SurveyPosition
  backgroundColor?: string
  textColor?: string
  /** Accent colour for the primary button / selected controls. */
  primaryColor?: string
  /** Shown after `$survey_sent` (the "sent" state). */
  thanksMessage?: string
  /** Label of the final submit button (default "Submit"). */
  submitButtonText?: string
}

const DEFAULT_APPEARANCE: Required<SurveyAppearance> = {
  position: 'bottom_right',
  backgroundColor: '#ffffff',
  textColor: '#0f172a',
  primaryColor: '#4f46e5',
  thanksMessage: 'Thank you for your feedback!',
  submitButtonText: 'Submit',
}

// ---- options / handle ---------------------------------------------------

export interface RenderSurveyOptions {
  /** Called with the assembled response map (`{ [questionId]: answer }`) on submit — shaped for
   *  `survey.ts`'s `buildSentProps`. */
  onResponse: (response: SurveyResponse) => void
  /** Called when the user dismisses (close button / ESC / backdrop) before submitting. */
  onDismiss?: () => void
  /** Called once when the popover has mounted (used by the live SDK to emit `$survey_shown`). */
  onShown?: () => void
  /** Appearance overrides (falls back to `definition.appearance`, then defaults). */
  appearance?: SurveyAppearance
  /** Where to mount. Default `document.body`. The preview pane passes its own element. */
  container?: HTMLElement | ShadowRoot
  /** Move focus into the popover on mount and trap Tab/ESC at the document level. Default `true`
   *  (correct for the live widget). The builder's live preview passes `false` so re-mounting the
   *  preview on every keystroke doesn't steal focus from the editor inputs. */
  autoFocus?: boolean
}

export interface SurveyRenderHandle {
  /** Tear down the popover and remove the shadow host. Idempotent. */
  destroy(): void
}

// ---- question value helpers (pure) --------------------------------------

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const choicesOf = (q: SurveyQuestion): string[] =>
  Array.isArray(q.choices) ? (q.choices as unknown[]).map((c) => String(c)) : []
const promptOf = (q: SurveyQuestion, index: number): string =>
  str(q.label) || str(q.text) || str(q.question) || `Question ${index + 1}`

// 5-point emoji ramp, sampled across the question's scale.
const EMOJI_RAMP = ['😡', '🙁', '😐', '🙂', '😍']
const emojiFor = (value: number, scale: number): string => {
  if (scale <= 1) return EMOJI_RAMP[EMOJI_RAMP.length - 1]
  const idx = Math.round(((value - 1) / (scale - 1)) * (EMOJI_RAMP.length - 1))
  return EMOJI_RAMP[Math.min(EMOJI_RAMP.length - 1, Math.max(0, idx))]
}

// ---- styles (scoped inside the shadow root) -----------------------------

const styleText = (a: Required<SurveyAppearance>): string => `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .ckrm-overlay { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
  .ckrm-overlay[data-center="true"] { background: rgba(0,0,0,0.4); pointer-events: auto; display: flex; align-items: center; justify-content: center; }
  .ckrm-popover {
    position: fixed; pointer-events: auto; width: 360px; max-width: calc(100vw - 32px);
    background: ${a.backgroundColor}; color: ${a.textColor};
    border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,0.18); padding: 20px 20px 16px;
    font-size: 14px; line-height: 1.4;
  }
  .ckrm-overlay[data-center="true"] .ckrm-popover { position: relative; }
  .ckrm-pos-bottom_right { right: 16px; bottom: 16px; }
  .ckrm-pos-bottom_left { left: 16px; bottom: 16px; }
  .ckrm-close {
    position: absolute; top: 10px; right: 10px; width: 28px; height: 28px; border: none;
    background: transparent; color: ${a.textColor}; opacity: 0.5; font-size: 18px; cursor: pointer;
    border-radius: 6px; line-height: 1;
  }
  .ckrm-close:hover { opacity: 1; }
  .ckrm-prompt { font-weight: 600; font-size: 15px; margin: 0 24px 14px 0; }
  .ckrm-textarea {
    width: 100%; min-height: 84px; resize: vertical; padding: 8px 10px; font-size: 14px;
    border: 1px solid rgba(0,0,0,0.18); border-radius: 8px; background: transparent; color: inherit;
  }
  .ckrm-ratings { display: flex; gap: 6px; flex-wrap: wrap; }
  .ckrm-rating {
    flex: 1 1 auto; min-width: 34px; height: 40px; border: 1px solid rgba(0,0,0,0.18);
    background: transparent; color: inherit; border-radius: 8px; cursor: pointer; font-size: 16px;
  }
  .ckrm-rating[aria-pressed="true"] { background: ${a.primaryColor}; color: #fff; border-color: ${a.primaryColor}; }
  .ckrm-choices { display: flex; flex-direction: column; gap: 8px; }
  .ckrm-choice { display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 8px 10px; border: 1px solid rgba(0,0,0,0.14); border-radius: 8px; }
  .ckrm-choice input { accent-color: ${a.primaryColor}; }
  .ckrm-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; gap: 8px; }
  .ckrm-btn {
    appearance: none; border: none; border-radius: 8px; padding: 9px 16px; font-size: 14px;
    font-weight: 600; cursor: pointer;
  }
  .ckrm-btn-primary { background: ${a.primaryColor}; color: #fff; }
  .ckrm-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .ckrm-btn-ghost { background: transparent; color: inherit; opacity: 0.7; }
  .ckrm-btn-ghost:hover { opacity: 1; }
  .ckrm-thanks { text-align: center; padding: 12px 0 4px; font-size: 15px; font-weight: 600; }
`

// ---- renderer -----------------------------------------------------------

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Render a survey popover into a shadow-DOM-isolated host. Steps multi-question surveys inside one
 * popover (Next/Back), collects a `{ [questionId]: answer }` response, and invokes `onResponse` on
 * submit / `onDismiss` on close. Returns a handle whose `destroy()` unmounts the popover.
 *
 * Pure: depends only on the passed `definition` + callbacks + DOM — never on the SDK's config
 * client. Safe to import from the web builder's preview pane with no-op callbacks.
 */
export function renderSurvey(
  definition: SurveyDefinition,
  opts: RenderSurveyOptions,
): SurveyRenderHandle {
  if (typeof document === 'undefined') return { destroy() {} }

  const appearance: Required<SurveyAppearance> = {
    ...DEFAULT_APPEARANCE,
    ...(definition.appearance as SurveyAppearance | undefined),
    ...opts.appearance,
  }
  const questions = Array.isArray(definition.questions) ? definition.questions : []
  const response: SurveyResponse = {}

  // --- shadow host ---
  const host = document.createElement('div')
  host.setAttribute('data-clickroom-survey', '')
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = styleText(appearance)
  shadow.appendChild(style)

  const overlay = document.createElement('div')
  overlay.className = 'ckrm-overlay'
  overlay.setAttribute('data-center', String(appearance.position === 'center'))
  shadow.appendChild(overlay)

  const popover = document.createElement('div')
  popover.className = `ckrm-popover${
    appearance.position === 'center' ? '' : ` ckrm-pos-${appearance.position}`
  }`
  popover.setAttribute('role', 'dialog')
  popover.setAttribute('aria-modal', 'true')
  popover.setAttribute('aria-label', 'Survey')
  overlay.appendChild(popover)

  let destroyed = false
  let step = 0

  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    try {
      document.removeEventListener('keydown', onKeydown, true)
    } catch {
      // ignore
    }
    try {
      host.remove()
    } catch {
      // ignore
    }
  }

  const dismiss = (): void => {
    if (destroyed) return
    try {
      opts.onDismiss?.()
    } catch {
      // never throw from a callback
    }
    destroy()
  }

  const submit = (): void => {
    if (destroyed) return
    try {
      opts.onResponse(response)
    } catch {
      // never throw from a callback
    }
    renderThanks()
  }

  // --- focus trap + ESC (captured at document level; shadow re-targets events) ---
  function focusables(): HTMLElement[] {
    return Array.from(popover.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !el.hasAttribute('disabled'),
    )
  }
  function onKeydown(e: KeyboardEvent): void {
    if (destroyed) return
    if (e.key === 'Escape') {
      e.preventDefault()
      dismiss()
      return
    }
    if (e.key !== 'Tab') return
    const items = focusables()
    if (items.length === 0) return
    const active = (shadow.activeElement as HTMLElement | null) ?? null
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }
  const autoFocus = opts.autoFocus !== false
  if (autoFocus) document.addEventListener('keydown', onKeydown, true)

  // --- per-type question body builders ---
  function buildRating(q: SurveyQuestion): HTMLElement {
    const scale = Math.max(2, num(q.scale, 5))
    const display = str(q.display, 'number')
    const row = document.createElement('div')
    row.className = 'ckrm-ratings'
    row.setAttribute('role', 'radiogroup')
    for (let v = 1; v <= scale; v += 1) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'ckrm-rating'
      btn.setAttribute('role', 'radio')
      btn.setAttribute('aria-checked', 'false')
      btn.setAttribute('aria-pressed', 'false')
      btn.setAttribute('aria-label', `${v}`)
      btn.textContent =
        display === 'emoji' ? emojiFor(v, scale) : display === 'star' ? '★' : String(v)
      if (response[q.id] === v) {
        btn.setAttribute('aria-pressed', 'true')
        btn.setAttribute('aria-checked', 'true')
      }
      btn.addEventListener('click', () => {
        response[q.id] = v
        for (const el of Array.from(row.children) as HTMLElement[]) {
          const on = el === btn
          el.setAttribute('aria-pressed', String(on))
          el.setAttribute('aria-checked', String(on))
        }
        refreshNav()
      })
      row.appendChild(btn)
    }
    return row
  }

  function buildOpen(q: SurveyQuestion): HTMLElement {
    const ta = document.createElement('textarea')
    ta.className = 'ckrm-textarea'
    ta.setAttribute('aria-label', promptOf(q, step))
    ta.value = str(response[q.id])
    ta.addEventListener('input', () => {
      response[q.id] = ta.value
      refreshNav()
    })
    return ta
  }

  function buildChoice(q: SurveyQuestion, multiple: boolean): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'ckrm-choices'
    if (multiple) wrap.setAttribute('role', 'group')
    else wrap.setAttribute('role', 'radiogroup')
    const name = `ckrm-${q.id}`
    const selected = new Set<string>(
      multiple && Array.isArray(response[q.id]) ? (response[q.id] as string[]) : [],
    )
    for (const choice of choicesOf(q)) {
      const label = document.createElement('label')
      label.className = 'ckrm-choice'
      const input = document.createElement('input')
      input.type = multiple ? 'checkbox' : 'radio'
      input.name = name
      input.value = choice
      input.checked = multiple ? selected.has(choice) : response[q.id] === choice
      const span = document.createElement('span')
      span.textContent = choice
      label.appendChild(input)
      label.appendChild(span)
      input.addEventListener('change', () => {
        if (multiple) {
          if (input.checked) selected.add(choice)
          else selected.delete(choice)
          response[q.id] = Array.from(selected)
        } else {
          response[q.id] = choice
        }
        refreshNav()
      })
      wrap.appendChild(label)
    }
    return wrap
  }

  function buildLink(q: SurveyQuestion): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ckrm-btn ckrm-btn-primary'
    btn.textContent = str(q.buttonText) || str(q.text) || 'Open'
    btn.addEventListener('click', () => {
      response[q.id] = 'clicked'
      const href = str(q.link) || str(q.url)
      if (href) {
        try {
          window.open(href, '_blank', 'noopener')
        } catch {
          // ignore popup failures
        }
      }
      // A link question is terminal on the step: advance / submit.
      goNext()
    })
    return btn
  }

  function buildBody(q: SurveyQuestion): HTMLElement {
    switch (q.type) {
      case 'rating':
        return buildRating(q)
      case 'open':
        return buildOpen(q)
      case 'single_choice':
        return buildChoice(q, false)
      case 'multiple_choice':
        return buildChoice(q, true)
      case 'link':
        return buildLink(q)
      default:
        return document.createElement('div')
    }
  }

  // --- nav state (whether the current step is answered) ---
  function isAnswered(q: SurveyQuestion): boolean {
    const v = response[q.id]
    if (q.type === 'multiple_choice') return Array.isArray(v) && v.length > 0
    if (q.type === 'link') return true // CTA advances itself; never blocks
    if (q.type === 'open') return true // free text is optional
    return v !== undefined && v !== ''
  }

  let submitBtn: HTMLButtonElement | null = null
  function refreshNav(): void {
    const q = questions[step]
    if (submitBtn && q) submitBtn.disabled = !isAnswered(q)
  }

  function goNext(): void {
    if (step < questions.length - 1) {
      step += 1
      renderStep()
    } else {
      submit()
    }
  }
  function goBack(): void {
    if (step > 0) {
      step -= 1
      renderStep()
    }
  }

  // --- step / thanks rendering ---
  function clearPopover(): void {
    popover.replaceChildren()
  }

  function addCloseButton(): void {
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'ckrm-close'
    close.setAttribute('aria-label', 'Close survey')
    close.textContent = '×'
    close.addEventListener('click', dismiss)
    popover.appendChild(close)
  }

  function renderStep(): void {
    if (destroyed) return
    clearPopover()
    addCloseButton()
    const q = questions[step]
    if (!q) {
      // No questions — nothing to ask; treat as an immediate submit.
      submit()
      return
    }

    const prompt = document.createElement('div')
    prompt.className = 'ckrm-prompt'
    prompt.id = `ckrm-prompt-${step}`
    prompt.textContent = promptOf(q, step)
    popover.setAttribute('aria-labelledby', prompt.id)
    popover.appendChild(prompt)

    popover.appendChild(buildBody(q))

    // A link question carries its own terminal CTA — no separate action row.
    if (q.type !== 'link') {
      const actions = document.createElement('div')
      actions.className = 'ckrm-actions'

      const back = document.createElement('button')
      back.type = 'button'
      back.className = 'ckrm-btn ckrm-btn-ghost'
      back.textContent = 'Back'
      back.style.visibility = step > 0 ? 'visible' : 'hidden'
      back.addEventListener('click', goBack)
      actions.appendChild(back)

      const primary = document.createElement('button')
      primary.type = 'button'
      primary.className = 'ckrm-btn ckrm-btn-primary'
      primary.textContent = step < questions.length - 1 ? 'Next' : appearance.submitButtonText
      primary.addEventListener('click', goNext)
      actions.appendChild(primary)
      submitBtn = primary

      popover.appendChild(actions)
    } else {
      submitBtn = null
    }

    refreshNav()
    // Move focus into the popover (first focusable) for the trap + a11y. Skipped in preview
    // (`autoFocus: false`) so remounting doesn't steal focus from the builder's editor inputs.
    if (autoFocus) {
      const first = focusables()[0]
      try {
        first?.focus()
      } catch {
        // ignore
      }
    }
  }

  function renderThanks(): void {
    if (destroyed) return
    clearPopover()
    addCloseButton()
    const thanks = document.createElement('div')
    thanks.className = 'ckrm-thanks'
    thanks.setAttribute('role', 'status')
    thanks.textContent = appearance.thanksMessage
    popover.appendChild(thanks)
    // Auto-dismiss the thanks state shortly after.
    try {
      setTimeout(destroy, 2500)
    } catch {
      // ignore
    }
  }

  // --- mount ---
  const parent = opts.container ?? document.body
  parent.appendChild(host)
  renderStep()
  try {
    opts.onShown?.()
  } catch {
    // never throw from a callback
  }

  return { destroy }
}
