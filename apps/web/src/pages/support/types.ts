// Shared page types + helpers for the Support dashboard.
//
// Same posture as `pages/surveys/types.ts`: the UI keeps ONE definition shape
// that is intentionally identical to the server's `supportDefinitionSchema`
// (packages/trpc-router/.../support.schema.ts) so the same object can be (a)
// sent to `support.create`/`support.update` and (b) handed to the SDK's pure
// `renderSupport` for the live preview. apps/web has no runtime dependency on
// the zod schema, so the shape is re-declared here and kept in sync by
// convention + typecheck against what the mutations accept.

export type SupportStatus = 'draft' | 'active' | 'archived'

/**
 * `bot` parses and round-trips, but the builder renders it disabled/"coming
 * soon" and the SDK treats it exactly as `contact` until the answer-bot phase
 * lands.
 */
export type SupportChannel = 'contact' | 'bot' | 'bug'

export type SupportLayoutUI = 'launcher' | 'slide_out' | 'modal' | 'inline'
export type SupportPositionUI = 'bottom_right' | 'bottom_left' | 'center'

// ── Field UI shapes (mirror the discriminated union on `type`) ───────────────

interface FieldBaseUI {
  id: string
  label: string
  required: boolean
}
export interface ShortTextFieldUI extends FieldBaseUI {
  type: 'short_text'
  placeholder?: string
  maxLength?: number
}
export interface LongTextFieldUI extends FieldBaseUI {
  type: 'long_text'
  placeholder?: string
  rows?: number
  maxLength?: number
}
export interface DropdownFieldUI extends FieldBaseUI {
  type: 'dropdown'
  choices: string[]
  placeholder?: string
}
export interface EmailFieldUI extends FieldBaseUI {
  type: 'email'
  placeholder?: string
}
export interface FileFieldUI extends FieldBaseUI {
  type: 'file'
  maxFiles?: number
  maxSizeMb?: number
  accept?: string[]
}

export type SupportFieldUI =
  | ShortTextFieldUI
  | LongTextFieldUI
  | DropdownFieldUI
  | EmailFieldUI
  | FileFieldUI

export type SupportFieldType = SupportFieldUI['type']

export interface SupportSourceUI {
  id: string
  type: 'url' | 'sitemap' | 'text'
  value: string
  label?: string
}

export type SupportLauncherIconUI = 'message' | 'help' | 'chat' | 'question'
export type SupportHeaderStyleUI = 'accent' | 'plain'

/** Defaults for the appearance controls. Kept as constants so the
 *  editor's fallbacks and `cleanAppearance`'s omit-at-default checks agree. */
export const APPEARANCE_DEFAULTS = {
  launcherIcon: 'message' as SupportLauncherIconUI,
  launcherSize: 52,
  cornerRadius: 16,
  panelWidth: 320,
  headerStyle: 'accent' as SupportHeaderStyleUI,
} as const

export interface SupportAppearanceUI {
  layout: SupportLayoutUI
  position: SupportPositionUI
  primaryColor?: string
  backgroundColor?: string
  textColor?: string
  launcherLabel?: string
  greeting?: string
  thanksMessage?: string
  /** Launcher glyph. Default 'message'. */
  launcherIcon?: SupportLauncherIconUI
  /** Launcher button diameter in px (40–72). Default 52. */
  launcherSize?: number
  /** Panel / card corner radius in px (0–24). Default 16. */
  cornerRadius?: number
  /** Panel width in px (300–480). Only affects the launcher layout. Default 320. */
  panelWidth?: number
  /** Header treatment. Default 'accent'. */
  headerStyle?: SupportHeaderStyleUI
  /** Remove the "Powered by Clickroom" footer. Entitlement-gated. Default false. */
  hideBranding?: boolean
  /** CSS font-family stack. Blank falls back to the SDK's Inter stack. */
  fontFamily?: string
}

export interface SupportTrackingUI {
  identity: boolean
  formAnalytics: boolean
  recentEvents: boolean
  /** Always false / disabled — Clickroom has no session-replay product. */
  sessionReplay: boolean
  /** Opt-in bug evidence capture (environment + console errors + failed requests).
   *  Off by default and off for every earlier form — hard constraint 2. */
  bugContext: boolean
}

export interface SupportWebhookRefUI {
  webhookId: string
}

export interface SupportRoutingUI {
  destinations: SupportWebhookRefUI[]
  autoReply: boolean
}

