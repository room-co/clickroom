import { z } from 'zod'

// ── Support form definition (versioned Json `definition` column) ─────────────
// Mirrors `surveys.schema.ts` / `segments.schema.ts`: a versioned
// definition object whose shape is gated by `version: literal(1)`, with the
// field primitives modelled as a discriminated union on `type`
// (segments.schema.ts:8+ style). The definition holds the channel, the ordered
// fields[], the (bot-phase) sources[], the widget appearance, the user-tracking
// toggles, the routing destinations and the client-side triggers.

// ── Channel ─────────────────────────────────────────────────────────────────
/**
 * `contact` (plain contact form) and `bug` (bug report) ship complete this
 * phase.
 *
 * `bot` PARSES AND ROUND-TRIPS — the builder's channel toggle renders it
 * disabled/"coming soon" and the Sources section renders read-only, so a
 * definition saved with `channel: 'bot'` must survive a read/write cycle
 * unchanged. But there is no retrieval stack yet (no vector store, no
 * embeddings, no crawler — `packages/ai` is LLM-call-only), so **the SDK treats
 * `bot` exactly as `contact`** until the answer-bot phase lands: the widget
 * renders the ticket form and never the ask/answer steps. Do not add
 * bot-conditional behavior anywhere downstream on the strength of this value
 * alone ("AI answer bot is deferred to a later phase").
 */
export const supportChannelSchema = z.enum(['contact', 'bot', 'bug'])

export type SupportChannelInput = z.infer<typeof supportChannelSchema>

// ── Field primitives (discriminated union on `type`) ────────────────────────
// Every field shares id/label/required; the rest is type-specific. `id` is the
// key the submitted answer lands under in `SupportTicket.fields`, so it must be
// stable across edits.
const fieldBase = {
  id: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean().default(false),
} as const

const shortTextFieldSchema = z
  .object({
    ...fieldBase,
    type: z.literal('short_text'),
    placeholder: z.string().optional(),
    maxLength: z.number().int().positive().optional(),
  })
  .strict()

const longTextFieldSchema = z
  .object({
    ...fieldBase,
    type: z.literal('long_text'),
    placeholder: z.string().optional(),
    rows: z.number().int().min(2).max(20).optional(),
    maxLength: z.number().int().positive().optional(),
  })
  .strict()

const dropdownFieldSchema = z
  .object({
    ...fieldBase,
    type: z.literal('dropdown'),
    choices: z.array(z.string().min(1)).min(1),
    placeholder: z.string().optional(),
  })
  .strict()

const emailFieldSchema = z
  .object({
    ...fieldBase,
    type: z.literal('email'),
    placeholder: z.string().optional(),
  })
  .strict()

// Attachment picker. The caps are advisory hints for the widget's client-side
// validation only — the authoritative MIME allow-list and byte cap live on the
// presign endpoint, which never trusts a client-supplied definition.
const fileFieldSchema = z
  .object({
    ...fieldBase,
    type: z.literal('file'),
    maxFiles: z.number().int().min(1).max(10).optional(),
    maxSizeMb: z.number().int().min(1).max(25).optional(),
    accept: z.array(z.string().min(1)).optional(),
  })
  .strict()

export const supportFieldSchema = z.discriminatedUnion('type', [
  shortTextFieldSchema,
  longTextFieldSchema,
  dropdownFieldSchema,
  emailFieldSchema,
  fileFieldSchema,
])

export type SupportFieldInput = z.infer<typeof supportFieldSchema>

// ── Sources (answer-bot knowledge refs — read-only until the bot phase) ─────
// Persisted so a customer can stage their sources now, but nothing consumes
// them yet: crawling/chunking/embedding is its own phase.
export const supportSourceSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['url', 'sitemap', 'text']),
    value: z.string().min(1),
    label: z.string().optional(),
  })
  .strict()

export type SupportSourceInput = z.infer<typeof supportSourceSchema>

// ── Appearance ──────────────────────────────────────────────────────────────
// `layout` picks which of the design's shells the widget renders (1b launcher +
// panel, 1c slide-out, 1d centered modal, 3a inline page); `position` only
// applies to the anchored layouts — `inline` fills a host container and has no
// launcher and no position.
export const supportLayoutSchema = z.enum(['launcher', 'slide_out', 'modal', 'inline'])

export const supportPositionSchema = z.enum(['bottom_right', 'bottom_left', 'center'])

