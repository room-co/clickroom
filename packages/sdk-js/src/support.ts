// @clickroom/sdk-js — support config-fetch + trigger evaluation + ticket API + `$support_*`
// capture.
//
// This is the DATA/LOGIC layer only, the exact counterpart of `survey.ts`. It fetches the static
// form config from the Rust `GET /v1/support` endpoint, caches it in localStorage behind
// a version gate copying `flags.ts`, evaluates the client-side triggers, gates eligibility on the
// flag client, keeps the per-ticket read tokens, assembles the context bundle attached to a new
// ticket, and emits the `$support_*` capture events. It renders NO DOM — the shadow-DOM widget is
// `support-render.ts`, a pure render layer this module drives.
//
// -------------------------------------------------------------------------------------------------
// EXACT `$support_*` property names — DO NOT rename without updating `packages/clickhouse/
// migrations/013_support_events.sql`. `support_events_mv` reads these off `properties`:
//
//   $support_form_id        → the support form id (string, ULID). Present on every support event.
//   $support_ticket_id      → the ticket id, on ticket-scoped events only.
//   $support_category       → the ticket category.
//   $support_score          → the CSAT score, STRINGIFIED. The MV does
//                             `toInt8OrNull(JSONExtractString(properties,'$support_score'))`, and
//                             `JSONExtractString` returns '' for a non-string JSON value — a raw
//                             number would silently score as NULL (same trap `survey.ts`
//                             documents for `$survey_response`).
//
// WHO EMITS WHAT. `$support_ticket_created` is published SERVER-SIDE by capture-rs inside
// `POST /v1/support/tickets` (`publish_ticket_created`), and `$support_ticket_resolved`
// server-side by the tRPC `tickets.setStatus`. `support_events` is a plain MergeTree with
// no collapsing, so a client-side duplicate would double-count both. This client therefore OWNS
// only the genuinely client-side interactions — shown / opened / deflected / csat — and exposes
// the other two as explicit methods that nothing here auto-fires.
// -------------------------------------------------------------------------------------------------

import { type BugCapture, createBugCapture, type SupportBugReport } from './support-bug'
import {
  renderSupport,
  type SupportRenderHandle,
  type SupportSubmission,
  type SupportTicketRow,
} from './support-render'

export const SUPPORT_PROP_FORM_ID = '$support_form_id'
export const SUPPORT_PROP_TICKET_ID = '$support_ticket_id'
export const SUPPORT_PROP_TICKET_NUMBER = '$support_ticket_number'
export const SUPPORT_PROP_CATEGORY = '$support_category'
export const SUPPORT_PROP_PRIORITY = '$support_priority'
export const SUPPORT_PROP_SCORE = '$support_score'

export const EVENT_SUPPORT_SHOWN = '$support_shown'
export const EVENT_SUPPORT_OPENED = '$support_opened'
export const EVENT_SUPPORT_DEFLECTED = '$support_deflected'
export const EVENT_SUPPORT_TICKET_CREATED = '$support_ticket_created'
export const EVENT_SUPPORT_TICKET_RESOLVED = '$support_ticket_resolved'
export const EVENT_SUPPORT_CSAT = '$support_csat'

/** Prefix every `$support_*` event shares — used to skip re-entrancy in the event trigger. */
export const SUPPORT_EVENT_PREFIX = '$support_'

// ---- config data model ---------------------------------------------------
//
// Mirrors `packages/trpc-router/src/trpc/routers/support.schema.ts` EXACTLY (its zod OUTPUT
// types, i.e. post-default). Deliberately NOT imported from there: the SDK ships to customer
// pages and must stay dependency-free (no zod, no trpc-router).

/** `bot` round-trips from the builder but the SDK treats it as `contact` until the answer-bot
 *  phase lands — see the schema comment on `supportChannelSchema`. */
export type SupportChannel = 'contact' | 'bot' | 'bug'

export type SupportFieldType = 'short_text' | 'long_text' | 'dropdown' | 'email' | 'file'

interface SupportFieldBase {
  id: string
  label: string
  required: boolean
}

export interface SupportShortTextField extends SupportFieldBase {
  type: 'short_text'
  placeholder?: string
  maxLength?: number
}

export interface SupportLongTextField extends SupportFieldBase {
  type: 'long_text'
  placeholder?: string
  rows?: number
  maxLength?: number
}

export interface SupportDropdownField extends SupportFieldBase {
  type: 'dropdown'
  choices: string[]
  placeholder?: string
}

export interface SupportEmailField extends SupportFieldBase {
  type: 'email'
  placeholder?: string
}

export interface SupportFileField extends SupportFieldBase {
  type: 'file'
  maxFiles?: number
  maxSizeMb?: number
  accept?: string[]
}

export type SupportField =
  | SupportShortTextField
  | SupportLongTextField
  | SupportDropdownField
  | SupportEmailField
  | SupportFileField

export interface SupportSource {
  id: string
  type: 'url' | 'sitemap' | 'text'
  value: string
  label?: string
}

export type SupportLayout = 'launcher' | 'slide_out' | 'modal' | 'inline'
export type SupportPosition = 'bottom_right' | 'bottom_left' | 'center'

export interface SupportAppearance {
  layout: SupportLayout
  position: SupportPosition
  primaryColor?: string
  backgroundColor?: string
  textColor?: string
  launcherLabel?: string
  greeting?: string
  thanksMessage?: string
  // ── Expanded appearance ─────────────────────────────────────────────────
  // Mirrors the new optional fields on `supportAppearanceSchema` (its zod OUTPUT
  // type). Kept a hand-written mirror, not an import — the SDK stays dep-free.
  /** Built-in launcher glyph. Maps to icon geometry (message→message-square,
   *  help→help-circle, chat→message-square-more, question→help-circle). No raw SVG. */
  launcherIcon?: 'message' | 'help' | 'chat' | 'question'
  /** Launcher bubble diameter in px (40–72; glyph scales ~0.44×). Default 52. */
  launcherSize?: number
  /** Panel corner radius in px (0–24). Default 16. */
  cornerRadius?: number
  /** Launcher-layout panel width in px (300–480). Default 320. */
  panelWidth?: number
  /** Launcher-layout header variant. Default per-layout (launcher = 'accent'). */
  headerStyle?: 'accent' | 'plain'
  /** When true, omit the "Powered by Clickroom" footer. Default false. */
  hideBranding?: boolean
  /** Override the hardcoded Inter font stack. */
  fontFamily?: string
}

/** All ON by default except `sessionReplay` — Clickroom has no replay product, so the SDK never
 *  collects it regardless of what the stored definition says. */
export interface SupportTracking {
  identity: boolean
  formAnalytics: boolean
  recentEvents: boolean
  sessionReplay: boolean
  /*ttach environment / console-error / failed-request evidence to BUG tickets.
   *  Defaults **OFF** and stays off for every earlier form — the gate is an explicit
   *  `=== true`, never `!== false`, so a stored v1 definition with no key installs nothing. */
  bugContext: boolean
}

export interface SupportWebhookRef {
  webhookId: string
}

export interface SupportRouting {
  destinations: SupportWebhookRef[]
  autoReply: boolean
}

export interface SupportTriggers {
  urlMatch?: string
  selector?: string
  delayMs?: number
  events?: string[]
  showLauncher: boolean
  autoOpen: boolean
}

export interface SupportDefinition {
  version: 1
  channel: SupportChannel
  fields: SupportField[]
  sources: SupportSource[]
  appearance: SupportAppearance
  tracking: SupportTracking
  routing: SupportRouting
  triggers: SupportTriggers
}

/** One entry of `GET /v1/support`'s `{ forms: [...] }` (capture-rs `FormOut`). */
export interface SupportForm {
  id: string
  definition: SupportDefinition
  /** Config version (bumped on every edit) — drives the localStorage cache gate. */
  version: number
  /** Linked feature flag that gates eligibility. Null = always eligible. */
  linkedFlagKey: string | null
}

export interface SupportFormsResponse {
  forms: SupportForm[]
}

// ---- ticket wire shapes --------------------------------------------------