export interface SupportTriggersUI {
  urlMatch?: string
  selector?: string
  delayMs?: number
  events?: string[]
  showLauncher: boolean
  autoOpen: boolean
}

export interface SupportDefinitionUI {
  version: 1
  channel: SupportChannel
  fields: SupportFieldUI[]
  sources: SupportSourceUI[]
  appearance: SupportAppearanceUI
  tracking: SupportTrackingUI
  routing: SupportRoutingUI
  triggers: SupportTriggersUI
}

/** A row from `support.list` / `support.get` (Prisma `SupportForm`). `definition`
 *  is `Json` on the wire — narrowed to `SupportDefinitionUI` at the call site. */
export interface SupportFormRow {
  id: string
  name: string
  description: string | null
  status: SupportStatus
  definition: unknown
  version: number
  featureFlagId: string
  createdAt: string | Date
  updatedAt: string | Date
}

// ── Labels / presets ─────────────────────────────────────────────────────────

export const FIELD_TYPE_LABELS: Record<SupportFieldType, string> = {
  short_text: 'Short text',
  long_text: 'Long text',
  dropdown: 'Dropdown',
  email: 'Email',
  file: 'File upload',
}

export const CHANNEL_LABELS: Record<SupportChannel, string> = {
  contact: 'Contact form',
  bot: 'Answer bot',
  bug: 'Bug report',
}

export const LAYOUT_LABELS: Record<SupportLayoutUI, string> = {
  launcher: 'Launcher + panel',
  slide_out: 'Slide-out drawer',
  modal: 'Centered modal',
  inline: 'Inline (page)',
}

export const POSITION_LABELS: Record<SupportPositionUI, string> = {
  bottom_right: 'Bottom right',
  bottom_left: 'Bottom left',
  center: 'Center',
}

export const STATUS_BADGE: Record<SupportStatus, 'default' | 'secondary' | 'outline'> = {
  draft: 'outline',
  active: 'default',
  archived: 'secondary',
}

export const TICKET_STATUS_BADGE: Record<
  SupportTicketStatus,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  open: 'default',
  pending: 'outline',
  resolved: 'secondary',
  closed: 'secondary',
}

export type SupportTicketStatus = 'open' | 'pending' | 'resolved' | 'closed'
export type SupportTicketPriority = 'low' | 'normal' | 'high' | 'urgent'

let idCounter = 0
/** Short, collision-resistant-enough field id for a client-side editor. */
export function newFieldId(): string {
  idCounter += 1
  return `f_${Date.now().toString(36)}_${idCounter}`
}

export function defaultAppearance(): SupportAppearanceUI {
  return {
    layout: 'launcher',
    position: 'bottom_right',
    primaryColor: '#4f46e5',
    backgroundColor: '#ffffff',
    textColor: '#0f172a',
    launcherLabel: 'Help',
    greeting: 'Hi there 👋 How can we help?',
    thanksMessage: "Thanks! We've got your message and will get back to you shortly.",
  }
}

export function defaultTracking(): SupportTrackingUI {
  // All on by default — that is the whole point of in-Clickroom support. Except
  // `sessionReplay`, which has no product behind it yet, and `bugContext`,
  // which patches `console` / `fetch` and so is strictly opt-in.
  return {
    identity: true,
    formAnalytics: true,
    recentEvents: true,
    sessionReplay: false,
    bugContext: false,
  }
}

export function defaultRouting(): SupportRoutingUI {
  return { destinations: [], autoReply: false }
}

export function defaultTriggers(): SupportTriggersUI {
  return { showLauncher: true, autoOpen: false }
}

export function newField(type: SupportFieldType): SupportFieldUI {
  const id = newFieldId()
  switch (type) {
    case 'short_text':
      // NB: label must not be a reserved structural label ("Subject"/"Message") — the save schema
      // rejects those, and the widget already renders Subject/Message structurally.
      return { type, id, label: 'Question', required: true, placeholder: 'Short answer' }
    case 'long_text':
      return { type, id, label: 'Description', required: true, rows: 5 }
    case 'dropdown':
      return { type, id, label: 'Category', required: false, choices: ['Question', 'Problem'] }
    case 'email':
      return { type, id, label: 'Email', required: true, placeholder: 'you@company.com' }
    case 'file':
      return { type, id, label: 'Attachments', required: false, maxFiles: 3, maxSizeMb: 10 }
  }
}

export type SupportTemplate = 'contact' | 'bug' | 'blank'