export const supportAppearanceSchema = z
  .object({
    layout: supportLayoutSchema,
    position: supportPositionSchema,
    primaryColor: z.string().optional(),
    backgroundColor: z.string().optional(),
    textColor: z.string().optional(),
    launcherLabel: z.string().optional(),
    greeting: z.string().optional(),
    thanksMessage: z.string().optional(),
    // ── Expanded appearance ────────────────────────────────────────
    // All optional so an existing definition round-trips unchanged; the SDK's
    // `DEFAULT_APPEARANCE` supplies the concrete default for each. `launcherIcon`
    // is a CLOSED enum, never a raw SVG/HTML string — a host-supplied glyph would
    // be an injection vector into the widget's shadow root, so the four presets map
    // to built-in icon geometry instead (message→message-square, help→help-circle,
    // chat→message-square-more, question→help-circle).
    launcherIcon: z.enum(['message', 'help', 'chat', 'question']).optional(),
    /** Launcher bubble diameter in px (glyph scales ~0.44×). Default 52 (the design's FAB). */
    launcherSize: z.number().int().min(40).max(72).optional(),
    /** Panel corner radius in px. Default 16 (the 1b launcher panel's r16). */
    cornerRadius: z.number().int().min(0).max(24).optional(),
    /** Launcher-layout panel width in px. Default 320. Ignored by slide_out/modal. */
    panelWidth: z.number().int().min(300).max(480).optional(),
    /** Launcher-layout header: keep the indigo `accent` bar or swap to the `plain`
     *  bordered header. Default per-layout (launcher = accent). No-op for slide_out/modal. */
    headerStyle: z.enum(['accent', 'plain']).optional(),
    /** Suppress the "Powered by Clickroom" footer on the 1b home step. Default false. */
    hideBranding: z.boolean().optional(),
    /** Override the hardcoded Inter font stack. Any non-empty CSS font-family list. */
    fontFamily: z.string().optional(),
  })
  .strict()

export type SupportAppearanceInput = z.infer<typeof supportAppearanceSchema>

// ── User tracking ───────────────────────────────────────────────────────────
// The whole point of in-Clickroom support: a ticket arrives already
// carrying who the user is, what they just did and which flags they had on. All
// ON by default — `sessionReplay` is the exception because Clickroom has no
// replay product yet, so the builder renders it unchecked.
export const supportTrackingSchema = z
  .object({
    identity: z.boolean().default(true),
    formAnalytics: z.boolean().default(true),
    recentEvents: z.boolean().default(true),
    sessionReplay: z.boolean().default(false),
    /**
     * Opt-in bug evidence capture (environment + console errors + failed
     * requests). DEFAULT OFF and off for every existing form: no console
     * patching, no fetch patching, no extra bytes unless a customer asks for it.
     *
     * Adding this key does NOT bump `supportDefinitionSchema.version` — it is
     * purely additive, so every stored v1 definition still parses (the default
     * fills the missing key) and `.strict()` now knows the key. A `version: 2`
     * would force a `z.union([v1, v2])` plus a migration of every stored
     * definition for zero benefit.
     */
    bugContext: z.boolean().default(false),
  })
  .strict()

export type SupportTrackingInput = z.infer<typeof supportTrackingSchema>

// ── Routing ─────────────────────────────────────────────────────────────────
// Outbound integration is signed webhooks only this phase — Slack,
// Discord, n8n, Zapier and any customer backend are all just an HTTP endpoint.
// A destination references a `SupportWebhook` row by id; the secret and URL
// never live in the definition.
export const supportWebhookRefSchema = z.object({ webhookId: z.string().min(1) }).strict()

export type SupportWebhookRefInput = z.infer<typeof supportWebhookRefSchema>

export const supportRoutingSchema = z
  .object({
    destinations: z.array(supportWebhookRefSchema).default([]),
    autoReply: z.boolean().default(false),
  })
  .strict()

export type SupportRoutingInput = z.infer<typeof supportRoutingSchema>

// ── Triggers ────────────────────────────────────────────────────────────────
// Evaluated client-side by the SDK, same contract as `surveyTriggersSchema`.
// Unlike a survey there is no display-frequency policy: the launcher is a
// persistent affordance, so the only questions are "is it mounted on this page"
// and "does it open by itself".
export const supportTriggersSchema = z
  .object({
    urlMatch: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    delayMs: z.number().int().nonnegative().optional(),
    events: z.array(z.string().min(1)).optional(),
    showLauncher: z.boolean().default(true),
    autoOpen: z.boolean().default(false),
  })
  .strict()

export type SupportTriggersInput = z.infer<typeof supportTriggersSchema>