/** `POST /v1/support/tickets` response (capture-rs `create_ticket_endpoint`). */
export interface CreatedTicket {
  id: string
  number: number
  token: string
}

/** One message as `GET /v1/support/tickets/:id` returns it. Agent identity is never exposed.
 *  `ai` is the answer-bot author: capture-rs stamps it on the wire, the widget renders
 *  it like an agent reply. `system` is an automated note (status change, auto-reply). */
export interface SupportTicketMessage {
  authorType: 'user' | 'agent' | 'ai' | 'system'
  body: string
  createdAt: string
}

/** `GET /v1/support/tickets/:id` response. */
export interface SupportTicketThread {
  id: string
  number: number
  formId: string
  status: string
  priority: string
  category: string
  subject: string
  createdAt: string
  resolvedAt: string | null
  messages: SupportTicketMessage[]
}

/** A per-ticket credential kept in localStorage so a returning user reads its own thread back. */
export interface StoredTicket {
  id: string
  number: number
  token: string
  formId: string
  /** epoch ms of creation — the eviction order for the capped store. */
  createdAt: number
  /** Locally-tracked unread-for-user count driving the 1b launcher pill / 2c list badge. The
   *  server owns the authoritative counter but never exposes it on the token-scoped thread read
   *  (that read CLEARS it), so an anonymous widget maintains its own: the stream ping bumps it and
   *  a thread read (`getTicket`) zeroes it. Absent = 0. */
  unreadForUser?: number
  /** Cached list-row display state, refreshed by the periodic/visibility list refresh; the
   *  token/unread remain the load-bearing fields. */
  status?: string
  /** Cached list-row display state, refreshed by the periodic/visibility list refresh; the
   *  token/unread remain the load-bearing fields. */
  subject?: string
}

/** A row of `listForUser()` — one of the user's own tickets, enough to render the 2a list and its
 *  2c unread badge without opening each thread. For an anonymous user it is projected from the
 *  local token store; for an identified user it comes from the server list. */
export interface SupportTicketSummary {
  id: string
  number: number
  formId: string
  status?: string
  subject?: string
  /** Unread agent/ai replies the user has not read yet — drives the badge. Absent = 0. */
  unreadForUser?: number
  /** ISO string (server) or epoch ms (local store). */
  createdAt?: string | number
}

/** `POST /v1/support/attachments/presign` response. */
export interface PresignedUpload {
  url: string
  key: string
  contentType: string
  expiresIn: number
  maxBytes: number
}

/** What the caller hands `createTicket` — the widget's assembled answers. */
export interface CreateTicketInput {
  formId: string
  subject: string
  body: string
  category?: string
  priority?: string
  fields?: Record<string, unknown>
  /** Discriminator. OMITTED for a conversation — capture-rs falls back to the form's
   *  `channel`, and an unpatched (pre-) capture-rs would 400 on an unknown key. */
  type?: 'conversation' | 'bug'
  /** Bug-only. capture-rs 400s a severity on a non-bug ticket, so never send it on a conversation. */
  severity?: 'blocker' | 'major' | 'minor'
  /** Bug-only evidence bundle, gated on `tracking.bugContext === true`. */
  bugReport?: SupportBugReport
}

// ---- storage helpers (SSR-safe) -----------------------------------------

const SUPPORT_STORAGE_KEY = 'ckrm_support'
const TICKETS_STORAGE_KEY = 'ckrm_support_tickets'

/** Cap on the per-ticket token store. A widget only ever reads back the user's own recent
 *  threads; an unbounded list would grow forever in a shared browser. */
const MAX_STORED_TICKETS = 20

/** Cap on how many stored threads the anonymous list refresh re-reads per pass (newest first) —
 *  bounds the request fan-out of a single `listForUser()` on a browser with many stored tickets. */
const MAX_LIST_REFRESH = 8

/** Throttle window for the anonymous per-ticket list refresh: a burst of `refresh()` calls inside
 *  this window re-uses the already-refreshed cache instead of fanning out N thread reads each time. */
const ANON_LIST_REFRESH_MS = 20_000

/** How many captured events ride along in the context bundle when `tracking.recentEvents`. */
export const RECENT_EVENTS_LIMIT = 20

/** Poll cadence used by `subscribeTicket` ONLY when `EventSource` is unavailable — the SSE stream
 *  is the primary path. Default mirrors a live-feeling refetch; floored so a caller cannot hammer
 *  the thread read. A caller passes its clamped `support_poll_interval` to override the default. */
export const SUPPORT_STREAM_POLL_FALLBACK_MS = 10_000
export const SUPPORT_STREAM_POLL_MIN_MS = 3_000

/** Default cadence for the mounted widgets' "Your conversations" list refresh, used when the form
 *  poll is off (`pollIntervalMs <= 0`). When the form poll is on, the ticket refresh rides its
 *  cadence instead. Independent of the form-config poll — it runs even with the form poll disabled. */
export const SUPPORT_TICKET_REFRESH_MS = 60_000

const safeLocalStorage = (): Storage | null => {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

// ---- per-ticket token store ---------------------------------------------

/** Read the stored ticket credentials (newest first). Never throws. */
export function readStoredTickets(): StoredTicket[] {
  try {
    const raw = safeLocalStorage()?.getItem(TICKETS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t): t is StoredTicket =>
        !!t &&
        typeof (t as StoredTicket).id === 'string' &&
        typeof (t as StoredTicket).token === 'string',
    )
  } catch {
    return []
  }
}

const writeStoredTickets = (tickets: StoredTicket[]): void => {
  try {
    safeLocalStorage()?.setItem(TICKETS_STORAGE_KEY, JSON.stringify(tickets))
  } catch {
    // ignore quota / disabled storage
  }
}

/** Persist a ticket credential, newest first, de-duped by id and capped. Returns the new list. */
export function rememberTicket(ticket: StoredTicket): StoredTicket[] {
  const next = [ticket, ...readStoredTickets().filter((t) => t.id !== ticket.id)].slice(
    0,
    MAX_STORED_TICKETS,
  )
  writeStoredTickets(next)
  return next
}

/** The stored credential for a ticket id, or `undefined`. */
export function findStoredTicket(ticketId: string): StoredTicket | undefined {
  return readStoredTickets().find((t) => t.id === ticketId)
}

/** Drop one stored credential (e.g. the server 401s it). */
export function forgetTicket(ticketId: string): void {
  writeStoredTickets(readStoredTickets().filter((t) => t.id !== ticketId))
}

/** Set the locally-tracked `unreadForUser` on one stored ticket (clamped ≥0). No-op if unknown. */
export function setStoredTicketUnread(ticketId: string, count: number): void {
  const list = readStoredTickets()
  const idx = list.findIndex((t) => t.id === ticketId)
  if (idx < 0) return
  list[idx] = { ...list[idx], unreadForUser: Math.max(0, Math.floor(count)) }
  writeStoredTickets(list)
}

/** Merge `patch` into one stored ticket's cached display fields (status/subject/unread), keeping the
 *  token and every other field. No-op for an unknown id — we never fabricate a credential-less row.
 *  Only defined keys are written, so a partial source can't wipe a value the cache already had. */
export function patchStoredTicket(
  ticketId: string,
  patch: Partial<Pick<StoredTicket, 'status' | 'subject' | 'unreadForUser'>>,
): void {
  const list = readStoredTickets()
  const idx = list.findIndex((t) => t.id === ticketId)
  if (idx < 0) return
  const next: StoredTicket = { ...list[idx] }
  if (patch.status !== undefined) next.status = patch.status
  if (patch.subject !== undefined) next.subject = patch.subject
  if (patch.unreadForUser !== undefined) next.unreadForUser = patch.unreadForUser
  list[idx] = next
  writeStoredTickets(list)
}

/** Bump the locally-tracked `unreadForUser` on one stored ticket by `delta`. No-op if unknown. */
export function bumpStoredTicketUnread(ticketId: string, delta = 1): void {
  const current = findStoredTicket(ticketId)?.unreadForUser ?? 0
  setStoredTicketUnread(ticketId, current + delta)
}

