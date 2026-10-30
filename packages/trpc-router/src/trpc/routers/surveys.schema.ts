import { z } from 'zod'

// ── Survey definition (versioned Json `definition` column) ──────────────────
// Mirrors segments.schema.ts's discriminated-union style (:8+) and the
// versioned-definition shape of segmentDefinitionSchema. The definition holds
// the ordered questions[], the popover appearance, and the client-side
// triggers. `version: literal(1)` gates the shape exactly like
// segmentDefinitionSchema / insightConfigSchema.

// ── Question primitives (discriminated union on `type`) ─────────────────────
// One `rating` primitive (CSAT/CES/NPS are presets over it),
// plus `open`, `single_choice`, `multiple_choice`, and `link` (CTA button).
// Branching / skip-logic is out of scope this phase.

// CSAT/CES/NPS are named presets that fix scale+labels over the rating
// primitive; `preset` takes precedence over a hand-set scale/display.
const ratingPresetSchema = z.enum(['csat', 'ces', 'nps'])

const ratingDisplaySchema = z.enum(['number', 'emoji', 'star'])

const ratingQuestionSchema = z
  .object({
    type: z.literal('rating'),
    id: z.string().min(1),
    question: z.string().min(1),
    scale: z.union([z.literal(5), z.literal(7), z.literal(10)]),
    display: ratingDisplaySchema,
    // Optional endpoint labels shown under the low/high ends of the scale.
    lowerLabel: z.string().optional(),
    upperLabel: z.string().optional(),
    // Presets fix scale+labels; when set, it takes precedence over a
    // hand-configured rating.
    preset: ratingPresetSchema.optional(),
  })
  .strict()

const openQuestionSchema = z
  .object({
    type: z.literal('open'),
    id: z.string().min(1),
    question: z.string().min(1),
    placeholder: z.string().optional(),
  })
  .strict()

const singleChoiceQuestionSchema = z
  .object({
    type: z.literal('single_choice'),
    id: z.string().min(1),
    question: z.string().min(1),
    choices: z.array(z.string().min(1)).min(1),
  })
  .strict()

const multipleChoiceQuestionSchema = z
  .object({
    type: z.literal('multiple_choice'),
    id: z.string().min(1),
    question: z.string().min(1),
    choices: z.array(z.string().min(1)).min(1),
  })
  .strict()

const linkQuestionSchema = z
  .object({
    type: z.literal('link'),
    id: z.string().min(1),
    question: z.string().min(1),
    buttonText: z.string().min(1),
    url: z.string().url(),
  })
  .strict()

export const surveyQuestionSchema = z.discriminatedUnion('type', [
  ratingQuestionSchema,
  openQuestionSchema,
  singleChoiceQuestionSchema,
  multipleChoiceQuestionSchema,
  linkQuestionSchema,
])

export type SurveyQuestionInput = z.infer<typeof surveyQuestionSchema>

// ── Appearance ──────────────────────────────────────────────────────────────
const surveyPositionSchema = z.enum(['bottom_right', 'bottom_left', 'center'])

export const surveyAppearanceSchema = z
  .object({
    position: surveyPositionSchema,
    backgroundColor: z.string().optional(),
    textColor: z.string().optional(),
    thanksMessage: z.string().optional(),
  })
  .strict()

export type SurveyAppearanceInput = z.infer<typeof surveyAppearanceSchema>

// ── Triggers ─────────────────────────────────────────────────────────────────
// Evaluated client-side in the SDK: event name, URL match, element CSS
// selector, delay (ms), and a display-frequency policy persisted in
// localStorage per survey. The frequency policy is modeled as a union so
// `every_n_days` carries its N.
const surveyFrequencySchema = z.union([
  z.literal('once'),
  z.literal('always'),
  z.object({ every_n_days: z.number().int().positive() }).strict(),
])

export type SurveyFrequencyInput = z.infer<typeof surveyFrequencySchema>

// Property-filter condition on the triggering event. Mirrors the flag
// `propertySchema` shape (flags.router.ts): key + MVP operator + operator-
// dependent value (is_set ignores it, so value is permissive/nullable).
const surveyEventFilterOperatorSchema = z.enum([
  'exact',
  'is_not',
  'icontains',
  'gt',
  'lt',
  'is_set',
])

const surveyEventFilterSchema = z
  .object({
    key: z.string().min(1),
    operator: surveyEventFilterOperatorSchema,
    value: z.any().nullable(),
  })
  .strict()

export type SurveyEventFilterInput = z.infer<typeof surveyEventFilterSchema>

export const surveyTriggersSchema = z
  .object({
    events: z.array(z.string().min(1)).optional(),
    eventFilters: z.array(surveyEventFilterSchema).optional(),
    urlMatch: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    delayMs: z.number().int().nonnegative().optional(),
    frequency: surveyFrequencySchema,
  })
  .strict()