export const TEMPLATE_LABELS: Record<SupportTemplate, string> = {
  contact: 'Contact form',
  bug: 'Bug report',
  blank: 'Start from scratch',
}

/** Starter `definition` for the create dialog. */
export function starterDefinition(template: SupportTemplate): SupportDefinitionUI {
  const base = {
    version: 1 as const,
    sources: [] as SupportSourceUI[],
    appearance: defaultAppearance(),
    tracking: defaultTracking(),
    routing: defaultRouting(),
    triggers: defaultTriggers(),
  }
  switch (template) {
    case 'contact':
      return {
        ...base,
        channel: 'contact',
        fields: [{ type: 'email', id: newFieldId(), label: 'Email', required: true }],
      }
    case 'bug':
      return {
        ...base,
        channel: 'bug',
        fields: [
          {
            type: 'dropdown',
            id: 'category',
            label: 'Severity',
            required: false,
            choices: ['Blocker', 'Major', 'Minor'],
          },
          { type: 'file', id: newFieldId(), label: 'Screenshots', required: false, maxFiles: 3 },
        ],
      }
    case 'blank':
      return { ...base, channel: 'contact', fields: [] }
  }
}

// ── API serialization (strip empty optionals so the strict zod schema accepts) ─

function cleanField(f: SupportFieldUI): Record<string, unknown> {
  const base = { id: f.id, label: f.label.trim(), required: f.required }
  switch (f.type) {
    case 'short_text':
      return {
        ...base,
        type: 'short_text',
        ...(f.placeholder?.trim() ? { placeholder: f.placeholder.trim() } : {}),
        ...(f.maxLength && f.maxLength > 0 ? { maxLength: f.maxLength } : {}),
      }
    case 'long_text':
      return {
        ...base,
        type: 'long_text',
        ...(f.placeholder?.trim() ? { placeholder: f.placeholder.trim() } : {}),
        ...(f.rows && f.rows >= 2 ? { rows: Math.min(20, f.rows) } : {}),
        ...(f.maxLength && f.maxLength > 0 ? { maxLength: f.maxLength } : {}),
      }
    case 'dropdown':
      return {
        ...base,
        type: 'dropdown',
        choices: f.choices.map((c) => c.trim()).filter(Boolean),
        ...(f.placeholder?.trim() ? { placeholder: f.placeholder.trim() } : {}),
      }
    case 'email':
      return {
        ...base,
        type: 'email',
        ...(f.placeholder?.trim() ? { placeholder: f.placeholder.trim() } : {}),
      }
    case 'file':
      return {
        ...base,
        type: 'file',
        ...(f.maxFiles && f.maxFiles > 0 ? { maxFiles: Math.min(10, f.maxFiles) } : {}),
        ...(f.maxSizeMb && f.maxSizeMb > 0 ? { maxSizeMb: Math.min(25, f.maxSizeMb) } : {}),
        ...(f.accept && f.accept.length > 0 ? { accept: f.accept } : {}),
      }
  }
}

function cleanAppearance(a: SupportAppearanceUI): Record<string, unknown> {
  return {
    layout: a.layout,
    position: a.position,
    ...(a.primaryColor?.trim() ? { primaryColor: a.primaryColor.trim() } : {}),
    ...(a.backgroundColor?.trim() ? { backgroundColor: a.backgroundColor.trim() } : {}),
    ...(a.textColor?.trim() ? { textColor: a.textColor.trim() } : {}),
    ...(a.launcherLabel?.trim() ? { launcherLabel: a.launcherLabel.trim() } : {}),
    ...(a.greeting?.trim() ? { greeting: a.greeting.trim() } : {}),
    ...(a.thanksMessage?.trim() ? { thanksMessage: a.thanksMessage.trim() } : {}),
    // All optional appearance extras are omitted at their default so stored
    // JSON stays lean (matches the color/copy fields above).
    ...(a.launcherIcon && a.launcherIcon !== APPEARANCE_DEFAULTS.launcherIcon
      ? { launcherIcon: a.launcherIcon }
      : {}),
    ...(typeof a.launcherSize === 'number' && a.launcherSize !== APPEARANCE_DEFAULTS.launcherSize
      ? { launcherSize: a.launcherSize }
      : {}),
    ...(typeof a.cornerRadius === 'number' && a.cornerRadius !== APPEARANCE_DEFAULTS.cornerRadius
      ? { cornerRadius: a.cornerRadius }
      : {}),
    ...(typeof a.panelWidth === 'number' && a.panelWidth !== APPEARANCE_DEFAULTS.panelWidth
      ? { panelWidth: a.panelWidth }
      : {}),
    ...(a.headerStyle && a.headerStyle !== APPEARANCE_DEFAULTS.headerStyle
      ? { headerStyle: a.headerStyle }
      : {}),
    ...(a.hideBranding ? { hideBranding: true } : {}),
    ...(a.fontFamily?.trim() ? { fontFamily: a.fontFamily.trim() } : {}),
  }
}