/** Drop every stored credential — called from the SDK's `reset()` path via `client.clear()`. */
export function clearStoredTickets(): void {
  try {
    safeLocalStorage()?.removeItem(TICKETS_STORAGE_KEY)
  } catch {
    // ignore
  }
}

// ---- trigger matching (pure) --------------------------------------------

/** True when `url` satisfies the form's `urlMatch`. Absent match = any URL.
 *  The schema types `urlMatch` as a plain string (unlike surveys' object form), so the contract
 *  is substring containment. */
export function matchesUrl(form: SupportForm, url: string): boolean {
  const match = form.definition?.triggers?.urlMatch
  if (match == null || match === '') return true
  return url.includes(match)
}

/** True when the form declares this custom event as an auto-open trigger. */
export function matchesEvent(form: SupportForm, eventName: string): boolean {
  const events = form.definition?.triggers?.events
  return Array.isArray(events) && events.includes(eventName)
}

/** True when the form declares a CSS-selector trigger (the renderer wires the DOM match). */
export function hasSelectorTrigger(form: SupportForm): boolean {
  return typeof form.definition?.triggers?.selector === 'string'
}

// ---- version gate --------------------------------------------------------

// Same gate as `survey.ts`: support has no cheap `/version` endpoint, the per-form `version`
// rides inside the full `/v1/support` payload. The signature is an order-independent join over
// `{id, version}`; an unchanged signature short-circuits the cache rewrite AND keeps the
// in-memory array reference stable, which is what the poll loop uses to detect real changes.
const versionSignature = (forms: SupportForm[]): string =>
  forms
    .map((f) => `${f.id}:${f.version}`)
    .sort()
    .join('|')

interface CachedForms {
  signature: string
  forms: SupportForm[]
}

// ---- context bundle ------------------------------------------------------

/** One captured event remembered for the context bundle. */
export interface RecentEvent {
  event: string
  timestamp: string
  properties?: Record<string, unknown>
}

/** Form-fill telemetry, assembled only when `tracking.formAnalytics` is on. */
export interface SupportFormAnalytics {
  /** Field ids in the order they were first focused. */
  focusOrder: string[]
  /** Per-field count of input events (how much the user reworked each answer). */
  editCounts: Record<string, number>
  /** ms from the first interaction to submit. Null when never submitted. */
  timeToSubmitMs: number | null
  /** The last focused field when the user abandoned the form. Null when submitted. */
  droppedOffAt: string | null
}

/** The bundle POSTed as the ticket's `context`. Every section is opt-out via `tracking`.
 *  There is deliberately no `sessionReplay` key: Clickroom has no replay product,
 *  so the toggle is always off and this client never collects one. */
export interface SupportContext {
  identity?: {
    distinctId: string
    personProperties?: Record<string, unknown>
  }
  recentEvents?: RecentEvent[]
  activeFlags?: Record<string, boolean | string>
  formAnalytics?: SupportFormAnalytics
}

/** Live form-fill telemetry recorder. One per opened widget session. */
export interface FormTelemetry {
  /** Record a field gaining focus (first focus per field defines the focus order). */
  focus(fieldId: string): void
  /** Record an edit (input) on a field. */
  edit(fieldId: string): void
  /** Stamp the submit, freezing `timeToSubmitMs` and clearing `droppedOffAt`. */
  submit(): void
  /** The current snapshot. */
  snapshot(): SupportFormAnalytics
  /** Forget everything (a re-opened widget starts a fresh fill). */
  reset(): void
}

export function createFormTelemetry(now: () => number = () => Date.now()): FormTelemetry {
  let focusOrder: string[] = []
  let editCounts: Record<string, number> = {}
  let startedAt: number | null = null
  let submittedAt: number | null = null
  let lastFocused: string | null = null

  const touch = (): void => {
    if (startedAt === null) startedAt = now()
  }

  return {
    focus(fieldId) {
      touch()
      lastFocused = fieldId
      if (!focusOrder.includes(fieldId)) focusOrder.push(fieldId)
    },
    edit(fieldId) {
      touch()
      editCounts[fieldId] = (editCounts[fieldId] ?? 0) + 1
    },
    submit() {
      touch()
      submittedAt = now()
    },
    snapshot() {
      return {
        focusOrder: [...focusOrder],
        editCounts: { ...editCounts },
        timeToSubmitMs: submittedAt !== null && startedAt !== null ? submittedAt - startedAt : null,
        droppedOffAt: submittedAt === null ? lastFocused : null,
      }
    },
    reset() {
      focusOrder = []
      editCounts = {}
      startedAt = null
      submittedAt = null
      lastFocused = null
    },
  }
}

/**
 * Assemble the ticket context bundle from the form's `tracking` toggles. PURE — every input is
 * passed in, so the toggle semantics are unit-testable without a live SDK.
 *
 * A section that is toggled off is OMITTED entirely rather than emitted empty: an absent
 * `recentEvents` key means "the customer opted out", an empty array would mean "opted in, nothing
 * happened", and the inbox context rail renders those differently.
 */
export function buildSupportContext(
  tracking: Partial<SupportTracking> | undefined,
  parts: {
    distinctId: string
    personProperties?: Record<string, unknown>
    recentEvents?: RecentEvent[]
    activeFlags?: Record<string, boolean | string>
    formAnalytics?: SupportFormAnalytics
  },
): SupportContext {
  const context: SupportContext = {}
  // Defaults mirror the zod schema: everything on except sessionReplay.
  const identity = tracking?.identity !== false
  const recentEvents = tracking?.recentEvents !== false
  const formAnalytics = tracking?.formAnalytics !== false

  if (identity) {
    context.identity = {
      distinctId: parts.distinctId,
      ...(parts.personProperties && Object.keys(parts.personProperties).length > 0
        ? { personProperties: parts.personProperties }
        : {}),
    }
  }
  if (recentEvents) {
    context.recentEvents = (parts.recentEvents ?? []).slice(-RECENT_EVENTS_LIMIT)
    // Active flags are the "which flags did they have on" half of the same question and ride
    // the same toggle — they are read off the already-evaluated flag cache, no extra fetch.
    context.activeFlags = parts.activeFlags ?? {}
  }
  if (formAnalytics && parts.formAnalytics) {
    context.formAnalytics = parts.formAnalytics
  }
  // `sessionReplay` is intentionally never honoured — see the `SupportContext` doc comment.
  return context
}

// ---- capture property shaping -------------------------------------------

const baseSupportProps = (form: SupportForm): Record<string, unknown> => ({
  [SUPPORT_PROP_FORM_ID]: form.id,
})

// ---- client --------------------------------------------------------------

export interface SupportClientDeps {
  getApiHost: () => string
  getWriteKey: () => string
  /** From the SDK's flag client — a form is eligible iff its linked flag is enabled. */
  isFeatureEnabled: (key: string) => boolean
  /** Emit an event through the SDK core (`captureInternal`). */
  capture: (event: string, properties?: Record<string, unknown>) => void
  /** Current distinct id, for the context bundle + ticket ownership. */
  getDistinctId: () => string
  /** Person properties set via `identify()`, for the context bundle's identity section. */
  getPersonProperties?: () => Record<string, unknown>
  /** The flattened enabled-flag map, for the context bundle's `activeFlags`. */
  getActiveFlags?: () => Record<string, boolean | string>
  /** Whether the current user is identified (`identify()` has run). Drives `listForUser`: an
   *  anonymous user can only name tickets whose read tokens this browser kept, an identified one
   *  gets the server's cross-device list. Absent/false = anonymous. */
  isIdentified?: () => boolean
  /** Clock — injectable for tests. Defaults to `Date.now`. */
  now?: () => number
}

/** Callbacks a `subscribeTicket` consumer (the render layer) supplies. The render layer
 *  owns `agentTyping` state; `onTyping` is the surface for it. This refetch-ping SSE variant emits
 *  no typing signal, so `onTyping` never fires today — it is reserved for a NATS-backed upgrade. */