export type SurveyTriggersInput = z.infer<typeof surveyTriggersSchema>

// ── Definition ───────────────────────────────────────────────────────────────
export const surveyDefinitionSchema = z
  .object({
    version: z.literal(1),
    questions: z.array(surveyQuestionSchema).min(1),
    appearance: surveyAppearanceSchema,
    triggers: surveyTriggersSchema,
  })
  .strict()

export type SurveyDefinitionInput = z.infer<typeof surveyDefinitionSchema>

// ── Lifecycle status ─────────────────────────────────────────────────────────
// Plain string column in Postgres — draft/active/archived, matching
// the experiments status convention.
export const surveyStatusSchema = z.enum(['draft', 'active', 'archived'])

export type SurveyStatusInput = z.infer<typeof surveyStatusSchema>

// ── CRUD input schemas ───────────────────────────────────────────────────────
// Named/exported following segments.schema.ts + router input conventions
// (projectId-scoped, `patch` for updates).
export const createSurveyInput = z
  .object({
    projectId: z.string(),
    name: z.string().min(1),
    description: z.string().optional(),
    definition: surveyDefinitionSchema,
  })
  .strict()

export type CreateSurveyInput = z.infer<typeof createSurveyInput>

const surveyPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    status: surveyStatusSchema.optional(),
    definition: surveyDefinitionSchema.optional(),
  })
  .strict()

export const updateSurveyInput = z
  .object({
    id: z.string(),
    projectId: z.string(),
    patch: surveyPatchSchema,
  })
  .strict()

export type UpdateSurveyInput = z.infer<typeof updateSurveyInput>

export const listSurveysInput = z
  .object({
    projectId: z.string(),
    status: surveyStatusSchema.optional(),
  })
  .strict()

export type ListSurveysInput = z.infer<typeof listSurveysInput>

export const getSurveyInput = z.object({ id: z.string(), projectId: z.string() }).strict()

export type GetSurveyInput = z.infer<typeof getSurveyInput>

export const deleteSurveyInput = z.object({ id: z.string(), projectId: z.string() }).strict()

export type DeleteSurveyInput = z.infer<typeof deleteSurveyInput>

// ── Results input schemas (surveys.results.*) ────────────────────────────────
// Shared ISO date-range input — same shape/parsing contract as
// insights.schema.ts's rangeSchema (the results procedures normalize this the
// same way before handing it to a ClickHouse builder). Covers responseRate /
// score / questionBreakdown / trend / segment-breakdown.
const surveyResultsRangeSchema = z
  .object({ from: z.string().datetime(), to: z.string().datetime() })
  .strict()

export const surveyResultsInput = z
  .object({
    surveyId: z.string(),
    projectId: z.string(),
    range: surveyResultsRangeSchema,
  })
  .strict()

export type SurveyResultsInput = z.infer<typeof surveyResultsInput>

// Per-question breakdown narrows to a single question within the survey.
export const surveyQuestionBreakdownInput = surveyResultsInput
  .extend({ questionId: z.string().min(1) })
  .strict()

export type SurveyQuestionBreakdownInput = z.infer<typeof surveyQuestionBreakdownInput>

// Open-text response feed: paginated raw answers to one open question. `limit`
// is fetched as `limit + 1` server-side to derive `hasMore`.
export const surveyOpenResponsesInput = surveyQuestionBreakdownInput
  .extend({
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict()

export type SurveyOpenResponsesInput = z.infer<typeof surveyOpenResponsesInput>

// Drill-down: every answered question for one respondent (by distinct_id).
export const surveyRespondentInput = surveyResultsInput
  .extend({ distinctId: z.string().min(1) })
  .strict()

export type SurveyRespondentInput = z.infer<typeof surveyRespondentInput>

// Score input narrows to one rating question + a CSAT/CES/NPS preset (the
// allowlist that varies the ClickHouse aggregation in `buildSurveyScore`).
export const surveyScoreTypeSchema = z.enum(['csat', 'ces', 'nps'])

export type SurveyScoreTypeInput = z.infer<typeof surveyScoreTypeSchema>

export const surveyScoreInput = surveyQuestionBreakdownInput
  .extend({ scoreType: surveyScoreTypeSchema })
  .strict()

export type SurveyScoreInput = z.infer<typeof surveyScoreInput>

// Trend adds the hour/day bucket interval (shown-vs-sent over time).
export const surveyTrendInput = surveyResultsInput
  .extend({ interval: z.enum(['hour', 'day']) })
  .strict()

export type SurveyTrendInput = z.infer<typeof surveyTrendInput>

// Score breakdown by segment reuses the flag/segment breakdown allowlist
// pattern; the segment is identified by id.
export const surveySegmentBreakdownInput = surveyResultsInput
  .extend({ segmentId: z.string() })
  .strict()

export type SurveySegmentBreakdownInput = z.infer<typeof surveySegmentBreakdownInput>
