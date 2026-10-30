// Shared page types + helpers for the Surveys dashboard.
//
// The UI keeps ONE definition shape that is intentionally identical to the
// server's `surveyDefinitionSchema` (packages/trpc-router/.../surveys.schema.ts)
// so the same object can be (a) sent to `surveys.create`/`surveys.update` and
// (b) handed to the SDK's pure `renderSurvey` for the live preview. apps/web has
// no runtime dependency on the zod schema (same posture as the experiments
// builder's local metric types), so the shape is re-declared here and kept in
// sync by convention + typecheck against what the mutations accept.

import type { PropertyFilter } from '@/components/PropertyFilterRow'

export type SurveyStatus = 'draft' | 'active' | 'archived'
export type RatingPreset = 'csat' | 'ces' | 'nps'
export type RatingDisplay = 'number' | 'emoji' | 'star'
export type RatingScale = 5 | 7 | 10
export type SurveyPosition = 'bottom_right' | 'bottom_left' | 'center'

/** Wire form of the display-frequency policy (`surveyFrequencySchema`). */
export type SurveyFrequency = 'once' | 'always' | { every_n_days: number }

// ── Question UI shapes (mirror the discriminated union on `type`) ────────────
export interface RatingQuestionUI {
  type: 'rating'
  id: string
  question: string
  scale: RatingScale
  display: RatingDisplay
  lowerLabel?: string
  upperLabel?: string
  preset?: RatingPreset
}
export interface OpenQuestionUI {
  type: 'open'
  id: string
  question: string
  placeholder?: string
}
export interface ChoiceQuestionUI {
  type: 'single_choice' | 'multiple_choice'
  id: string
  question: string
  choices: string[]
}
export interface LinkQuestionUI {
  type: 'link'
  id: string
  question: string
  buttonText: string
  url: string
}
export type SurveyQuestionUI = RatingQuestionUI | OpenQuestionUI | ChoiceQuestionUI | LinkQuestionUI
export type SurveyQuestionType = SurveyQuestionUI['type']

export interface SurveyAppearanceUI {
  position: SurveyPosition
  backgroundColor?: string
  textColor?: string
  thanksMessage?: string
}

export interface SurveyTriggersUI {
  events: string[]
  eventFilters: PropertyFilter[]
  urlMatch?: string
  selector?: string
  delayMs?: number
  frequency: SurveyFrequency
}

export interface SurveyDefinitionUI {
  version: 1
  questions: SurveyQuestionUI[]
  appearance: SurveyAppearanceUI
  triggers: SurveyTriggersUI
}

/** A row from `surveys.list` / `surveys.get` (Prisma `Survey`). `definition` is
 *  `Json` on the wire — narrowed to `SurveyDefinitionUI` at the call site. */
export interface SurveyRow {
  id: string
  name: string
  description: string | null
  status: SurveyStatus
  definition: unknown
  version: number
  featureFlagId: string
  createdAt: string | Date
  updatedAt: string | Date
}

// ── Presets / factories ──────────────────────────────────────────────────────

export const QUESTION_TYPE_LABELS: Record<SurveyQuestionType, string> = {
  rating: 'Rating',
  open: 'Open text',
  single_choice: 'Single choice',
  multiple_choice: 'Multiple choice',
  link: 'Link / CTA',
}

export const STATUS_BADGE: Record<SurveyStatus, 'default' | 'secondary' | 'outline'> = {
  draft: 'outline',
  active: 'default',
  archived: 'secondary',
}

let idCounter = 0
/** Short, collision-resistant-enough question id for a client-side editor. */
export function newQuestionId(): string {
  idCounter += 1
  return `q_${Date.now().toString(36)}_${idCounter}`
}

export function defaultAppearance(): SurveyAppearanceUI {
  return {
    position: 'bottom_right',
    backgroundColor: '#ffffff',
    textColor: '#0f172a',
    thanksMessage: 'Thanks for your feedback!',
  }
}