export interface SupportTicketStreamHandlers {
  /** The thread advanced (an agent/ai reply landed). Called with the freshly re-read thread. */
  onMessage?: (thread: SupportTicketThread | null) => void
  /** Agent typing indicator. Reserved — never fires in the refetch-ping variant. */
  onTyping?: (typing: boolean) => void
  /** A stream error surfaced (best-effort; `EventSource` reconnects on its own). */
  onError?: (err: unknown) => void
}

/** Handle returned by `subscribeTicket` — call `unsubscribe()` to close the stream / stop polling. */
export interface SupportTicketSubscription {
  unsubscribe(): void
}

export interface SupportClient {
  /** All fetched forms (in-memory, or restored from localStorage). */
  getForms(): SupportForm[]
  /** Fetch `/v1/support`, version-gate, cache. Never throws — falls back to the cached config. */
  fetchForms(): Promise<SupportForm[]>
  /** Whether the form's linked flag is enabled (null flag = always eligible). */
  isEligible(form: SupportForm): boolean
  /** Fetched forms whose linked flag is enabled. */
  getEligibleForms(): SupportForm[]
  /** Eligible forms mounted on this URL. */
  formsForUrl(url: string): SupportForm[]
  /** Eligible forms this custom event auto-opens. */
  formsForEvent(eventName: string): SupportForm[]
  /** Remember a captured event for the context bundle's `recentEvents` ring. */
  recordEvent(event: string, properties?: Record<string, unknown>): void
  /** The captured-event ring, oldest first. */
  getRecentEvents(): RecentEvent[]
  /** The context bundle for this form, honouring its `tracking` toggles. */
  buildContext(form: SupportForm, formAnalytics?: SupportFormAnalytics): SupportContext
  /** `POST /v1/support/tickets`. Persists the returned token. Null on any failure. */
  createTicket(input: CreateTicketInput, context?: SupportContext): Promise<CreatedTicket | null>
  /** `GET /v1/support/tickets/:id`, authorized with the stored per-ticket token. */
  getTicket(ticketId: string): Promise<SupportTicketThread | null>
  /** `POST /v1/support/tickets/:id/messages` — an end-user follow-up on their own thread. */
  appendMessage(ticketId: string, body: string): Promise<boolean>
  /** `POST /v1/support/tickets/:id/solve` — the end user marks their own thread solved. */
  markSolved(ticketId: string): Promise<boolean>
  /** `POST /v1/support/attachments/presign`, then the signed `PUT`. Null on any failure. */
  uploadAttachment(file: File, ticketId?: string): Promise<PresignedUpload | null>
  /** The user's own tickets (from the local token store), newest first. */
  getStoredTickets(): StoredTicket[]
  /** The user's own tickets for the 2a list. Anonymous → the local token store; identified → the
   *  server's cross-device list (falling back to the local store on any failure). */
  listForUser(): Promise<SupportTicketSummary[]>
  /** Summed unread-for-user across the user's tickets — drives the 1b launcher pill / 2c badge.
   *  Synchronous: reads the last `listForUser` result, else the local token store. */
  getUnreadCount(): number
  /** Subscribe to a thread's live updates. Uses the token-scoped SSE stream when `EventSource`
   *  exists, else falls back to a clamped poll. On each advance it re-reads `getTicket` and calls
   *  `onMessage`. Returns a handle whose `unsubscribe()` tears the stream / poll down. */
  subscribeTicket(
    ticketId: string,
    handlers: SupportTicketStreamHandlers,
    opts?: { pollIntervalMs?: number },
  ): SupportTicketSubscription
  /** Emit `$support_shown` — the launcher became visible. */
  captureShown(form: SupportForm): void
  /** Emit `$support_opened` — the user opened the panel. */
  captureOpened(form: SupportForm): void
  /** Emit `$support_deflected` — the panel was closed without a ticket being filed. */
  captureDeflected(form: SupportForm): void
  /** Emit `$support_ticket_created`. NOT auto-fired: capture-rs publishes it server-side on
   *  `POST /v1/support/tickets`. Exposed for a host app that files tickets through its own
   *  backend and wants the same funnel event. */
  captureTicketCreated(form: SupportForm, ticket: CreatedTicket, category?: string): void
  /** Emit `$support_ticket_resolved`. NOT auto-fired: the tRPC `tickets.setStatus` owns it. */
  captureTicketResolved(form: SupportForm, ticketId: string): void
  /** Emit `$support_csat` with the score stringified for the MV's `toInt8OrNull`. */
  captureCsat(form: SupportForm, score: number, ticketId?: string): void
  /** Whether the current user is identified — gates the 1b "Your conversations" row + open-to
   *  rules in the render layer (an anonymous user only ever names its own local tokens). */
  isIdentified(): boolean
  /** Install bug-evidence capture (console + network rings, error listeners).
   *  Idempotent, and a no-op with no DOM. `initSupport` calls it EAGERLY at init when any eligible
   *  form opts in via `tracking.bugContext` — the errors worth capturing happen long before the
   *  user thinks to file a report, so lazy install at the bug-card click would catch nothing. */
  installBugCapture(): void
  /** Snapshot the captured evidence for a bug ticket. Safe to call even if capture was never
   *  installed (it then carries the environment snapshot alone). */
  buildBugReport(): SupportBugReport
  /** Drop the in-memory + persisted config cache and the per-ticket token store, and tear the
   *  bug capture back down (restoring every function we are still the outermost patcher of). */
  clear(): void
}