// ── Definition ──────────────────────────────────────────────────────────────
// Subject and Message are STRUCTURAL: the widget always renders them and capture-rs validates
// `subject`/`body` separately from the declared custom fields. They must never appear in `fields`
// — a saved form that declares a required "Subject" field carries a field the widget never submits,
// which capture-rs then rejects with `missing required field` (a hard 400 on every ticket). Reject
// these reserved labels/ids at the write boundary so a bad definition can never be persisted.
const RESERVED_FIELD_LABELS = new Set(['subject', 'message'])
const RESERVED_FIELD_IDS = new Set(['subject', '$subject', 'body', '$body'])

export const supportDefinitionSchema = z
  .object({
    version: z.literal(1),
    channel: supportChannelSchema,
    // May be empty: the structural Subject + Message pair always renders, so a form with no extra
    // custom fields is valid.
    fields: z.array(supportFieldSchema),
    sources: z.array(supportSourceSchema).default([]),
    appearance: supportAppearanceSchema,
    tracking: supportTrackingSchema,
    routing: supportRoutingSchema,
    triggers: supportTriggersSchema,
  })
  .strict()
  .superRefine((def, ctx) => {
    def.fields.forEach((f, i) => {
      const label = f.label.trim().toLowerCase()
      if (RESERVED_FIELD_LABELS.has(label) || RESERVED_FIELD_IDS.has(f.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', i, 'label'],
          message: `"${f.label}" is a built-in field — Subject and Message are always included and can't be added as custom fields.`,
        })
      }
    })
  })

export type SupportDefinitionInput = z.infer<typeof supportDefinitionSchema>

// ── Lifecycle status ────────────────────────────────────────────────────────
// Plain string column — same convention as surveys/experiments.
export const supportStatusSchema = z.enum(['draft', 'active', 'archived'])

export type SupportStatusInput = z.infer<typeof supportStatusSchema>

// ── Form CRUD inputs ────────────────────────────────────────────────────────
export const createSupportFormInput = z
  .object({
    projectId: z.string(),
    name: z.string().min(1),
    description: z.string().optional(),
    definition: supportDefinitionSchema,
  })
  .strict()

export type CreateSupportFormInput = z.infer<typeof createSupportFormInput>

const supportFormPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    status: supportStatusSchema.optional(),
    definition: supportDefinitionSchema.optional(),
  })
  .strict()

export const updateSupportFormInput = z
  .object({
    id: z.string(),
    projectId: z.string(),
    patch: supportFormPatchSchema,
  })
  .strict()

export type UpdateSupportFormInput = z.infer<typeof updateSupportFormInput>

export const listSupportFormsInput = z
  .object({
    projectId: z.string(),
    status: supportStatusSchema.optional(),
  })
  .strict()

export type ListSupportFormsInput = z.infer<typeof listSupportFormsInput>

export const getSupportFormInput = z.object({ id: z.string(), projectId: z.string() }).strict()

export type GetSupportFormInput = z.infer<typeof getSupportFormInput>

export const deleteSupportFormInput = z.object({ id: z.string(), projectId: z.string() }).strict()

export type DeleteSupportFormInput = z.infer<typeof deleteSupportFormInput>

// ── Ticket inputs (support.tickets.*) ───────────────────────────────────────
// Status/priority are plain string columns in Postgres; the allowed
// values are enforced here.
export const supportTicketStatusSchema = z.enum(['open', 'pending', 'resolved', 'closed'])

export type SupportTicketStatusInput = z.infer<typeof supportTicketStatusSchema>

export const supportTicketPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent'])

export type SupportTicketPriorityInput = z.infer<typeof supportTicketPrioritySchema>

// ── Ticket type / severity / bug payload ───────────────────────────
// Follows the `Insight` precedent exactly: a `type` column plus a payload
// discriminated on the same key (insights.schema.ts:102-108). `severity` is a
// column rather than a `bugReport` key for the same reason `priority` is one —
// it is agent-mutable, filterable and sortable, and a JSON key is neither
// indexable nor cheap to `orderBy`.
export const supportTicketTypeSchema = z.enum(['conversation', 'bug'])

export type SupportTicketTypeInput = z.infer<typeof supportTicketTypeSchema>

export const supportTicketSeveritySchema = z.enum(['blocker', 'major', 'minor'])

export type SupportTicketSeverityInput = z.infer<typeof supportTicketSeveritySchema>