export function defaultTriggers(): SurveyTriggersUI {
  return { frequency: 'once', events: [], eventFilters: [] }
}

export function newQuestion(type: SurveyQuestionType): SurveyQuestionUI {
  const id = newQuestionId()
  switch (type) {
    case 'rating':
      return { type, id, question: 'How would you rate this?', scale: 5, display: 'number' }
    case 'open':
      return { type, id, question: 'Tell us more', placeholder: 'Your answer…' }
    case 'single_choice':
      return { type, id, question: 'Pick one', choices: ['Option A', 'Option B'] }
    case 'multiple_choice':
      return { type, id, question: 'Select all that apply', choices: ['Option A', 'Option B'] }
    case 'link':
      return { type, id, question: 'Check this out', buttonText: 'Learn more', url: 'https://' }
  }
}

/** A rating question locked to a CSAT/CES/NPS preset (scale + display). */
function presetRating(preset: RatingPreset, question: string): RatingQuestionUI {
  const scale: RatingScale = preset === 'nps' ? 10 : preset === 'ces' ? 7 : 5
  const display: RatingDisplay = preset === 'csat' ? 'emoji' : 'number'
  return { type: 'rating', id: newQuestionId(), question, scale, display, preset }
}

export type SurveyTemplate = 'csat' | 'ces' | 'nps' | 'blank'

export const TEMPLATE_LABELS: Record<SurveyTemplate, string> = {
  csat: 'CSAT',
  ces: 'CES',
  nps: 'NPS',
  blank: 'Start from scratch',
}

/** Starter `definition` for the create dialog. */
export function starterDefinition(template: SurveyTemplate): SurveyDefinitionUI {
  const base = { version: 1 as const, appearance: defaultAppearance(), triggers: defaultTriggers() }
  switch (template) {
    case 'csat':
      return { ...base, questions: [presetRating('csat', 'How satisfied are you with us?')] }
    case 'ces':
      return {
        ...base,
        questions: [presetRating('ces', 'How easy was it to get what you needed?')],
      }
    case 'nps':
      return {
        ...base,
        questions: [presetRating('nps', 'How likely are you to recommend us to a friend?')],
      }
    case 'blank':
      return { ...base, questions: [newQuestion('open')] }
  }
}

/** First rating question's preset (or `csat` fallback) — drives `results.score`. */
export function scoreQuestion(
  def: SurveyDefinitionUI,
): { questionId: string; scoreType: RatingPreset } | null {
  const rating = def.questions.find((q): q is RatingQuestionUI => q.type === 'rating')
  if (!rating) return null
  return { questionId: rating.id, scoreType: rating.preset ?? 'csat' }
}

// ── API serialization (strip empty optionals so the strict zod schema accepts) ─

function cleanRating(q: RatingQuestionUI): Record<string, unknown> {
  return {
    type: 'rating',
    id: q.id,
    question: q.question,
    scale: q.scale,
    display: q.display,
    ...(q.lowerLabel?.trim() ? { lowerLabel: q.lowerLabel.trim() } : {}),
    ...(q.upperLabel?.trim() ? { upperLabel: q.upperLabel.trim() } : {}),
    ...(q.preset ? { preset: q.preset } : {}),
  }
}

function cleanQuestion(q: SurveyQuestionUI): Record<string, unknown> {
  switch (q.type) {
    case 'rating':
      return cleanRating(q)
    case 'open':
      return {
        type: 'open',
        id: q.id,
        question: q.question,
        ...(q.placeholder?.trim() ? { placeholder: q.placeholder.trim() } : {}),
      }
    case 'single_choice':
    case 'multiple_choice':
      return {
        type: q.type,
        id: q.id,
        question: q.question,
        choices: q.choices.map((c) => c.trim()).filter(Boolean),
      }
    case 'link':
      return {
        type: 'link',
        id: q.id,
        question: q.question,
        buttonText: q.buttonText,
        url: q.url,
      }
  }
}