export function createSupportClient(deps: SupportClientDeps): SupportClient {
  const now = deps.now ?? (() => Date.now())

  let forms: SupportForm[] = restoreCache()
  let lastSignature: string = versionSignature(forms)
  let recent: RecentEvent[] = []
  // Last `listForUser` result — the synchronous source `getUnreadCount` reads for an identified
  // user (whose unread lives on the server, not the local token store). Null until first fetched.
  let lastSummaries: SupportTicketSummary[] | null = null
  // Throttle stamp for the anonymous per-ticket list refresh (see `refreshAnonTicketState`).
  let lastAnonRefreshMs = 0
  // Bug evidence. Constructed here (cheap — it patches nothing until `install()`), so
  // `installBugCapture` / `buildBugReport` / `clear` all share one set of rings.
  const bugCapture: BugCapture = createBugCapture({ getApiHost: () => apiBase(), now })

  function restoreCache(): SupportForm[] {
    try {
      const raw = safeLocalStorage()?.getItem(SUPPORT_STORAGE_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as CachedForms
      if (parsed && Array.isArray(parsed.forms)) return parsed.forms
    } catch {
      // ignore corrupt cache
    }
    return []
  }

  const persist = (): void => {
    try {
      const payload: CachedForms = { signature: lastSignature, forms }
      safeLocalStorage()?.setItem(SUPPORT_STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // ignore quota / disabled storage
    }
  }

  const apiBase = (): string => deps.getApiHost().replace(/\/+$/, '')

  const authHeaders = (): Record<string, string> => ({
    authorization: `Bearer ${deps.getWriteKey()}`,
  })

  const parseForms = (data: unknown): SupportForm[] | null => {
    const list = (data as SupportFormsResponse | undefined)?.forms
    if (!Array.isArray(list)) return null
    // Keep only well-formed entries with a usable definition.
    return list.filter(
      (f): f is SupportForm =>
        !!f &&
        typeof f.id === 'string' &&
        typeof f.version === 'number' &&
        !!f.definition &&
        Array.isArray(f.definition.fields),
    )
  }

  const fetchForms = async (): Promise<SupportForm[]> => {
    try {
      if (typeof fetch !== 'function') return forms
      const res = await fetch(`${apiBase()}/v1/support`, {
        method: 'GET',
        headers: authHeaders(),
      })
      if (!res.ok) return forms // fall back to existing cache
      const next = parseForms(await res.json())
      if (!next) return forms
      const signature = versionSignature(next)
      // Version gate: unchanged config short-circuits — keep the parsed cache, skip the rewrite,
      // and (deliberately) return the SAME array reference so the poll loop sees "no change".
      if (signature === lastSignature && forms.length === next.length) return forms
      forms = next
      lastSignature = signature
      persist()
      return forms
    } catch {
      // Network / parse failure — keep whatever cache we have (incl. localStorage).
      return forms
    }
  }

  const isEligible = (form: SupportForm): boolean => {
    if (form.linkedFlagKey == null) return true
    return deps.isFeatureEnabled(form.linkedFlagKey)
  }

  const getEligibleForms = (): SupportForm[] => forms.filter(isEligible)

  const recordEvent = (event: string, properties?: Record<string, unknown>): void => {
    // Never remember our own telemetry — it would crowd the ring with `$support_*` noise.
    if (event.startsWith(SUPPORT_EVENT_PREFIX)) return
    recent.push({ event, timestamp: new Date(now()).toISOString(), properties })
    if (recent.length > RECENT_EVENTS_LIMIT) recent = recent.slice(-RECENT_EVENTS_LIMIT)
  }

  const buildContext = (form: SupportForm, formAnalytics?: SupportFormAnalytics): SupportContext =>
    buildSupportContext(form.definition?.tracking, {
      distinctId: deps.getDistinctId(),
      personProperties: deps.getPersonProperties?.(),
      recentEvents: recent,
      activeFlags: deps.getActiveFlags?.(),
      formAnalytics,
    })

  // ---- ticket API -------------------------------------------------------

  const postJson = async (path: string, body: unknown, extra?: Record<string, string>) => {
    if (typeof fetch !== 'function') return null
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(), ...(extra ?? {}) },
      body: JSON.stringify(body),
    })
    if (!res.ok) return null
    return (await res.json()) as unknown
  }

  const createTicket = async (
    input: CreateTicketInput,
    context?: SupportContext,
  ): Promise<CreatedTicket | null> => {
    try {
      const data = (await postJson('/v1/support/tickets', {
        formId: input.formId,
        distinctId: deps.getDistinctId(),
        subject: input.subject,
        body: input.body,
        ...(input.category ? { category: input.category } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.fields ? { fields: input.fields } : {}),
        // Keys ride the same conditional-spread idiom on purpose: `CreateTicketRequest`
        // is `#[serde(deny_unknown_fields)]`, so an unpatched capture-rs 400s on any of them.
        // Omitting them for a conversation caps the blast radius of a slipped deploy order to
        // bug submissions only (hard constraint 1).
        ...(input.type ? { type: input.type } : {}),
        ...(input.severity ? { severity: input.severity } : {}),
        ...(input.bugReport ? { bugReport: input.bugReport } : {}),
        ...(context ? { context } : {}),
      })) as CreatedTicket | null
      if (!data || typeof data.id !== 'string' || typeof data.token !== 'string') return null
      // Persist the create response's status when it carries one (the wire shape is `CreatedTicket`,
      // which does not declare it — read it optionally, never fabricate). The subject is the one the
      // caller just typed; the periodic refresh keeps both fresh from here on.
      const createdStatus = (data as { status?: unknown }).status
      rememberTicket({
        id: data.id,
        number: data.number,
        token: data.token,
        formId: input.formId,
        createdAt: now(),
        ...(typeof createdStatus === 'string' ? { status: createdStatus } : {}),
        ...(input.subject ? { subject: input.subject } : {}),
      })
      return data
    } catch {
      return null
    }
  }

  const getTicket = async (ticketId: string): Promise<SupportTicketThread | null> => {
    try {
      if (typeof fetch !== 'function') return null
      const stored = findStoredTicket(ticketId)
      if (!stored) return null
      const res = await fetch(`${apiBase()}/v1/support/tickets/${encodeURIComponent(ticketId)}`, {
        method: 'GET',
        headers: { ...authHeaders(), 'x-clickroom-ticket-token': stored.token },
      })
      // A 401 means the credential no longer authorizes this thread — drop it rather than
      // retrying a token the server has already rejected.
      if (res.status === 401) {
        forgetTicket(ticketId)
        return null
      }
      if (!res.ok) return null
      // Reading the thread clears the server's unread-for-user counter; mirror that locally so the
      // pill/badge drops the moment the user opens the thread, without a round-trip.
      setStoredTicketUnread(ticketId, 0)
      return (await res.json()) as SupportTicketThread
    } catch {
      return null
    }
  }

  const appendMessage = async (ticketId: string, body: string): Promise<boolean> => {
    try {
      const stored = findStoredTicket(ticketId)
      if (!stored) return false
      // The token travels in the BODY as well as the header: capture-rs accepts either, and the
      // body field is the one form that never trips a CORS preflight.
      const data = await postJson(
        `/v1/support/tickets/${encodeURIComponent(ticketId)}/messages`,
        { body, ticketToken: stored.token },
        { 'x-clickroom-ticket-token': stored.token },
      )
      return data != null
    } catch {
      return false
    }
  }

  const markSolved = async (ticketId: string): Promise<boolean> => {
    try {
      const stored = findStoredTicket(ticketId)
      if (!stored) return false
      // Token in the body AND the header, same dual carriage as `appendMessage` — the body field
      // is the one that never trips a CORS preflight.
      const data = await postJson(
        `/v1/support/tickets/${encodeURIComponent(ticketId)}/solve`,
        { ticketToken: stored.token },
        { 'x-clickroom-ticket-token': stored.token },
      )
      // A solved thread has nothing left to read; drop any lingering local unread.
      if (data != null) setStoredTicketUnread(ticketId, 0)
      return data != null
    } catch {
      return false
    }
  }

  // ---- the user's own tickets (2a list + 1b/2c unread) ------------------

  const summaryFromStored = (t: StoredTicket): SupportTicketSummary => ({
    id: t.id,
    number: t.number,
    formId: t.formId,
    status: t.status,
    subject: t.subject,
    unreadForUser: t.unreadForUser ?? 0,
    createdAt: t.createdAt,
  })

  const storedSummaries = (): SupportTicketSummary[] => readStoredTickets().map(summaryFromStored)

  const parseSummaries = (data: unknown): SupportTicketSummary[] | null => {
    const list = (data as { tickets?: unknown } | undefined)?.tickets
    if (!Array.isArray(list)) return null
    return list.filter(
      (t): t is SupportTicketSummary => !!t && typeof (t as SupportTicketSummary).id === 'string',
    )
  }

  // Anonymous list refresh: re-read each stored thread so its cached status/subject/unread go fresh
  // (the anonymous list has no server list endpoint — per-ticket reads are the only source). Bounded
  // to the newest `MAX_LIST_REFRESH` and throttled to `ANON_LIST_REFRESH_MS` so a burst of `refresh()`
  // calls does not fan out N thread reads each time. `getTicket` itself zeroes the read ticket's local
  // unread; here we additionally carry its status/subject back. Per-ticket failures are swallowed —
  // that ticket keeps its cached row.
  const refreshAnonTicketState = async (): Promise<void> => {
    const nowMs = now()
    if (nowMs - lastAnonRefreshMs < ANON_LIST_REFRESH_MS) return
    lastAnonRefreshMs = nowMs
    const targets = readStoredTickets().slice(0, MAX_LIST_REFRESH) // newest first
    for (const t of targets) {
      try {
        const thread = await getTicket(t.id)
        if (!thread) continue
        patchStoredTicket(t.id, { status: thread.status, subject: thread.subject })
      } catch {
        // skip this ticket, keep its cached row
      }
    }
  }

  // Identified write-back: persist the fresh server row's display state onto any ticket we hold a
  // token for, so a reload paints an up-to-date status/subject/unread before the next fetch resolves.
  // We NEVER create a stored entry for a server id we have no token for — we could not read it back.
  const writeBackServerRows = (server: SupportTicketSummary[]): void => {
    const known = new Set(readStoredTickets().map((t) => t.id))
    for (const row of server) {
      if (!known.has(row.id)) continue
      patchStoredTicket(row.id, {
        status: row.status,
        subject: row.subject,
        unreadForUser: row.unreadForUser,
      })
    }
  }

  const listForUser = async (): Promise<SupportTicketSummary[]> => {
    // Anonymous: the only tickets we can name are the ones whose read tokens this browser kept.
    if (!(deps.isIdentified?.() ?? false)) {
      // Refresh per-ticket state (throttled) so status/unread go fresh, then project the cache.
      await refreshAnonTicketState()
      const list = storedSummaries()
      lastSummaries = list
      return list
    }
    // Identified: the server owns the cross-device list, but this-browser tickets live only in the
    // local store until the server can key them to this identity — so MERGE the two (server rows win
    // on id overlap) rather than letting an empty/partial server response hide local history. Any
    // failure falls back to the local store alone.
    const asMillis = (v: string | number | undefined): number => {
      if (typeof v === 'number') return v
      const t = v ? Date.parse(v) : Number.NaN
      return Number.isNaN(t) ? 0 : t
    }
    const merge = (server: SupportTicketSummary[]): SupportTicketSummary[] => {
      const byId = new Map<string, SupportTicketSummary>()
      for (const t of storedSummaries()) byId.set(t.id, t)
      for (const t of server) byId.set(t.id, t) // server wins on overlap (fresher unread/status)
      const list = [...byId.values()].sort((a, b) => asMillis(b.createdAt) - asMillis(a.createdAt))
      lastSummaries = list
      return list
    }
    const fallback = (): SupportTicketSummary[] => merge([])
    try {
      if (typeof fetch !== 'function') return fallback()
      const res = await fetch(
        `${apiBase()}/v1/support/tickets?distinctId=${encodeURIComponent(deps.getDistinctId())}`,
        { method: 'GET', headers: authHeaders() },
      )
      if (!res.ok) return fallback()
      const parsed = parseSummaries(await res.json())
      if (!parsed) return fallback()
      // Persist the fresh rows back onto our stored tokens so the cached list-row display survives a
      // reload (localStorage stays load-bearing for anonymous auth; this just refreshes its display).
      writeBackServerRows(parsed)
      return merge(parsed)
    } catch {
      return fallback()
    }
  }

  const getUnreadCount = (): number => {
    const source = lastSummaries ?? storedSummaries()
    return source.reduce((n, t) => n + (t.unreadForUser ?? 0), 0)
  }

  // ---- realtime thread subscription (SSE, poll fallback) ----------------

  const subscribeTicket = (
    ticketId: string,
    handlers: SupportTicketStreamHandlers,
    opts?: { pollIntervalMs?: number },
  ): SupportTicketSubscription => {
    const stored = findStoredTicket(ticketId)
    // No credential = nothing to subscribe to. Hand back an inert handle.
    if (!stored) return { unsubscribe: () => {} }

    let closed = false
    const refetch = (): void => {
      // Telemetry note: a reply-seen/reopen `$support_*` signal would be emitted HERE if a
      // new interaction value existed. It does not yet, so — by default — no new event fires.
      getTicket(ticketId)
        .then((thread) => {
          if (!closed) handlers.onMessage?.(thread)
        })
        .catch((err) => {
          if (!closed) handlers.onError?.(err)
        })
    }

    // Primary path: the token-scoped SSE stream. `EventSource` cannot set headers, so both the
    // project write key and the ticket read token travel in the query (capture-rs `SupportQuery`
    // accepts `?token=` and `?ticket_token=`). `EventSource` auto-reconnects on transient drops.
    if (typeof EventSource === 'function') {
      const url =
        `${apiBase()}/v1/support/tickets/${encodeURIComponent(ticketId)}/stream` +
        `?token=${encodeURIComponent(deps.getWriteKey())}` +
        `&ticket_token=${encodeURIComponent(stored.token)}`
      try {
        const es = new EventSource(url)
        // A `message` ping = the thread advanced; re-read it (refetch-ping variant).
        es.addEventListener('message', () => refetch())
        // Reserved: this variant emits no typing events, so this never fires today.
        es.addEventListener('typing', () => handlers.onTyping?.(true))
        es.addEventListener('error', (err) => {
          if (!closed) handlers.onError?.(err)
        })
        return {
          unsubscribe: () => {
            closed = true
            es.close()
          },
        }
      } catch {
        // fall through to the poll fallback
      }
    }

    // Fallback: `EventSource` is unavailable (SSR / old runtime / errored construction). Degrade to
    // the clamped poll — the same signal, just client-driven on a timer.
    if (typeof setInterval !== 'function') return { unsubscribe: () => {} }
    const intervalMs = Math.max(
      opts?.pollIntervalMs ?? SUPPORT_STREAM_POLL_FALLBACK_MS,
      SUPPORT_STREAM_POLL_MIN_MS,
    )
    const timer = setInterval(refetch, intervalMs)
    return {
      unsubscribe: () => {
        closed = true
        clearInterval(timer)
      },
    }
  }

  const uploadAttachment = async (
    file: File,
    ticketId?: string,
  ): Promise<PresignedUpload | null> => {
    try {
      const presigned = (await postJson('/v1/support/attachments/presign', {
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        ...(ticketId ? { ticketId } : {}),
      })) as PresignedUpload | null
      if (!presigned || typeof presigned.url !== 'string') return null
      // The PUT must present EXACTLY the content-type and content-length that were signed —
      // any divergence and S3 rejects the signature.
      const put = await fetch(presigned.url, {
        method: 'PUT',
        headers: {
          'content-type': presigned.contentType,
          'content-length': String(file.size),
        },
        body: file,
      })
      if (!put.ok) return null
      return presigned
    } catch {
      return null
    }
  }

  // ---- capture ----------------------------------------------------------

  const captureShown = (form: SupportForm): void => {
    deps.capture(EVENT_SUPPORT_SHOWN, baseSupportProps(form))
  }

  const captureOpened = (form: SupportForm): void => {
    deps.capture(EVENT_SUPPORT_OPENED, baseSupportProps(form))
  }

  const captureDeflected = (form: SupportForm): void => {
    deps.capture(EVENT_SUPPORT_DEFLECTED, baseSupportProps(form))
  }

  const captureTicketCreated = (
    form: SupportForm,
    ticket: CreatedTicket,
    category?: string,
  ): void => {
    deps.capture(EVENT_SUPPORT_TICKET_CREATED, {
      ...baseSupportProps(form),
      [SUPPORT_PROP_TICKET_ID]: ticket.id,
      [SUPPORT_PROP_TICKET_NUMBER]: ticket.number,
      ...(category ? { [SUPPORT_PROP_CATEGORY]: category } : {}),
    })
  }

  const captureTicketResolved = (form: SupportForm, ticketId: string): void => {
    deps.capture(EVENT_SUPPORT_TICKET_RESOLVED, {
      ...baseSupportProps(form),
      [SUPPORT_PROP_TICKET_ID]: ticketId,
    })
  }

  const captureCsat = (form: SupportForm, score: number, ticketId?: string): void => {
    deps.capture(EVENT_SUPPORT_CSAT, {
      ...baseSupportProps(form),
      // Stringified on purpose — see the header note on `$support_score`.
      [SUPPORT_PROP_SCORE]: String(score),
      ...(ticketId ? { [SUPPORT_PROP_TICKET_ID]: ticketId } : {}),
    })
  }

  return {
    getForms: () => forms,
    fetchForms,
    isEligible,
    getEligibleForms,
    formsForUrl: (url) => getEligibleForms().filter((f) => matchesUrl(f, url)),
    formsForEvent: (eventName) => getEligibleForms().filter((f) => matchesEvent(f, eventName)),
    recordEvent,
    getRecentEvents: () => [...recent],
    buildContext,
    createTicket,
    getTicket,
    appendMessage,
    markSolved,
    uploadAttachment,
    getStoredTickets: () => readStoredTickets(),
    listForUser,
    getUnreadCount,
    subscribeTicket,
    captureShown,
    captureOpened,
    captureDeflected,
    captureTicketCreated,
    captureTicketResolved,
    captureCsat,
    isIdentified: () => deps.isIdentified?.() ?? false,
    installBugCapture: () => bugCapture.install(),
    buildBugReport: () => bugCapture.buildBugReport(),
    clear: () => {
      bugCapture.destroy()
      forms = []
      lastSignature = ''
      recent = []
      lastSummaries = null
      try {
        safeLocalStorage()?.removeItem(SUPPORT_STORAGE_KEY)
      } catch {
        // ignore
      }
      clearStoredTickets()
    },
  }
}