export const bugEnvironmentSchema = z
  .object({
    url: z.string().max(2048).optional(),
    referrer: z.string().max(2048).optional(),
    viewportWidth: z.number().int().nonnegative().optional(),
    viewportHeight: z.number().int().nonnegative().optional(),
    screenWidth: z.number().int().nonnegative().optional(),
    screenHeight: z.number().int().nonnegative().optional(),
    browser: z.string().max(64).optional(),
    browserVersion: z.string().max(32).optional(),
    os: z.string().max(64).optional(),
    deviceType: z.string().max(32).optional(),
    locale: z.string().max(32).optional(),
    timezone: z.string().max(64).optional(),
  })
  .strict()

export type BugEnvironmentInput = z.infer<typeof bugEnvironmentSchema>

export const bugConsoleEntrySchema = z
  .object({
    level: z.enum(['error', 'warn']),
    message: z.string().max(2000),
    timestamp: z.string(),
    /** "file:line:col" when the runtime gave us one. */
    source: z.string().max(512).optional(),
  })
  .strict()

export type BugConsoleEntryInput = z.infer<typeof bugConsoleEntrySchema>

export const bugNetworkEntrySchema = z
  .object({
    method: z.string().max(10),
    url: z.string().max(2048),
    /** null = rejected/aborted — the request never reached a status. */
    status: z.number().int().nullable(),
    durationMs: z.number().nonnegative().optional(),
    timestamp: z.string(),
    error: z.string().max(512).optional(),
  })
  .strict()

export type BugNetworkEntryInput = z.infer<typeof bugNetworkEntrySchema>

export const supportBugReportSchema = z
  .object({
    capturedAt: z.string(),
    environment: bugEnvironmentSchema.optional(),
    consoleErrors: z.array(bugConsoleEntrySchema).max(20).optional(),
    networkErrors: z.array(bugNetworkEntrySchema).max(20).optional(),
  })
  .strict()

export type SupportBugReportInput = z.infer<typeof supportBugReportSchema>

/** The discriminated ticket payload — `insightConfigSchema`'s shape (insights.schema.ts:102-108). */
export const supportTicketPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation') }).strict(),
  z
    .object({
      type: z.literal('bug'),
      severity: supportTicketSeveritySchema.nullable().optional(),
      bugReport: supportBugReportSchema.nullable().optional(),
    })
    .strict(),
])

export type SupportTicketPayloadInput = z.infer<typeof supportTicketPayloadSchema>

// ── Structural sync guard (insights.schema.ts:111-135 style) ────────────────
// The bug payload shape is maintained by hand in THREE places: this file, the
// SDK (`packages/sdk-js/src/support-bug.ts`) and the Rust sanitizer
// (`services/capture/src/support/bug.rs`). The SDK types are MIRRORED here, not
// imported — `packages/sdk-js` must stay dependency-free and must never take a
// build-time edge on the tRPC router. The two `satisfies` pins below turn drift
// on the zod↔SDK edge into a typecheck failure: one pins a value typed by the
// zod inference against the SDK mirror, the other pins the reverse, so a field
// added, removed or re-optionalised on either side fails to compile.
// (The Rust edge is covered only by `bug.rs`'s unit tests.)

/** Hand-mirror of the SDK's `BugEnvironment`. */
type SdkBugEnvironmentMirror = {
  url?: string
  referrer?: string
  viewportWidth?: number
  viewportHeight?: number
  screenWidth?: number
  screenHeight?: number
  browser?: string
  browserVersion?: string
  os?: string
  deviceType?: string
  locale?: string
  timezone?: string
}

/** Hand-mirror of the SDK's `BugConsoleEntry`. */
type SdkBugConsoleEntryMirror = {
  level: 'error' | 'warn'
  message: string
  timestamp: string
  source?: string
}

/** Hand-mirror of the SDK's `BugNetworkEntry`. */
type SdkBugNetworkEntryMirror = {
  method: string
  url: string
  status: number | null
  durationMs?: number
  timestamp: string
  error?: string
}

/** Hand-mirror of the SDK's `SupportBugReport`. */
type SdkSupportBugReportMirror = {
  capturedAt: string
  environment?: SdkBugEnvironmentMirror
  consoleErrors?: SdkBugConsoleEntryMirror[]
  networkErrors?: SdkBugNetworkEntryMirror[]
}