function cleanTriggers(t: SupportTriggersUI): Record<string, unknown> {
  const events = (t.events ?? []).map((e) => e.trim()).filter(Boolean)
  return {
    ...(t.urlMatch?.trim() ? { urlMatch: t.urlMatch.trim() } : {}),
    ...(t.selector?.trim() ? { selector: t.selector.trim() } : {}),
    ...(typeof t.delayMs === 'number' && t.delayMs >= 0 ? { delayMs: t.delayMs } : {}),
    ...(events.length > 0 ? { events } : {}),
    showLauncher: t.showLauncher,
    autoOpen: t.autoOpen,
  }
}

function cleanSource(s: SupportSourceUI): Record<string, unknown> {
  return {
    id: s.id,
    type: s.type,
    value: s.value,
    ...(s.label?.trim() ? { label: s.label.trim() } : {}),
  }
}

/** Serialize the editor state into the exact shape `supportDefinitionSchema` accepts. */
export function toApiDefinition(def: SupportDefinitionUI): Record<string, unknown> {
  return {
    version: 1,
    channel: def.channel,
    fields: def.fields.map(cleanField),
    sources: def.sources.map(cleanSource),
    appearance: cleanAppearance(def.appearance),
    tracking: { ...def.tracking, sessionReplay: false },
    routing: {
      destinations: def.routing.destinations.filter((d) => d.webhookId),
      autoReply: def.routing.autoReply,
    },
    triggers: cleanTriggers(def.triggers),
  }
}

/** Best-effort hydrate a persisted `Json` definition into the editor shape. */
export function fromApiDefinition(raw: unknown): SupportDefinitionUI {
  const d = (raw ?? {}) as Partial<SupportDefinitionUI>
  const fields = Array.isArray(d.fields) ? (d.fields as SupportFieldUI[]) : []
  return {
    version: 1,
    channel: d.channel ?? 'contact',
    // Subject + Message are structural, so a form with no extra custom fields is valid — never
    // inject a phantom field here (it would render as a duplicate Subject and can't be saved).
    fields,
    sources: Array.isArray(d.sources) ? (d.sources as SupportSourceUI[]) : [],
    appearance: { ...defaultAppearance(), ...(d.appearance ?? {}) },
    tracking: { ...defaultTracking(), ...(d.tracking ?? {}), sessionReplay: false },
    routing: { ...defaultRouting(), ...(d.routing ?? {}) },
    triggers: { ...defaultTriggers(), ...(d.triggers ?? {}) },
  }
}

/** Validation for save — returns an error message or null. Mirrors the reserved-field guard in
 *  `support.schema.ts`: Subject + Message are structural and can never be declared as custom
 *  fields, and a form with zero extra fields is valid (the structural pair always renders). */
const RESERVED_FIELD_LABELS = new Set(['subject', 'message'])
const RESERVED_FIELD_IDS = new Set(['subject', '$subject', 'body', '$body'])

export function validateDefinition(name: string, def: SupportDefinitionUI): string | null {
  if (!name.trim()) return 'A form name is required.'
  const seen = new Set<string>()
  for (const f of def.fields) {
    if (!f.label.trim()) return 'Every field needs a label.'
    if (RESERVED_FIELD_LABELS.has(f.label.trim().toLowerCase()) || RESERVED_FIELD_IDS.has(f.id)) {
      return `"${f.label}" is a built-in field — Subject and Message are always included.`
    }
    if (seen.has(f.id)) return 'Field ids must be unique.'
    seen.add(f.id)
    if (f.type === 'dropdown' && f.choices.map((c) => c.trim()).filter(Boolean).length === 0) {
      return 'Dropdown fields need at least one choice.'
    }
  }
  return null
}

/** `123` → `2m 3s`; `null` → `—`. Used by the inbox's first-reply stat. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins}m ${Math.round(seconds % 60)}s`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