// ---- init hook -----------------------------------------------------------

/** Optional render layer. Given the client + the form to mount, it paints the widget. Kept out of
 *  this module so the fetch/trigger/capture layer stays DOM-free and inert when none is wired. */
export type SupportRenderer = (
  form: SupportForm,
  client: SupportClient,
) => SupportRenderHandle | undefined

/** Drives event-triggered auto-open AND the `recentEvents` ring: called with each captured
 *  event's name + `properties`. */
export type SupportEventTrigger = (eventName: string, properties?: Record<string, unknown>) => void

export interface InitSupportConfig extends SupportClientDeps {
  /** Overrides the default shadow-DOM widget renderer. Omitted = the built-in `renderSupport` is
   *  used when a DOM is present; `null` forces the inert data-only mode. */
  render?: SupportRenderer | null
  /** Auto-mount the FAB. Default `true` (today's behavior). `false` takes the SAME inert path
   *  `render: null` provides — the full client (config fetch, flag gating, ticket-token store,
   *  `recentEvents` ring, realtime sub, `$support_*` capture) is still built; only the auto-mount of
   *  the default renderer is suppressed. The host app mounts the widget itself (e.g. an inline page
   *  via `renderSupport`). Mirrors `support` mode `'manual'`. */
  autoMount?: boolean
  /** Receives the event-trigger evaluator so the SDK core can forward captured events. */
  registerEventTrigger?: (trigger: SupportEventTrigger) => void
  /** Background re-fetch interval in ms. `>0` enables the poll loop. Floored by the SDK core. */
  pollIntervalMs?: number
  /** Receives a `stop()` that halts the background poll loop. */
  registerPollControl?: (stop: () => void) => void
  /** Receives an accessor for the handles this `initSupport` auto-mounted (one per eligible form,
   *  in mount order). Without it the auto-mounted FAB is unreachable from outside this module,
   *  so `clickroom.support.open()/.close()` could only ever drive an explicit `mount()`. */
  registerMountedHandles?: (getHandles: () => SupportRenderHandle[]) => void
}