const _syncCheckBugReportFromZod: SupportBugReportInput = {
  capturedAt: '2026-07-25T00:00:00.000Z',
  environment: {
    url: 'https://example.com/checkout',
    referrer: 'https://example.com/',
    viewportWidth: 1280,
    viewportHeight: 720,
    screenWidth: 1920,
    screenHeight: 1080,
    browser: 'Chrome',
    browserVersion: '126.0',
    os: 'macOS',
    deviceType: 'desktop',
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
  },
  consoleErrors: [
    {
      level: 'error',
      message: 'TypeError: undefined is not a function',
      timestamp: '2026-07-25T00:00:00.000Z',
      source: 'app.js:12:5',
    },
  ],
  networkErrors: [
    {
      method: 'POST',
      url: 'https://api.example.com/orders',
      status: 500,
      durationMs: 812,
      timestamp: '2026-07-25T00:00:00.000Z',
      error: 'Internal Server Error',
    },
  ],
}

const _syncCheckBugReportZodMatchesSdk =
  _syncCheckBugReportFromZod satisfies SdkSupportBugReportMirror

const _syncCheckBugReportFromSdk: SdkSupportBugReportMirror = _syncCheckBugReportFromZod

const _syncCheckBugReportSdkMatchesZod = _syncCheckBugReportFromSdk satisfies SupportBugReportInput

void _syncCheckBugReportZodMatchesSdk
void _syncCheckBugReportSdkMatchesZod

/**
 * Author of a thread message. `ai` joins `user`/`agent`/`system` now that the
 * answer-bot can post replies (widened the Postgres comment to match) —
 * the same `TicketMessage[]` shape is rendered by the 1f inbox and the 2b
 * widget, so both read this union.
 */
export const supportMessageAuthorTypeSchema = z.enum(['user', 'agent', 'ai', 'system'])

export type SupportMessageAuthorType = z.infer<typeof supportMessageAuthorTypeSchema>