function cleanAppearance(a: SurveyAppearanceUI): Record<string, unknown> {
  return {
    position: a.position,
    ...(a.backgroundColor?.trim() ? { backgroundColor: a.backgroundColor.trim() } : {}),
    ...(a.textColor?.trim() ? { textColor: a.textColor.trim() } : {}),
    ...(a.thanksMessage?.trim() ? { thanksMessage: a.thanksMessage.trim() } : {}),
  }
}

function cleanTriggers(t: SurveyTriggersUI): Record<string, unknown> {
  const events = t.events.map((e) => e.trim()).filter(Boolean)
  const eventFilters = t.eventFilters
    .filter((f) => f.key.trim())
    .map((f) => ({ key: f.key.trim(), operator: f.operator, value: f.value }))
  return {
    ...(events.length > 0 ? { events } : {}),
    ...(eventFilters.length > 0 ? { eventFilters } : {}),
    ...(t.urlMatch?.trim() ? { urlMatch: t.urlMatch.trim() } : {}),
    ...(t.selector?.trim() ? { selector: t.selector.trim() } : {}),
    ...(typeof t.delayMs === 'number' && t.delayMs >= 0 ? { delayMs: t.delayMs } : {}),
    frequency: t.frequency,
  }
}

/** Serialize the editor state into the exact shape `surveyDefinitionSchema` accepts. */
export function toApiDefinition(def: SurveyDefinitionUI): Record<string, unknown> {
  return {
    version: 1,
    questions: def.questions.map(cleanQuestion),
    appearance: cleanAppearance(def.appearance),
    triggers: cleanTriggers(def.triggers),
  }
}

/** Best-effort hydrate a persisted `Json` definition into the editor shape. */
export function fromApiDefinition(raw: unknown): SurveyDefinitionUI {
  const d = (raw ?? {}) as Partial<SurveyDefinitionUI>
  const questions = Array.isArray(d.questions) ? (d.questions as SurveyQuestionUI[]) : []
  return {
    version: 1,
    questions: questions.length > 0 ? questions : [newQuestion('rating')],
    appearance: { ...defaultAppearance(), ...(d.appearance ?? {}) },
    triggers: hydrateTriggers(d.triggers),
  }
}

/** Hydrate the persisted triggers shape — tolerating a legacy singular `event`. */
function hydrateTriggers(raw: unknown): SurveyTriggersUI {
  const t = (raw ?? {}) as Record<string, unknown> & Partial<SurveyTriggersUI>
  const events = Array.isArray(t.events)
    ? (t.events as unknown[]).filter((e): e is string => typeof e === 'string')
    : typeof (t as { event?: unknown }).event === 'string'
      ? [(t as { event: string }).event]
      : []
  const eventFilters = Array.isArray(t.eventFilters) ? (t.eventFilters as PropertyFilter[]) : []
  return { ...defaultTriggers(), ...t, events, eventFilters }
}

/** Validation for save — returns an error message or null. */
export function validateDefinition(name: string, def: SurveyDefinitionUI): string | null {
  if (!name.trim()) return 'A survey name is required.'
  if (def.questions.length === 0) return 'Add at least one question.'
  for (const q of def.questions) {
    if (!q.question.trim()) return 'Every question needs prompt text.'
    if (
      (q.type === 'single_choice' || q.type === 'multiple_choice') &&
      q.choices.map((c) => c.trim()).filter(Boolean).length === 0
    ) {
      return 'Choice questions need at least one option.'
    }
    if (q.type === 'link') {
      if (!q.buttonText.trim()) return 'Link questions need button text.'
      try {
        // Mirrors the schema's z.string().url() — reject anything not a URL.
        new URL(q.url)
      } catch {
        return 'Link questions need a valid URL (including https://).'
      }
    }
  }
  return null
}