/**
 * Swap each `file` field's picked `File`s for the S3 storage keys the presign upload returns.
 *
 * This has to happen BEFORE `createTicket`: capture-rs's `validate_answers` accepts a `file`
 * answer only as an attachment key (or a list of keys), never a filename — which is also why the
 * presign endpoint defaults its `{ticket}` key segment to `unassigned`, the widget uploads while
 * the ticket does not exist yet. A failed upload drops that file rather than failing the ticket.
 */
async function uploadSubmissionFiles(
  client: SupportClient,
  submission: SupportSubmission,
): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = { ...submission.fields }
  for (const [fieldId, picked] of Object.entries(submission.files ?? {})) {
    if (!Array.isArray(picked) || picked.length === 0) {
      delete fields[fieldId]
      continue
    }
    const uploaded = await Promise.all(picked.map((file) => client.uploadAttachment(file)))
    const keys = uploaded.filter((u): u is PresignedUpload => u != null).map((u) => u.key)
    if (keys.length > 0) fields[fieldId] = keys
    else delete fields[fieldId]
  }
  return fields
}

/**
 * The default render layer: mount the shadow-DOM widget for an eligible form and wire its
 * callbacks back through the client (capture + ticket API + form telemetry). Kept here — not in
 * `support-render.ts` — so the pure renderer stays free of the config client.
 */
/** Host-supplied mount options for a manual (non-auto) mount — the seam `react.ts` / the vanilla
 *  `support.mount()` pass to place the widget as an inline page (frames 3a/3b) instead of the FAB.
 *  Omitted entirely for the default auto-mount (today's launcher behavior is byte-identical). */
export interface SupportMountOptions {
  /** Where to mount. Omitted → the default FAB path appends the shadow host to `document.body`. */
  container?: HTMLElement
  /** Appearance overrides — inline passes `{ layout: 'inline' }`. */
  appearance?: Partial<SupportAppearance>
  /** Initial inline surface: the frame 4a home / search / bot pages, the ticket list, the
   *  new-conversation form, or a specific thread. */
  view?: 'home' | 'search' | 'bot' | 'new' | 'tickets' | 'thread'
  /** Inline home posture (frame 4a): `'search'` (default) vs `'conversations'`. Falls back to
   *  conversations automatically when the form has no docs source. */
  home?: 'search' | 'conversations'
  /** Deep-link a thread by id (pairs with a `/support/:ticketId` route). */
  ticketId?: string
  /** Fires when the user opens a thread (host can sync its own URL). */
  onTicketOpen?: (ticket: { id: string; number?: number }) => void
  /** Fires after a ticket is filed. */
  onTicketCreated?: (ticket: CreatedTicket) => void
}

export const defaultSupportRenderer = (
  form: SupportForm,
  client: SupportClient,
  mount?: SupportMountOptions,
): SupportRenderHandle | undefined => {
  if (typeof document === 'undefined') return
  const telemetry = createFormTelemetry()
  let ticketFiled = false
  // Map the host's `view` onto the pure renderer's `initialView` / `initialStep`. `'new'` is the
  // compose form (the renderer's `ticket` step); `home` / `search` / `bot` (frame 4a) and
  // `tickets` / `thread` map straight through as top-level views.
  const initialView = mount?.view === 'new' ? undefined : mount?.view
  const initialStep = mount?.view === 'new' ? ('ticket' as const) : undefined

  // Seed the conversation surfaces synchronously from what the client can answer without
  // a round-trip (the local token store), so the open-to rules can decide at mount;
  // `onLoadTickets`/`onLoadThread` refresh from the server. The render layer stays PURE — every
  // fetch/subscribe below is a client method it merely calls back into.
  const summaryToRow = (t: SupportTicketSummary): SupportTicketRow => ({ ...t })
  const seededTickets: SupportTicketRow[] = client.getStoredTickets().map((t) => ({
    id: t.id,
    number: t.number,
    formId: t.formId,
    createdAt: t.createdAt,
    unreadForUser: t.unreadForUser,
    status: t.status,
    subject: t.subject,
  }))

  return renderSupport(form.definition, {
    ...(mount?.container ? { container: mount.container } : {}),
    ...(mount?.appearance ? { appearance: mount.appearance } : {}),
    ...(initialView ? { initialView } : {}),
    ...(initialStep ? { initialStep } : {}),
    ...(mount?.home ? { home: mount.home } : {}),
    ...(mount?.ticketId ? { initialThreadId: mount.ticketId } : {}),
    onTicketOpen: mount?.onTicketOpen,
    identified: client.isIdentified(),
    tickets: seededTickets,
    unreadCount: client.getUnreadCount(),
    onLoadTickets: async () => (await client.listForUser()).map(summaryToRow),
    onLoadThread: (ticketId) => client.getTicket(ticketId),
    onAppendMessage: (ticketId, msg) => client.appendMessage(ticketId, msg),
    onMarkSolved: (ticketId) => client.markSolved(ticketId),
    onSubscribe: (ticketId, handlers, subOpts) =>
      client.subscribeTicket(ticketId, handlers, subOpts),
    onShown: () => client.captureShown(form),
    onOpen: () => {
      ticketFiled = false
      telemetry.reset()
      client.captureOpened(form)
    },
    // (`composeType` — the bug/conversation discriminator — is reset inside the render closure on
    // the same open/close boundary this callback rides.)
    onClose: () => {
      // Deflection = the panel was opened and closed without a ticket being filed. Until the
      // answer bot lands that is the only deflection signal available (the bot is deferred).
      if (!ticketFiled) client.captureDeflected(form)
    },
    onFieldFocus: (fieldId) => telemetry.focus(fieldId),
    onFieldEdit: (fieldId) => telemetry.edit(fieldId),
    onSubmit: async (submission: SupportSubmission) => {
      telemetry.submit()
      // Only a BUG carries keys onto the wire. A conversation sends exactly the
      // pre-0.9.0 payload (hard constraint 1), and capture-rs falls back to the form's `channel`.
      const isBug = submission.type === 'bug'
      // `bugContext` defaults OFF: the gate is an explicit `=== true`, never `!== false`.
      const wantsBugReport = isBug && form.definition?.tracking?.bugContext === true
      const bugReport = wantsBugReport ? client.buildBugReport() : undefined
      const created = await client.createTicket(
        {
          formId: form.id,
          subject: submission.subject,
          body: submission.body,
          category: submission.category,
          ...(isBug ? { type: 'bug' as const } : {}),
          ...(isBug && submission.severity ? { severity: submission.severity } : {}),
          ...(bugReport ? { bugReport } : {}),
          fields: await uploadSubmissionFiles(client, submission),
        },
        client.buildContext(form, telemetry.snapshot()),
      )
      // `$support_ticket_created` is NOT emitted here — capture-rs publishes it inside the
      // create endpoint, and `support_events` does not collapse duplicates.
      if (created) {
        ticketFiled = true
        if (mount?.onTicketCreated) {
          try {
            mount.onTicketCreated(created)
          } catch {
            // never throw from a host callback
          }
        }
      }
      return created
    },
    onCsat: (score) => client.captureCsat(form, score),
  })
}