export const listSupportTicketsInput = z
  .object({
    projectId: z.string(),
    formId: z.string().optional(),
    status: supportTicketStatusSchema.optional(),
    /** Inbox type tab — omit for "All". */
    type: supportTicketTypeSchema.optional(),
    /** Bug-only filter; meaningless (and empty) on conversations. */
    severity: supportTicketSeveritySchema.optional(),
    category: z.string().min(1).optional(),
    assigneeId: z.string().min(1).optional(),
    /** Inclusive `createdAt` lower bound, ISO 8601. */
    from: z.string().datetime().optional(),
    /** Inclusive `createdAt` upper bound, ISO 8601. */
    to: z.string().datetime().optional(),
    cursor: z.string().nullish(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict()

export type ListSupportTicketsInput = z.infer<typeof listSupportTicketsInput>

export const getSupportTicketInput = z.object({ id: z.string(), projectId: z.string() }).strict()

export type GetSupportTicketInput = z.infer<typeof getSupportTicketInput>

export const replySupportTicketInput = z
  .object({
    id: z.string(),
    projectId: z.string(),
    body: z.string().min(1),
  })
  .strict()

export type ReplySupportTicketInput = z.infer<typeof replySupportTicketInput>

export const setSupportTicketStatusInput = z
  .object({
    id: z.string(),
    projectId: z.string(),
    status: supportTicketStatusSchema,
  })
  .strict()

export type SetSupportTicketStatusInput = z.infer<typeof setSupportTicketStatusInput>

/**
 * `priority` is a real column no agent surface could write before — it
 * rendered read-only in the detail view and was `"normal"` forever.
 */
export const setSupportTicketPriorityInput = z
  .object({
    id: z.string(),
    projectId: z.string(),
    priority: supportTicketPrioritySchema,
  })
  .strict()

export type SetSupportTicketPriorityInput = z.infer<typeof setSupportTicketPriorityInput>

/** `null` clears the severity. The router rejects this on a non-bug ticket. */
export const setSupportTicketSeverityInput = z
  .object({
    id: z.string(),
    projectId: z.string(),
    severity: supportTicketSeveritySchema.nullable(),
  })
  .strict()

export type SetSupportTicketSeverityInput = z.infer<typeof setSupportTicketSeverityInput>

/**
 * End-user ticket list (widget frame 2a). Scoped to the current identified
 * end-user by `distinctId` (and `personId` once they log in), never to a form
 * or an agent — a user sees only tickets they raised.
 */
export const listSupportTicketsForUserInput = z
  .object({
    projectId: z.string(),
    distinctId: z.string().min(1),
    personId: z.string().min(1).optional(),
    cursor: z.string().nullish(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict()

export type ListSupportTicketsForUserInput = z.infer<typeof listSupportTicketsForUserInput>

/**
 * Read one ticket's thread. When `distinctId`/`personId` are present the read is
 * scoped to the requesting end-user (widget frame 2b); absent = an agent read
 * (already gated by `projects:read`).
 */
export const supportThreadInput = z
  .object({
    id: z.string(),
    projectId: z.string(),
    distinctId: z.string().min(1).optional(),
    personId: z.string().min(1).optional(),
  })
  .strict()

export type SupportThreadInput = z.infer<typeof supportThreadInput>

/** Agent-side "mark solved" — a thin alias over `setStatus`'s terminal path. */
export const markSupportTicketSolvedInput = z
  .object({ id: z.string(), projectId: z.string() })
  .strict()

export type MarkSupportTicketSolvedInput = z.infer<typeof markSupportTicketSolvedInput>

export const assignSupportTicketInput = z
  .object({
    id: z.string(),
    projectId: z.string(),
    /** `null` unassigns. */
    assigneeId: z.string().min(1).nullable(),
  })
  .strict()

export type AssignSupportTicketInput = z.infer<typeof assignSupportTicketInput>

// ── Webhook inputs (support.webhooks.*) ─────────────────────────────────────
/**
 * The outbound event names a webhook can subscribe to. `ping` is deliberately
 * NOT here — it is the synthetic event `webhooks.test` enqueues, never
 * something a customer subscribes to.
 */
export const supportWebhookEventSchema = z.enum([
  'ticket.created',
  // Wire name kept earlier; the `6b` checkbox list labels it "Message".
  'ticket.replied',
  // In the enum since and never emitted. Removing it would break any
  // customer already subscribed, so it stays — see non-goals.
  'ticket.updated',
  'ticket.resolved',
  'ticket.reopened',
])

export type SupportWebhookEventInput = z.infer<typeof supportWebhookEventSchema>

/**
 * Endpoint URLs are HTTPS-only. Enforced here so a plain-`http://` URL is
 * refused at the form, not silently at delivery time — and mirrored client-side
 * in the `6b` sheet. The runtime send paths additionally re-check via
 * `isHttpsWebhookUrl` / `admitWebhookUrl` in `support.webhook-signing.ts`.
 */
const httpsUrl = z
  .string()
  .url()
  .refine(
    (u) => {
      try {
        return new URL(u).protocol === 'https:'
      } catch {
        return false
      }
    },
    { message: 'Endpoint URL must be https://' },
  )

/** Human label shown above the URL in the `6a` list. */
const supportWebhookName = z.string().min(1).max(80)

export const listSupportWebhooksInput = z.object({ projectId: z.string() }).strict()

export type ListSupportWebhooksInput = z.infer<typeof listSupportWebhooksInput>

export const createSupportWebhookInput = z
  .object({
    projectId: z.string(),
    name: supportWebhookName,
    url: httpsUrl,
    events: z.array(supportWebhookEventSchema).min(1),
  })
  .strict()

export type CreateSupportWebhookInput = z.infer<typeof createSupportWebhookInput>

const supportWebhookPatchSchema = z
  .object({
    name: supportWebhookName.optional(),
    url: httpsUrl.optional(),
    events: z.array(supportWebhookEventSchema).min(1).optional(),
    active: z.boolean().optional(),
  })
  .strict()

export const updateSupportWebhookInput = z
  .object({
    id: z.string(),
    projectId: z.string(),
    patch: supportWebhookPatchSchema,
  })
  .strict()

export type UpdateSupportWebhookInput = z.infer<typeof updateSupportWebhookInput>

export const deleteSupportWebhookInput = z
  .object({ id: z.string(), projectId: z.string() })
  .strict()

export type DeleteSupportWebhookInput = z.infer<typeof deleteSupportWebhookInput>

export const testSupportWebhookInput = z.object({ id: z.string(), projectId: z.string() }).strict()

export type TestSupportWebhookInput = z.infer<typeof testSupportWebhookInput>

export const rotateSupportWebhookSecretInput = z
  .object({ id: z.string(), projectId: z.string() })
  .strict()

export type RotateSupportWebhookSecretInput = z.infer<typeof rotateSupportWebhookSecretInput>

/**
 * Synchronous send-test. Either an existing webhook (`id`, whose stored secret
 * and URL are used) or an **unsaved** `{ url, events }` — frame `6b` lets you
 * test the endpoint before the first save, when no row exists to reference.
 */
export const sendSupportWebhookTestInput = z
  .object({
    projectId: z.string(),
    id: z.string().optional(),
    url: httpsUrl.optional(),
    events: z.array(supportWebhookEventSchema).min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.id && !value.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either a saved webhook `id` or an unsaved `url`',
        path: ['url'],
      })
    }
  })

export type SendSupportWebhookTestInput = z.infer<typeof sendSupportWebhookTestInput>

/**
 * The delete guard's data: which forms route at this webhook. A separate read
 * from `delete`, because the confirm dialog has to render its chips *before*
 * anything is deleted.
 */
export const supportWebhookAffectedFormsInput = z
  .object({ id: z.string(), projectId: z.string() })
  .strict()

export type SupportWebhookAffectedFormsInput = z.infer<typeof supportWebhookAffectedFormsInput>

/** Project-wide rolling health, one query for every webhook (constraint 8). */
export const supportWebhookHealthInput = z.object({ projectId: z.string() }).strict()

export type SupportWebhookHealthInput = z.infer<typeof supportWebhookHealthInput>

/**
 * The history sheet's four stat cards. Separate from `health` because this
 * window is user-chosen while health is fixed at the last 20 deliveries.
 */
export const supportWebhookStatsInput = z
  .object({
    projectId: z.string(),
    webhookId: z.string(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict()

export type SupportWebhookStatsInput = z.infer<typeof supportWebhookStatsInput>

export const retrySupportWebhookDeliveryInput = z
  .object({ projectId: z.string(), webhookId: z.string(), deliveryId: z.string() })
  .strict()

export type RetrySupportWebhookDeliveryInput = z.infer<typeof retrySupportWebhookDeliveryInput>

/** Bulk retry. The router caps how many rows one invocation resets. */
export const retryAllFailedSupportWebhookDeliveriesInput = z
  .object({
    projectId: z.string(),
    webhookId: z.string(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict()

export type RetryAllFailedSupportWebhookDeliveriesInput = z.infer<
  typeof retryAllFailedSupportWebhookDeliveriesInput
>

/** Clears the auto-disable and replays the queued backlog in `createdAt` order. */
export const reEnableSupportWebhookInput = z
  .object({ id: z.string(), projectId: z.string() })
  .strict()

export type ReEnableSupportWebhookInput = z.infer<typeof reEnableSupportWebhookInput>

/** Lifecycle of one queued delivery, mirroring `SupportWebhookDelivery.status`. */
export const supportWebhookDeliveryStatusSchema = z.enum(['pending', 'delivered', 'failed'])

export type SupportWebhookDeliveryStatus = z.infer<typeof supportWebhookDeliveryStatusSchema>

/**
 * The history sheet's filter — a *view* over the stored status, not the stored
 * status itself. `'retrying'` is deliberately absent from
 * `supportWebhookDeliveryStatusSchema` above and is never written to a row: the
 * worker's claim predicate is `status='pending'`
 * (`services/ingest/src/webhook_job.rs:226`), so a third live status value would
 * silently stop every retry. The router maps `'retrying'` to
 * `status='pending' AND attempts > 0`.
 */
export const supportWebhookDeliveryFilterSchema = z.enum(['all', 'delivered', 'failed', 'retrying'])

export type SupportWebhookDeliveryFilter = z.infer<typeof supportWebhookDeliveryFilterSchema>

/**
 * What the `7a` "event" filter chip can select. It is `supportWebhookEventSchema`
 * PLUS `'ping'`: a ping is never something a customer subscribes to (so it is
 * absent from the subscription enum), but `webhooks.sendTest` writes real
 * `event: 'ping'` delivery rows, and those rows show up in the history table —
 * a filter that cannot name them would be lying about what the table contains.
 *
 * Spelled out rather than derived from `supportWebhookEventSchema.options`
 * because `z.enum` needs a literal tuple; `support.schema.test.ts` asserts the
 * two stay in step, so adding an event to the subscription enum without adding
 * it here fails loudly.
 */
export const supportWebhookDeliveryEventFilterSchema = z.enum([
  'ticket.created',
  'ticket.replied',
  'ticket.updated',
  'ticket.resolved',
  'ticket.reopened',
  'ping',
])

export type SupportWebhookDeliveryEventFilter = z.infer<
  typeof supportWebhookDeliveryEventFilterSchema
>

/**
 * The filter set the `7a` page keeps in the URL, shared verbatim by
 * `webhooks.deliveries` and `webhooks.exportCsv` — Export CSV has to honour the
 * ACTIVE filters, not just the page on screen, and the only way that stays true
 * is for both procedures to take the same fields and run them through the same
 * `where` builder.
 *
 * `search` semantics (documented here because the UI has to explain them):
 *   - trimmed, case-insensitive, matched as OR across three things;
 *   - **ticket id** — EXACT match. Ids are opaque ULIDs; a substring match on
 *     one is meaningless and would force a scan of every delivery.
 *   - **ticket number** — exact, with an optional leading `#`, when the term
 *     parses as an integer.
 *   - **response body** — SUBSTRING, case-insensitive, over any attempt of the
 *     delivery. `SupportWebhookAttempt.responseBody` is NULLed by the retention
 *     job after 30 days, so a purged row CANNOT match a body search however
 *     well it once would have. `deliveries` returns `search.purgedDeliveries`
 *     for exactly this: the count of deliveries in the current view whose
 *     bodies are gone, so the page can say "N older deliveries in this range
 *     had their bodies purged and cannot match".
 *
 * `responseCodeMin`/`responseCodeMax` bound `SupportWebhookDelivery.lastStatusCode`
 * — the code the Response column renders. A delivery with NO response at all
 * (DNS/connect/timeout, `lastStatusCode` NULL) therefore matches no range,
 * which is correct: "500–599" must not sweep up rows that never got a status.
 */
const supportWebhookDeliveryFilterFields = {
  status: supportWebhookDeliveryFilterSchema.default('all'),
  event: supportWebhookDeliveryEventFilterSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  responseCodeMin: z.number().int().min(100).max(599).optional(),
  responseCodeMax: z.number().int().min(100).max(599).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
}

/** `min > max` selects nothing at all — refuse it rather than return an empty page. */
function refineResponseCodeRange(
  value: { responseCodeMin?: number; responseCodeMax?: number },
  ctx: z.RefinementCtx,
): void {
  if (
    value.responseCodeMin !== undefined &&
    value.responseCodeMax !== undefined &&
    value.responseCodeMin > value.responseCodeMax
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'responseCodeMin must be <= responseCodeMax',
      path: ['responseCodeMin'],
    })
  }
}

/**
 * Delivery history for ONE webhook. `webhookId` is required rather than optional
 * because a project-wide feed would mix endpoints whose payloads have nothing to
 * do with each other — debugging "why didn't my endpoint fire" is always scoped
 * to the endpoint. Cursor-paginated exactly like `listSupportTicketsInput`.
 */
export const listSupportWebhookDeliveriesInput = z
  .object({
    projectId: z.string(),
    webhookId: z.string(),
    ...supportWebhookDeliveryFilterFields,
    cursor: z.string().nullish(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()
  .superRefine(refineResponseCodeRange)

export type ListSupportWebhookDeliveriesInput = z.infer<typeof listSupportWebhookDeliveriesInput>

/**
 * Export the CURRENT VIEW as CSV — same filter fields as `deliveries`, minus
 * `cursor`/`limit`, because the whole acceptance check is that the export is not
 * the page on screen. The router caps how many rows one call materializes and
 * returns the cap, so the page can warn rather than silently truncate.
 */
export const exportSupportWebhookDeliveriesInput = z
  .object({
    projectId: z.string(),
    webhookId: z.string(),
    ...supportWebhookDeliveryFilterFields,
  })
  .strict()
  .superRefine(refineResponseCodeRange)

export type ExportSupportWebhookDeliveriesInput = z.infer<
  typeof exportSupportWebhookDeliveriesInput
>

/**
 * Hourly delivery volume for the `7a` stacked bar chart. `from`/`to` are
 * optional: the chart draws a fixed 24 bars, so the default window is the last
 * 24 whole hours ending at the current one.
 */
export const supportWebhookVolumeInput = z
  .object({
    projectId: z.string(),
    webhookId: z.string(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict()

export type SupportWebhookVolumeInput = z.infer<typeof supportWebhookVolumeInput>

// ── Results inputs (support.results.*) ──────────────────────────────────────
// Same ISO range contract as `surveyResultsInput`; the router normalizes it to
// ClickHouse's DateTime64 format before handing it to a builder.
const supportResultsRangeSchema = z
  .object({ from: z.string().datetime(), to: z.string().datetime() })
  .strict()

export const supportResultsInput = z
  .object({
    formId: z.string(),
    projectId: z.string(),
    range: supportResultsRangeSchema,
  })
  .strict()

export type SupportResultsInput = z.infer<typeof supportResultsInput>

export const supportTrendInput = supportResultsInput
  .extend({ interval: z.enum(['hour', 'day']) })
  .strict()

export type SupportTrendInput = z.infer<typeof supportTrendInput>