/**
 * Build the support client, warm the config cache, and — when a renderer is available — mount the
 * widget for every eligible form on this URL (respecting `triggers.delayMs` /
 * `triggers.showLauncher`). Wired from `index.ts` behind the `support` config option, mirroring
 * `initSurveys`. Pass `render: null` for the inert data-only mode. Never throws.
 */
export function initSupport(config: InitSupportConfig): SupportClient {
  const client = createSupportClient(config)
  // `autoMount: false` collapses onto the exact `render: null` inert path — the client is fully
  // built (fetch / flags / token store / recentEvents / realtime / `$support_*` capture all run),
  // but the default renderer is never auto-mounted. Only THIS one call site is gated on autoMount.
  const render =
    config.render === null || config.autoMount === false
      ? undefined
      : (config.render ?? (typeof document !== 'undefined' ? defaultSupportRenderer : undefined))

  // A form mounts at most ONE widget per page: the launcher is a persistent affordance, not a
  // re-showable popover, so there is no frequency policy — only a mounted/not-mounted lock.
  const mounted = new Map<string, SupportRenderHandle | null>()

  // Read live (not a snapshot): forms mount asynchronously behind the config fetch and
  // `triggers.delayMs`, so `clickroom.support.open()` must see whatever is mounted when it runs.
  config.registerMountedHandles?.(() =>
    [...mounted.values()].filter((h): h is SupportRenderHandle => h != null),
  )

  const show = (form: SupportForm): void => {
    if (!render || mounted.has(form.id)) return
    if (!client.isEligible(form)) return
    mounted.set(form.id, null)
    try {
      mounted.set(form.id, render(form, client) ?? null)
    } catch {
      // render is best-effort; never break the SDK — release the lock so a retry can re-mount.
      mounted.delete(form.id)
      return
    }
    // Initial ticket-list refresh on mount (covers page load / force refresh) so the seeded
    // localStorage rows don't paint stale status/unread. Best-effort — never break the mount.
    try {
      mounted.get(form.id)?.refresh()
    } catch {
      // never break the SDK
    }
  }

  // Install the bug-evidence capture as soon as ANY eligible form opts in. Eager, not
  // lazy at the bug-card click — the console errors and failed requests worth reporting happen
  // before the user decides to report anything. `install()` is idempotent and a no-op with no DOM,
  // and this runs only for opted-in forms (`bugContext` defaults false), so a form that never
  // opts in patches nothing.
  const maybeInstallBugCapture = (): void => {
    try {
      const optedIn = client
        .getEligibleForms()
        .some((f) => f.definition?.tracking?.bugContext === true)
      if (optedIn) client.installBugCapture()
    } catch {
      // never break the SDK
    }
  }

  const evaluateUrl = (): void => {
    if (!render) return
    try {
      const url = typeof location !== 'undefined' ? location.href : ''
      for (const form of client.formsForUrl(url)) {
        const delay = Number(form.definition?.triggers?.delayMs ?? 0)
        if (delay > 0) setTimeout(() => show(form), delay)
        else show(form)
      }
    } catch {
      // never break the SDK
    }
  }

  // Every captured event feeds the `recentEvents` ring (that is the whole point of the context
  // bundle) and, additionally, may auto-mount an event-triggered form.
  const evaluateEvent: SupportEventTrigger = (eventName, properties) => {
    try {
      client.recordEvent(eventName, properties)
      if (!render) return
      for (const form of client.formsForEvent(eventName)) {
        const delay = Number(form.definition?.triggers?.delayMs ?? 0)
        if (delay > 0) setTimeout(() => show(form), delay)
        else show(form)
      }
    } catch {
      // never break the SDK
    }
  }
  config.registerEventTrigger?.(evaluateEvent)

  // ---- background poll (same two divergences from PostHog `survey.ts` documents) -------------
  const pollIntervalMs = Number(config.pollIntervalMs ?? 0)

  const refresh = (): void => {
    const before = client.getForms()
    client
      .fetchForms()
      .then((after) => {
        // Reference inequality = the version gate actually saw a change.
        if (after !== before) {
          // A customer toggling `bugContext` on bumps `SupportForm.version`, so the poll picks it
          // up without a reload.
          maybeInstallBugCapture()
          evaluateUrl()
        }
      })
      .catch(() => {
        // fetchForms already swallows errors; belt-and-suspenders.
      })
  }

  const startPolling = (): (() => void) => {
    if (pollIntervalMs <= 0) return () => {}
    if (typeof document === 'undefined' || typeof setInterval !== 'function') return () => {}

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

    try {
      document.addEventListener('visibilitychange', onVisibility)
    } catch {
      // visibility handling is best-effort
    }

    if (!document.hidden) startTimer()

    return function stop(): void {
      stopped = true
      clearTimer()
      try {
        document.removeEventListener('visibilitychange', onVisibility)
      } catch {
        // ignore
      }
    }
  }

  // ---- ticket-list refresh (independent of the form poll) ------------------------------------
  // Refreshes every mounted widget's "Your conversations" list so cached status/unread don't rot.
  // Runs even when the form poll is off (`pollIntervalMs <= 0`) — it rides the form poll's cadence
  // when that is on, else the standalone `SUPPORT_TICKET_REFRESH_MS`.
  const ticketRefreshMs = pollIntervalMs > 0 ? pollIntervalMs : SUPPORT_TICKET_REFRESH_MS

  const refreshTickets = (): void => {
    try {
      for (const handle of mounted.values()) handle?.refresh()
    } catch {
      // never break the SDK
    }
  }

  const startTicketRefresh = (): (() => void) => {
    if (typeof document === 'undefined' || typeof setInterval !== 'function') return () => {}

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
      intervalId = setInterval(refreshTickets, ticketRefreshMs)
    }

    const onVisibility = (): void => {
      try {
        if (document.hidden) {
          clearTimer()
        } else if (!stopped) {
          refreshTickets()
          startTimer()
        }
      } catch {
        // never break the SDK
      }
    }

    try {
      document.addEventListener('visibilitychange', onVisibility)
    } catch {
      // visibility handling is best-effort
    }

    if (!document.hidden) startTimer()

    return function stop(): void {
      stopped = true
      clearTimer()
      try {
        document.removeEventListener('visibilitychange', onVisibility)
      } catch {
        // ignore
      }
    }
  }

  // Start both background loops and expose a single teardown that stops both (spec: the poll's
  // stop path also clears the ticket interval + its listener).
  const startBackground = (): void => {
    const stopPoll = startPolling()
    const stopTicketRefresh = startTicketRefresh()
    config.registerPollControl?.(() => {
      stopPoll()
      stopTicketRefresh()
    })
  }

  client
    .fetchForms()
    .then(() => {
      maybeInstallBugCapture()
      evaluateUrl()
      startBackground()
    })
    .catch(() => {
      // fetchForms already swallows errors; belt-and-suspenders.
      startBackground()
    })
  return client
}
