// @clickroom/sdk-js — shadow-DOM-isolated support widget RENDER layer.
//
// This is the PURE render layer, forked from `survey-render.ts` and held to the same contract:
// it takes a `SupportDefinition` + callbacks and paints a shadow-DOM-isolated widget with ZERO
// dependency on the fetch/trigger/capture layer (`support.ts`'s `SupportClient`). Only TYPES are
// imported from `support.ts`, and those erase at compile time, so there is no runtime coupling —
// `renderSupport` can be imported and mounted by the web builder's preview pane WITHOUT
// a live SDK, a config fetch, or a single `$support_*` event.
//
// EVERY px / hex / radius / shadow / weight / literal string below is transcribed from the design
// bundle (`Clickroom Support.dc.html`, frames 1b–1e), not from prose. Frame → code map:
//
//   1b "Launcher bubble + panel" → `layout: 'launcher'`: 52px round launcher (accent, shadow
//      `0 10px 30px rgba(79,70,229,.5)`) + a 320px / r16 panel with an indigo header, a search
//      row, three action rows and the "Powered by Clickroom" footer.
//   1c "Slide-out side panel"    → `layout: 'slide_out'`: 300px right-anchored panel over a
//      `rgba(15,23,42,.28)` scrim, plain header, scrollable body, sticky footer submit.
//   1d "Centered modal"          → `layout: 'modal'`: card at `width:100%` inside a 22px scrim
//      gutter (396px at the design's 440px viewport — NOT the README's fixed "400px"), over a
//      `rgba(15,23,42,.4)` scrim; search + "Popular articles" chevron rows + "Contact support".
//   1e "Form flow"               → the four steps below, in order. Per the design only step 1
//      carries the indigo header bar; steps 2–4 are header-less single white bodies. That is
//      honoured verbatim for `layout: 'launcher'`; `slide_out`/`modal` keep their own 1c/1d
//      header on every step because it holds their only pointer-driven close affordance (the
//      launcher layout keeps its 52px bubble visible underneath, which is that affordance).
//
// Flow (frame 1e), 4 states: ask → answer → ticket → confirmed. The `answer` step is the answer
// bot's, which is DEFERRED: its 1e-2 layout is rendered pixel-faithfully so the
// builder preview can show what is coming, but it is inert — no retrieval, the sample answer is
// static, "Solved 👍" is disabled, and the step is never reachable from `ask` (the "Ask the AI
// assistant" action row is disabled and badged "Coming soon"; `channel: 'bot'` behaves exactly
// like `contact`).
//
// No external UI deps — hand-rolled DOM + inline SVG (lucide geometry). Every style is injected
// inside the shadow root so host-page CSS can neither leak in nor leak out. Light theme,
// brandable via the `primaryColor` / `backgroundColor` / `textColor` appearance fields.

import type {
  SupportAppearance,
  SupportDefinition,
  SupportField,
  SupportLayout,
  SupportPosition,
  SupportTicketMessage,
  SupportTicketStreamHandlers,
  SupportTicketSubscription,
  SupportTicketSummary,
  SupportTicketThread,
} from './support'

// ---- appearance ----------------------------------------------------------

/** Every appearance key with a concrete value — `definition.appearance` overrides these, and the
 *  `appearance` option overrides that. `greeting` defaults to EMPTY so each layout can fall back
 *  to its own design title (1b "Help & Contact" vs 1d "How can we help?"); any non-empty value
 *  wins for every layout. */
const DEFAULT_APPEARANCE: Required<SupportAppearance> = {
  layout: 'launcher',
  position: 'bottom_right',
  primaryColor: '#4F46E5',
  backgroundColor: '#ffffff',
  textColor: '#0f172a',
  launcherLabel: 'Help',
  greeting: '',
  thanksMessage: "Thanks! We've got your message and will get back to you shortly.",
  // Expanded appearance defaults — each reproduces the design's hardcoded value so an
  // un-customised widget is byte-identical to before. `headerStyle: 'accent'` preserves the
  // launcher's indigo header; `fontFamily: ''` (like `greeting`) falls back to the Inter stack.
  launcherIcon: 'message',
  launcherSize: 52, // the 1b FAB diameter
  cornerRadius: 16, // the 1b panel r16
  panelWidth: 320, // the 1b launcher-panel width
  headerStyle: 'accent',
  hideBranding: false,
  fontFamily: '',
}

/** The design's hardcoded Inter font stack — the fallback seeded into `--ckrm-font` and the
 *  `var(--ckrm-font, …)` fallback, used whenever `appearance.fontFamily` is empty. */
const INTER_STACK =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

// ---- literal design copy (frames 1b–1e) ----------------------------------

const COPY = {
  // 1b
  launcherTitle: 'Help & Contact',
  launcherSubtitle: 'Ask a question or send us a message',
  searchPlaceholder: 'Search help articles…',
  actionBot: 'Ask the AI assistant',
  actionMessage: 'Send a message',
  actionBug: 'Report a bug',
  poweredBy: 'Powered by ',
  poweredByBrand: 'Clickroom',
  // 1c
  contactTitle: 'Contact support',
  categoryLabel: 'Category',
  subjectLabel: 'Subject',
  messageLabel: 'Message',
  subjectPlaceholder: 'Export fails on large reports',
  messagePlaceholder: 'Describe your issue…',
  attach: 'Attach a screenshot',
  notice: 'Your account, plan and last 20 actions are attached automatically.',
  submit: 'Submit ticket',
  // 1d
  modalTitle: 'How can we help?',
  modalSubtitle: 'Search our docs or reach the team',
  modalSearchPlaceholder: 'Search…',
  popularArticles: 'Popular articles',
  /** Placeholder rows for when the form declares no sources — the help-centre index is deferred
   *  alongside the bot, so these are inert either way. */
  sampleArticles: ['Setting up SSO', 'Exporting your data', 'Billing & invoices'],
  /** Frame 4a's own fallback rows: the design's literal titles AND read-times (`articles` in the
   *  design data block). Kept separate from `sampleArticles` — 1d/1e draw bare titles, the 4a home
   *  surface draws a title + meta pair, and the read-time is design data, never derived. */
  sampleArticleRows: [
    { title: 'Exporting your data', meta: '3 min read' },
    { title: 'Setting up SSO with Okta', meta: '5 min read' },
    { title: 'Billing & invoices', meta: '2 min read' },
    { title: 'Inviting teammates and setting roles', meta: '4 min read' },
  ],
  // 1e
  suggested: 'Suggested',
  enter: '↵',
  answerTitle: 'Instant answer',
  answerLead: 'Open the report, click ',
  answerBold: 'Export',
  answerTail:
    ' top-right, then choose CSV or PDF. Large reports export in the background and email you a link.',
  citedPrefix: 'From ',
  citedArticle: 'Exporting your data',
  solved: 'Solved 👍',
  stillNeedHelp: 'Still need help',
  escalateTitle: 'Send us a message',
  confirmedTitleWith: (n: number) => `Ticket #${n} created`,
  confirmedTitle: 'Ticket created',
  firstReply: 'Typical first reply: under 2 hours',
  comingSoon: 'Coming soon',
  // 1b-revised — "Your conversations" home row
  yourConversations: 'Your conversations',
  // 4a — inline search-first home surface
  homeTitle: 'How can we help?',
  homeSubtitle: 'Search our docs, ask the assistant, or reach the team',
  homeSearchPlaceholder: 'Search for help…',
  // Channel-card descriptions — the design's `channels[].desc` verbatim (typographic apostrophe +
  // em dash included). The design hardcodes the tenant brand ("Instant answers from Acme’s docs");
  // the SDK carries no brand name (`appearance.greeting` is a title and `opts.agentName` is a
  // person), so card 1 ships the neutral phrasing until a brand field exists.
  cardBotDesc: 'Instant answers from our docs, with sources',
  cardMessageDesc: 'Reach the team — typical reply under 2 hours',
  cardBugDesc: 'We attach your session and recent actions',
  browseAll: 'Browse all →',
  viewAll: 'View all →',
  botTitle: 'Ask the AI assistant',
  citedSources: 'Cited sources',
  noMatchingArticles: 'No matching articles',
  // 2a — My tickets
  ticketsTitle: 'Your conversations',
  ticketsSubtitle: "Everything you've sent us",
  newConversation: 'New conversation',
  // 2b — Conversation (thread)
  today: 'Today',
  composerPlaceholder: 'Write a reply…',
  markSolvedLabel: 'Mark as solved',
  aiAuthor: 'AI assistant',
  aiRole: 'Automatic',
  agentRole: 'Support',
  agentFallbackName: 'Support',
  presenceFallback: 'Our team · usually replies within a few hours',
  ticketStateOpen: 'Open',
  ticketStateSolved: 'Solved',
  ticketNoWith: (n: number) => `Ticket #${n}`,
  // 2c — reply toast
  toastCta: 'View conversation →',
  repliedSuffix: ' replied',
} as const

// ---- status + category maps (hardcoded literals — none are apps/web tokens) ----------

/** End-user status wording + chip colors (2a rows / 2b footer). Keyed by the derived label, not
 *  the internal state name — capture's internal statuses collapse to these three. */
const STATUS_CHIP = {
  'Agent replied': { color: '#4F46E5', bg: '#eef0ff' },
  'Waiting on us': { color: '#B45309', bg: '#fef4e6' },
  Solved: { color: '#15803D', bg: '#e7f8ee' },
} as const

type StatusLabel = keyof typeof STATUS_CHIP

/** The "Bug" chip on a 2a / 4a thread row. Same pill as `STATUS_CHIP` (it sits next to
 *  one), tinted with `CATEGORY_STYLE.Bug`'s red so the row reads consistently with its category
 *  square. A conversation row renders nothing extra. */
const BUG_CHIP = { color: '#B91C1C', bg: 'rgba(239,68,68,.1)' } as const

/** Build the "Bug" pill for a row, or `null` when the row is not a bug. `chipClass` is the
 *  surface's own status-chip class, so the pill inherits its size/radius/weight for free; the
 *  extra `ckrm-bug-chip` marker exists purely so tests/hosts can target it. */
const bugChipFor = (row: SupportTicketRow, chipClass: string): HTMLElement | null => {
  if (row.type !== 'bug') return null
  const chip = el('span', `${chipClass} ckrm-bug-chip`, 'Bug')
  chip.style.color = BUG_CHIP.color
  chip.style.background = BUG_CHIP.bg
  return chip
}

/** Map a ticket's internal status + unread count to the end-user chip. Solved beats everything;
 *  otherwise an unread agent/ai reply reads as "Agent replied", else "Waiting on us". */
const statusLabelFor = (status?: string, unread = 0): StatusLabel => {
  if (status && /solv|resolv|clos/i.test(status)) return 'Solved'
  if (unread > 0) return 'Agent replied'
  return 'Waiting on us'
}

const isSolvedStatus = (status?: string): boolean => !!status && /solv|resolv|clos/i.test(status)

/** 28px category square: lucide icon + stroke + 10%-tint bg. Unknown → Question. */
const CATEGORY_STYLE: Record<string, { icon: string; stroke: string; tint: string }> = {
  Bug: { icon: 'bug-simple', stroke: '#EF4444', tint: 'rgba(239,68,68,.1)' },
  Billing: { icon: 'credit-card', stroke: '#F59E0B', tint: 'rgba(245,158,11,.1)' },
  Question: { icon: 'help-circle', stroke: '#60A5FA', tint: 'rgba(96,165,250,.1)' },
}

const categoryStyle = (category?: string) =>
  CATEGORY_STYLE[category ?? ''] ?? CATEGORY_STYLE.Question

// ---- flow ----------------------------------------------------------------

/** The four states of the widget flow (design frame 1e), in order. */
export type SupportStep = 'ask' | 'answer' | 'ticket' | 'confirmed'

/** Frame 1e's step order, exported so the builder preview (and the tests) can iterate the flow
 *  without hard-coding it. `answer` is deferred but keeps its slot. NOTE: `tickets`/`thread` (the
 *  conversation surfaces, frames 2a/2b) are NOT part of this linear form flow — they are
 *  navigated to laterally from the 1b home row / open-to rules — so they stay out of this array. */
export const SUPPORT_STEPS: readonly SupportStep[] = ['ask', 'answer', 'ticket', 'confirmed']

/** The full top-level view union: the four form-flow steps PLUS the two conversation
 *  surfaces — `tickets` (2a "Your conversations" list) and `thread` (2b threaded chat) — PLUS the
 *  three inline (page) home surfaces from frame 4a: `home` (search-first landing), `search` (home
 *  with the search input focused) and `bot` (page-native Ask-AI). The `home`/`search`/`bot` trio is
 *  reachable ONLY when `layout: 'inline'`; the FAB layouts never route to them. */
export type SupportView = SupportStep | 'tickets' | 'thread' | 'home' | 'search' | 'bot'

/** A 2a list row. Extends the data-layer `SupportTicketSummary` with the purely-presentational
 *  fields the design shows that the summary does not carry (category tint, author-prefixed snippet,
 *  a pre-formatted relative time). The pure render layer never derives these from a network call —
 *  the caller (`support.ts` / the builder preview) fills whatever it has; each degrades gracefully. */
export interface SupportTicketRow extends SupportTicketSummary {
  /** Drives the 28px tinted category square (Bug / Billing / Question). */
  category?: string
  /** Ticket discriminator, straight off the capture-rs list row's `type` key. `'bug'`
   *  adds a "Bug" chip beside the status chip; anything else renders exactly as today. */
  type?: string
  /** Author-prefixed snippet, e.g. "Maya: Found it…" / "You: I see two charges…". */
  snippet?: string
  /** Pre-formatted relative time ("2m", "1d", "2w"); falls back to one derived from `createdAt`. */
  timeLabel?: string
}

/** What `onSubmit` receives. `fields` carries the declared custom-field answers keyed by field id;
 *  `files` carries the raw `File`s picked for each `file` field, which the CALLER uploads (via
 *  `SupportClient.uploadAttachment`) and swaps for storage keys before POSTing — capture-rs
 *  validates a `file` answer as an attachment key, never a filename. */
export interface SupportSubmission {
  subject: string
  body: string
  /** Convenience: the answer to a field whose id is `category`, when the form declares one. */
  category?: string
  /** Ticket discriminator — which compose entry point the user came through. `'bug'` for
   *  the 1b bug action row and the 4a bug home card, `'conversation'` for everything else. The
   *  legacy `answers.category = 'Bug'` convention is KEPT (category taxonomies, chip colours and
   *  `buildSupportVolumeByCategory` all still key off it); it is simply no longer the
   *  discriminator. */
  type?: 'conversation' | 'bug'
  /** Derived from a `category` answer of Blocker/Major/Minor — the `bug` starter template encodes
   *  its Severity dropdown as a field with `id: 'category'`, so existing bug forms get a real
   *  severity with no author action. */
  severity?: 'blocker' | 'major' | 'minor'
  fields: Record<string, unknown>
  files: Record<string, File[]>
}

/** What `onSubmit` may resolve with. A `null`/thrown result renders the error state and keeps the
 *  user's input so they can retry; anything else advances to `confirmed`. */
export type SupportSubmitResult = { id?: string; number?: number } | null | undefined

export interface RenderSupportOptions {
  /** Called with the assembled ticket payload. May be async; the submit button spins meanwhile. */
  onSubmit: (submission: SupportSubmission) => Promise<SupportSubmitResult> | SupportSubmitResult
  /** Called once when the widget has mounted (the live SDK emits `$support_shown`). */
  onShown?: () => void
  /** Called each time the panel opens (`$support_opened`). */
  onOpen?: () => void
  /** Called each time the panel closes (the live SDK decides whether that is a deflection). */
  onClose?: () => void
  /** Called the first time each field is focused — feeds the form-fill telemetry focus order. */
  onFieldFocus?: (fieldId: string) => void
  /** Called on every input event on a field — feeds the telemetry edit counts. */
  onFieldEdit?: (fieldId: string) => void
  /** Called with the 1–5 CSAT score picked on the confirmed step (`$support_csat`). */
  onCsat?: (score: number) => void
  /** Appearance overrides (falls back to `definition.appearance`, then the defaults above). */
  appearance?: Partial<SupportAppearance>
  /** Where to mount. Default `document.body`. The preview pane passes its own element. */
  container?: HTMLElement | ShadowRoot
  /** Move focus into the panel on open and trap Tab/ESC. Default `true` (correct for the live
   *  widget). The builder's live preview passes `false` so re-mounting on every keystroke does
   *  not steal focus from the editor inputs. */
  autoFocus?: boolean
  /** Open on the given step instead of the launcher. The builder preview uses this to show one
   *  state at a time; the live SDK uses `triggers.autoOpen` instead. */
  initialStep?: SupportStep
  /** Open directly on a top-level view (frames 2a/2b). Superset of `initialStep`; the builder
   *  preview passes `'tickets'` / `'thread'` to show a single conversation surface. Inline mode
   *  additionally accepts `'home'` / `'search'` / `'bot'` (frame 4a). */
  initialView?: SupportView
  /** Inline home posture (frame 4a). `'search'` (default) leads with the search hero; when the form
   *  has no docs source connected the hero is dropped automatically and the channel cards +
   *  conversations are promoted to the top. `'conversations'` forces that conversations-first
   *  posture even when sources exist. Ignored outside `layout: 'inline'`. */
  home?: 'search' | 'conversations'

  // ---- conversation surfaces (frames 2a/2b/2c + 1b-revised row) -------------------
  // All optional and all PURE-render inputs: this layer never fetches. `support.ts` fetches via
  // `SupportClient` and threads the results + client methods through here.

  /** Whether the current user is identified. Gates only the open-to auto-jump-to-thread on mount
   *  (which keys off server-side unread). The 1b "Your conversations" row and the background
   *  realtime sub now work for anonymous users too, off this-browser localStorage tickets + their
   *  per-ticket read tokens. */
  identified?: boolean
  /** The user's own tickets — seeds the 2a list, the 1b row's presence + unread pill, and the
   *  launcher badge synchronously at mount (so open-to rules can decide without awaiting a fetch). */
  tickets?: SupportTicketRow[]
  /** A thread to seed the 2b view with (builder preview path — no `onLoadThread` needed). */
  initialThread?: SupportTicketThread | null
  /** Deep-link the surface to a specific thread by id (pairs with a `/support/:ticketId` route in
   *  inline mode). Used with `initialView: 'thread'` when the full thread object isn't in hand. */
  initialThreadId?: string
  /** Fires when the user opens a thread, so the host can sync its own URL (inline deep-linking). */
  onTicketOpen?: (ticket: { id: string; number?: number }) => void
  /** Override the summed unread count when no `tickets` are provided (drives the pill/badge). */
  unreadCount?: number
  /** Presence line shown under the 2b subject (assignee + median first-reply time). */
  presenceLabel?: string
  /** Display name for human-agent bubbles (identity is never on the wire; caller may pass one). */
  agentName?: string
  /** The site's page background at runtime — the 2c launcher badge's 2px ring color. Design mock
   *  uses `#eef0f4`; the live SDK passes the real site bg so the ring reads against any page. */
  pageBackground?: string
  /** Reload the 2a list (called when the list opens and after a reply lands). */
  onLoadTickets?: () => Promise<SupportTicketRow[]> | SupportTicketRow[]
  /** Load a full thread for 2b (`SupportClient.getTicket`). */
  onLoadThread?: (
    ticketId: string,
  ) => Promise<SupportTicketThread | null> | SupportTicketThread | null
  /** Append an end-user reply on the active thread (`SupportClient.appendMessage`). */
  onAppendMessage?: (ticketId: string, body: string) => Promise<boolean> | boolean
  /** Mark the active thread solved (`SupportClient.markSolved`). */
  onMarkSolved?: (ticketId: string) => Promise<boolean> | boolean
  /** Subscribe to a thread's live updates (`SupportClient.subscribeTicket`). Drives the 2b typing
   *  indicator (`onTyping`) and the 2c reply toast / badge refresh (`onMessage`). */
  onSubscribe?: (
    ticketId: string,
    handlers: SupportTicketStreamHandlers,
    opts?: { pollIntervalMs?: number },
  ) => SupportTicketSubscription
}

export interface SupportRenderHandle {
  /** Open the panel programmatically (fires `onOpen`). */
  open(): void
  /** Close the panel (fires `onClose`). */
  close(): void
  /** Re-fetch the user's ticket list via `onLoadTickets` and re-render the 2a list, without
   *  disrupting the open thread/step (the list is only repainted when it is the visible surface;
   *  the launcher badge always refreshes). Drives the periodic / on-load / visibility list refresh. */
  refresh(): void
  /** Tear down the widget and remove the shadow host. Idempotent. */
  destroy(): void
}

// ---- small helpers (pure) ------------------------------------------------

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

const fieldsOf = (definition: SupportDefinition): SupportField[] =>
  Array.isArray(definition?.fields) ? definition.fields : []

/** True when the field must be answered before submit is enabled. */
const isRequired = (f: SupportField): boolean => f.required === true

/** A blank answer for the required-field gate: matches capture-rs's `is_blank`. */
const isBlank = (v: unknown): boolean =>
  v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)

/**
 * Read a severity out of the `category` answer. The `bug` starter template encodes its
 * Severity dropdown as a field with `id: 'category'` and choices `Blocker|Major|Minor`, so severity
 * and category were literally the same string. Deriving it here gives every existing bug form real
 * severity data with no author action, while the category answer itself is left untouched. PURE.
 */
const deriveSeverity = (
  category: string | undefined,
): 'blocker' | 'major' | 'minor' | undefined => {
  const v = (category ?? '').trim().toLowerCase()
  return v === 'blocker' || v === 'major' || v === 'minor' ? v : undefined
}

/** `#4F46E5` → `79,70,229`, so the design's `rgba(79,70,229,.5)` launcher glow stays exact on the
 *  default accent and follows a brand override. Falls back to the design value. */
const rgbOf = (hex: string): string => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return '79,70,229'
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1]
  const n = Number.parseInt(h, 16)
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
}

/** Compact relative-time label ("2m", "1d", "2w") for the 2a meta row. Empty on a bad value. */
const relTime = (v?: string | number, nowMs = Date.now()): string => {
  if (v == null) return ''
  const t = typeof v === 'number' ? v : Date.parse(v)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, (nowMs - t) / 1000)
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  const d = s / 86400
  if (d < 7) return `${Math.floor(d)}d`
  if (d < 30) return `${Math.floor(d / 7)}w`
  if (d < 365) return `${Math.floor(d / 30)}mo`
  return `${Math.floor(d / 365)}y`
}

/** "HH:MM" wall-clock for a message timestamp. Empty on a bad value. */
const clockTime = (v?: string | number): string => {
  if (v == null) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Up-to-two-letter initials for an agent avatar ("Maya Kern" → "MK"). */
const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || 'MK'

// ---- inline SVG (lucide geometry, transcribed from the bundle) -----------

const SVG_NS = 'http://www.w3.org/2000/svg'

type Shape = [tag: string, attrs: Record<string, string>]

const p = (d: string): Shape => ['path', { d }]

const ICONS: Record<string, Shape[]> = {
  // 1b launcher + "Send a message" + 1d CTA
  'message-square': [p('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z')],
  // 1b / 1d / 1e search — note the bundle draws r=7, not lucide's r=8
  search: [['circle', { cx: '11', cy: '11', r: '7' }], p('m21 21-4.3-4.3')],
  bot: [
    ['rect', { x: '3', y: '11', width: '18', height: '10', rx: '2' }],
    ['circle', { cx: '12', cy: '5', r: '2' }],
    p('M12 7v4'),
    p('M8 16h.01'),
    p('M16 16h.01'),
  ],
  bug: [
    p('m8 2 1.88 1.88'),
    p('M14.12 3.88 16 2'),
    p('M9 7.13v-1a3.003 3.003 0 1 1 6 0v1'),
    p('M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6'),
    p('M12 20v-9'),
    p('M6.53 9C4.6 8.8 3 7.1 3 5'),
    p('M6 13H2'),
    p('M3 21c0-2.1 1.7-3.9 3.8-4'),
    p('M20.97 5c0 2.1-1.6 3.8-3.5 4'),
    p('M22 13h-4'),
    p('M17.2 17c2.1.1 3.8 1.9 3.8 4'),
  ],
  x: [p('M18 6 6 18'), p('M6 6l12 12')],
  'chevron-down': [p('m6 9 6 6 6-6')],
  'chevron-right': [p('m9 18 6-6-6-6')],
  paperclip: [
    p(
      'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48',
    ),
  ],
  shield: [
    p(
      'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
    ),
  ],
  'book-open': [
    p('M12 7v14'),
    p(
      'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
    ),
  ],
  // Frame 4a article rows draw the CLOSED book, not the 1d/1e 'book-open' — one path, verbatim.
  book: [
    p(
      'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
    ),
  ],
  'calendar-check': [
    p('M20 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h9'),
    p('M16 3v4'),
    p('M8 3v4'),
    p('M2 11h20'),
    p('M15 19l2 2 4-4'),
  ],
  check: [p('M20 6 9 17l-5-5')],
  // 2a/2b/1b-revised additions
  'arrow-left': [p('m12 19-7-7 7-7'), p('M19 12H5')],
  plus: [p('M5 12h14'), p('M12 5v14')],
  // MessageSquareMore — plain message-square outline + two inner "more" lines
  'message-square-more': [
    p('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'),
    p('M8 9h8'),
    p('M8 13h5'),
  ],
  // 2a category squares — the simpler bug glyph (distinct from the 1b action-row Bug icon)
  'bug-simple': [
    p('m8 2 1.88 1.88'),
    p('M14.12 3.88 16 2'),
    p('M9 7.13v-1a3.003 3.003 0 1 1 6 0v1'),
    p('M18 20a6 6 0 0 0-12 0'),
    p('M12 20v-9'),
  ],
  'credit-card': [['rect', { x: '2', y: '5', width: '20', height: '14', rx: '2' }], p('M2 10h20')],
  'help-circle': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    p('M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3'),
    p('M12 17h.01'),
  ],
  // 2b attachment chip + composer send
  image: [
    ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
    ['circle', { cx: '9', cy: '9', r: '2' }],
    p('m21 15-4.5-4.5L9 18'),
  ],
  send: [p('m22 2-7 20-4-9-9-4z')],
}

/** Build an inline lucide-geometry icon. `stroke` is left as `currentColor` so the stylesheet
 *  (which wins over presentation attributes) owns the colour. */
function icon(name: keyof typeof ICONS | string, size: number, strokeWidth = 2): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', String(strokeWidth))
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const node = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    svg.appendChild(node)
  }
  return svg
}

/** Maps the `launcherIcon` appearance enum onto a built-in `ICONS` key. Only these four presets are
 *  accepted — a raw SVG/HTML glyph is deliberately NOT a config option, since it would inject
 *  arbitrary markup into the widget's shadow root. `chat` reuses the "more" message glyph and
 *  `question` the help-circle, matching the design's launcher affordances. */
const LAUNCHER_ICONS: Record<NonNullable<SupportAppearance['launcherIcon']>, keyof typeof ICONS> = {
  message: 'message-square',
  help: 'help-circle',
  chat: 'message-square-more',
  question: 'help-circle',
}

// ---- tiny DOM helpers ----------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function button(className: string, label?: string): HTMLButtonElement {
  const b = el('button', className, label)
  b.type = 'button'
  return b
}

// ---- styles (scoped inside the shadow root) ------------------------------

const styleText = (a: Required<SupportAppearance>): string => {
  const rgb = rgbOf(a.primaryColor)
  const font = a.fontFamily && a.fontFamily.trim() !== '' ? a.fontFamily : INTER_STACK
  // Resolved appearance values seeded onto `:host` (below). Kept in a separate object so the
  // whole-file `${primary}` → `${primary}` var-swap does not rewrite the seed itself.
  const av = { primary: a.primaryColor, bg: a.backgroundColor, text: a.textColor }
  // Themeable values are referenced through CSS custom properties (`var(--ckrm-*, <fallback>)`) so a
  // host page can override any of them by setting the var on the shadow host
  // (`[data-clickroom-support]`) or ANY ancestor — custom properties inherit ACROSS the shadow
  // boundary, and an outer-tree declaration beats the `:host` seed below on an equal-specificity
  // tie. The fallback baked into every var() is the static design literal; `:host` seeds the
  // resolved appearance as each var's effective default.
  const primary = 'var(--ckrm-primary, #4F46E5)'
  const bg = 'var(--ckrm-bg, #ffffff)'
  const text = 'var(--ckrm-text, #0f172a)'
  const radius = 'var(--ckrm-radius, 16px)'
  const panelWidth = 'var(--ckrm-panel-width, 320px)'
  const size = 'var(--ckrm-launcher-size, 52px)'
  const lb = 'var(--ckrm-launcher-bottom, 18px)'
  const lr = 'var(--ckrm-launcher-right, 18px)'
  const ll = 'var(--ckrm-launcher-left, 18px)'
  // Panel bottom sits 8px above the launcher (78px = 18 + 52 + 8); the reply toast 12px above
  // (82px = 18 + 52 + 12). Both are calc()'d off the launcher vars so relocating the FAB (via
  // --ckrm-launcher-bottom / --ckrm-launcher-size) carries the panel + toast with it.
  const panelBottom = `calc(${lb} + ${size} + 8px)`
  const toastBottom = `calc(${lb} + ${size} + 12px)`
  return `
  :host { all: initial; }
  /* Seed the themeable custom properties from the resolved appearance. \`all: initial\` above does
     NOT reset custom properties, and an outer-tree host rule overrides these on a specificity tie. */
  :host {
    --ckrm-primary: ${av.primary};
    --ckrm-bg: ${av.bg};
    --ckrm-text: ${av.text};
    --ckrm-font: ${font};
    --ckrm-launcher-size: ${a.launcherSize}px;
    --ckrm-launcher-bottom: 18px;
    --ckrm-launcher-right: 18px;
    --ckrm-launcher-left: 18px;
    --ckrm-radius: ${a.cornerRadius}px;
    --ckrm-panel-width: ${a.panelWidth}px;
    --ckrm-z: 2147483646;
  }
  * { box-sizing: border-box; font-family: var(--ckrm-font, ${INTER_STACK}); }
  .ckrm-root { position: fixed; inset: 0; z-index: var(--ckrm-z, 2147483646); pointer-events: none; }
  /* Scrims — 1c uses rgba(15,23,42,.28); 1d the darker rgba(15,23,42,.4) + a 22px gutter. */
  .ckrm-root[data-open="true"][data-layout="modal"] {
    background: rgba(15,23,42,.4); pointer-events: auto;
    display: flex; align-items: center; justify-content: center; padding: 22px;
  }
  .ckrm-root[data-open="true"][data-layout="slide_out"] { background: rgba(15,23,42,.28); pointer-events: auto; }

  /* ---- 1b launcher: round FAB (default 52px), glyph ~0.44×, accent glow ---- */
  .ckrm-launcher {
    position: fixed; pointer-events: auto; width: ${size}; height: ${size}; padding: 0;
    border: none; border-radius: 50%; cursor: pointer; background: ${primary};
    display: flex; align-items: center; justify-content: center; color: #fff;
    box-shadow: 0 10px 30px rgba(${rgb},.5);
  }
  .ckrm-launcher svg { stroke: #fff; }
  .ckrm-launcher:focus-visible { outline: 3px solid rgba(255,255,255,.6); outline-offset: 2px; }
  /* Launcher anchors resolve from the --ckrm-launcher-* vars so a host page can relocate the FAB. */
  .ckrm-pos-bottom_right { right: ${lr}; bottom: ${lb}; }
  .ckrm-pos-bottom_left { left: ${ll}; bottom: ${lb}; }
  .ckrm-pos-center { left: 50%; bottom: ${lb}; transform: translateX(-50%); }

  /* ---- panel shells ---- */
  .ckrm-panel {
    position: fixed; pointer-events: auto; display: flex; flex-direction: column;
    background: ${bg}; color: ${text}; overflow: hidden;
  }
  .ckrm-panel:focus { outline: none; }
  /* 1b: panel width (default 320px), radius (default r16), 0 16px 50px rgba(15,23,42,.25);
     bottom = 8px above the launcher (calc off --ckrm-launcher-bottom + --ckrm-launcher-size). */
  .ckrm-layout-launcher {
    width: ${panelWidth}; max-width: calc(100vw - 36px); max-height: calc(100vh - 96px);
    border-radius: ${radius}; box-shadow: 0 16px 50px rgba(15,23,42,.25);
  }
  .ckrm-layout-launcher.ckrm-pos-bottom_right { right: ${lr}; bottom: ${panelBottom}; }
  .ckrm-layout-launcher.ckrm-pos-bottom_left { left: ${ll}; bottom: ${panelBottom}; }
  .ckrm-layout-launcher.ckrm-pos-center { left: 50%; bottom: ${panelBottom}; transform: translateX(-50%); }
  /* 1c: 300px edge-anchored, no radius, -16px 0 50px rgba(15,23,42,.25) */
  .ckrm-layout-slide_out {
    top: 0; bottom: 0; width: 300px; max-width: 100vw; border-radius: 0;
    box-shadow: -16px 0 50px rgba(15,23,42,.25);
  }
  .ckrm-layout-slide_out.ckrm-pos-bottom_right, .ckrm-layout-slide_out.ckrm-pos-center { right: 0; }
  .ckrm-layout-slide_out.ckrm-pos-bottom_left { left: 0; box-shadow: 16px 0 50px rgba(15,23,42,.25); }
  /* 1d: width:100% inside the 22px gutter (396px at the design's 440px viewport) */
  .ckrm-layout-modal {
    position: relative; width: 100%; max-width: 396px; max-height: calc(100vh - 44px);
    border-radius: 16px; box-shadow: 0 24px 60px rgba(0,0,0,.3);
  }

  /* ---- headers ---- */
  .ckrm-header { display: flex; justify-content: space-between; gap: 12px; flex: none; }
  .ckrm-header-accent { background: ${primary}; color: #fff; padding: 18px; align-items: flex-start; }
  .ckrm-header-plain { padding: 18px 18px 14px; border-bottom: 1px solid #eceef2; align-items: center; }
  .ckrm-header-modal { padding: 20px 20px 0; align-items: flex-start; }
  .ckrm-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.25; }
  .ckrm-header-modal .ckrm-title { font-size: 16px; }
  .ckrm-form-title { font-size: 14px; }   /* 1e-3 form title (no header bar) */
  .ckrm-subtitle { margin: 3px 0 0; font-size: 11px; opacity: .85; line-height: 1.35; }
  .ckrm-header-modal .ckrm-subtitle { font-size: 12px; color: #64748b; opacity: 1; }
  .ckrm-close {
    flex: none; border: none; background: none; padding: 0; margin: 0; cursor: pointer;
    line-height: 0; display: inline-flex; color: #94a0b4;
  }
  .ckrm-header-accent .ckrm-close { color: #fff; opacity: .8; }
  .ckrm-sr {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  /* ---- bodies (padding per frame) ---- */
  .ckrm-body { flex: 1; overflow-y: auto; }
  .ckrm-body-home { padding: 16px; }                 /* 1b */
  .ckrm-body-modal { padding: 16px 20px 20px; }      /* 1d */
  .ckrm-body-form { padding: 16px 18px; }            /* 1c */
  .ckrm-body-compact { padding: 14px 16px 16px; }    /* 1e-3 */
  .ckrm-body-answer { padding: 16px; }               /* 1e-2 */
  .ckrm-body-confirmed { padding: 30px 20px; text-align: center; }  /* 1e-4 */

  /* ---- search row (1b 10px/r10/13px · 1d 11px 13px/r11/14px · 1e-1 accent when focused) ---- */
  .ckrm-search {
    display: flex; align-items: center; gap: 8px; border: 1px solid #e2e5ea;
    border-radius: 10px; padding: 10px 12px; font-size: 13px; color: #94a0b4;
  }
  .ckrm-body-modal .ckrm-search { gap: 9px; border-radius: 11px; padding: 11px 13px; font-size: 14px; }
  .ckrm-search svg { flex: none; stroke: #94a0b4; }
  .ckrm-search input {
    flex: 1; min-width: 0; border: none; outline: none; background: transparent;
    font: inherit; color: ${text}; padding: 0;
  }
  .ckrm-search input::placeholder { color: #94a0b4; }
  .ckrm-search:focus-within { border-color: ${primary}; }
  .ckrm-enter { margin-left: auto; color: ${primary}; }

  /* ---- 1b action rows ---- */
  .ckrm-action-list { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
  .ckrm-action {
    display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
    padding: 11px 12px; border: 1px solid #eceef2; border-radius: 10px; font-size: 13px;
    font-family: inherit; background: transparent; color: ${text}; cursor: pointer;
  }
  .ckrm-action svg { flex: none; stroke: ${primary}; }
  .ckrm-action:disabled { cursor: not-allowed; color: #94a0b4; }
  .ckrm-action:disabled svg { stroke: #94a0b4; }
  .ckrm-soon {
    margin-left: auto; padding: 1px 6px; border-radius: 4px; background: #f6f7fb;
    font-size: 9px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #94a0b4;
  }

  /* ---- eyebrows + list rows (1d "Popular articles", 1e-1 "Suggested") ---- */
  .ckrm-eyebrow {
    margin: 14px 0 0; font-size: 10px; font-weight: 600; letter-spacing: .06em;
    text-transform: uppercase; color: #94a0b4;
  }
  .ckrm-suggest-list .ckrm-eyebrow { margin-top: 12px; }
  .ckrm-articles { margin-top: 8px; display: flex; flex-direction: column; gap: 2px; }
  .ckrm-article {
    display: flex; justify-content: space-between; align-items: center; width: 100%;
    padding: 10px 4px; font-size: 13px; font-family: inherit; text-align: left;
    background: none; border: none; border-bottom: 1px solid #f1f3f6; color: inherit; cursor: default;
  }
  .ckrm-article:last-child { border-bottom: none; }
  .ckrm-article svg { flex: none; stroke: #c2c8d2; }
  .ckrm-suggest {
    display: block; width: 100%; margin-top: 6px; padding: 8px 4px; font-size: 13px;
    font-family: inherit; text-align: left; color: #475569; background: none; border: none;
    border-bottom: 1px solid #f1f3f6; cursor: default;
  }
  .ckrm-suggest + .ckrm-suggest { margin-top: 0; }
  .ckrm-suggest:last-child { border-bottom: none; }

  /* ---- 1b footer ---- */
  .ckrm-powered { margin: 14px 0 0; text-align: center; font-size: 10px; color: #aab2c0; }
  .ckrm-powered b { color: ${primary}; font-weight: 600; }

  /* ---- form fields (1c/1e-3: label 11/600 #64748b, field r9 9px 11px 13px) ---- */
  .ckrm-field { display: block; }
  .ckrm-field + .ckrm-field { margin-top: 14px; }
  .ckrm-body-compact .ckrm-field + .ckrm-field { margin-top: 10px; }
  .ckrm-label { display: block; font-size: 11px; font-weight: 600; color: #64748b; }
  .ckrm-req { color: #dc2626; margin-left: 2px; }
  .ckrm-input, .ckrm-textarea, .ckrm-select {
    display: block; width: 100%; margin-top: 6px; padding: 9px 11px; font-size: 13px;
    font-family: inherit; color: ${text}; background: ${bg};
    border: 1px solid #e2e5ea; border-radius: 9px;
  }
  .ckrm-input::placeholder, .ckrm-textarea::placeholder { color: #94a0b4; }
  .ckrm-textarea { height: 70px; resize: vertical; }
  .ckrm-body-compact .ckrm-textarea { height: 44px; }
  .ckrm-input:focus, .ckrm-textarea:focus, .ckrm-select:focus {
    outline: none; border-color: ${primary};
  }
  .ckrm-select-wrap { position: relative; }
  .ckrm-select { appearance: none; -webkit-appearance: none; padding-right: 32px; }
  .ckrm-select-wrap svg {
    position: absolute; right: 11px; top: 50%; transform: translateY(-50%);
    stroke: #94a0b4; pointer-events: none;
  }

  /* ---- 1c dashed attach zone ---- */
  .ckrm-drop {
    display: block; margin-top: 12px; padding: 12px; text-align: center; font-size: 12px;
    color: #94a0b4; border: 1px dashed #cfd4dd; border-radius: 9px; cursor: pointer;
  }
  .ckrm-drop svg { stroke: currentColor; margin-bottom: 4px; }
  .ckrm-drop-input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .ckrm-drop-names { margin-top: 4px; color: ${text}; }

  /* ---- 1c / 1e-3 context notice ---- */
  .ckrm-notice {
    margin-top: 12px; background: #f1f5ff; border: 1px solid #dfe6ff; border-radius: 9px;
    padding: 10px 12px; display: flex; gap: 9px; align-items: flex-start;
    font-size: 11px; color: #4a5578; line-height: 1.4;
  }
  .ckrm-notice svg { flex: none; stroke: ${primary}; margin-top: 1px; }
  .ckrm-body-compact .ckrm-notice {
    margin-top: 10px; padding: 8px 10px; gap: 8px; align-items: center;
    font-size: 10px; line-height: 1.35;
  }
  .ckrm-body-compact .ckrm-notice svg { margin-top: 0; }

  /* ---- buttons ---- */
  .ckrm-btn { appearance: none; font-family: inherit; cursor: pointer; }
  .ckrm-btn-primary {
    display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%;
    border: none; border-radius: 10px; padding: 11px; font-size: 14px; font-weight: 600;
    background: ${primary}; color: #fff;
  }
  .ckrm-body-modal .ckrm-btn-primary { margin-top: 16px; border-radius: 11px; }
  .ckrm-body-compact .ckrm-btn-primary { margin-top: 12px; padding: 10px; font-size: 13px; }
  .ckrm-btn-primary svg { stroke: #fff; }
  .ckrm-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
  .ckrm-btn-ghost {
    background: none; border: none; padding: 9px 0; font-size: 12px; font-weight: 600; color: #64748b;
  }
  .ckrm-footer { flex: none; padding: 14px 18px; border-top: 1px solid #eceef2; }
  .ckrm-footer .ckrm-btn-primary { margin: 0; }

  /* ---- 1e-2 answer (deferred: inert) ---- */
  .ckrm-answer { display: flex; gap: 9px; align-items: flex-start; }
  .ckrm-avatar {
    width: 26px; height: 26px; border-radius: 50%; background: ${primary}; flex: none;
    display: flex; align-items: center; justify-content: center;
  }
  .ckrm-avatar svg { stroke: #fff; }
  .ckrm-answer-text { margin: 0; font-size: 13px; line-height: 1.55; color: #1f2937; }
  .ckrm-answer-text b { font-weight: 700; }
  .ckrm-cite {
    margin-top: 12px; padding: 9px 11px; background: #f6f7fb; border-radius: 9px;
    font-size: 11px; color: #64748b; display: flex; align-items: center; gap: 7px;
  }
  .ckrm-cite svg { flex: none; stroke: #94a0b4; }
  .ckrm-cite b { color: #475569; font-weight: 600; }
  .ckrm-choice { margin-top: 12px; display: flex; gap: 8px; }
  .ckrm-btn-solved {
    flex: 1; border: 1px solid #e2e5ea; background: ${bg}; border-radius: 9px;
    padding: 9px; font-size: 12px; font-weight: 600; color: #16a34a;
  }
  .ckrm-btn-solved:disabled { cursor: not-allowed; opacity: .6; }
  .ckrm-btn-escalate {
    flex: 1; border: none; background: ${primary}; color: #fff; border-radius: 9px;
    padding: 9px; font-size: 12px; font-weight: 600;
  }

  /* ---- 1e-4 confirmed ---- */
  .ckrm-success {
    width: 52px; height: 52px; border-radius: 50%; background: #dcfce7; margin: 0 auto;
    display: flex; align-items: center; justify-content: center;
  }
  .ckrm-success svg { stroke: #16a34a; }
  .ckrm-confirm-title { margin: 14px 0 0; font-size: 15px; font-weight: 600; color: ${text}; }
  .ckrm-confirm-body { margin: 6px 0 0; font-size: 12px; color: #64748b; line-height: 1.5; }
  .ckrm-footnote { margin: 16px 0 0; font-size: 11px; color: #94a0b4; }
  .ckrm-csat { display: flex; gap: 6px; justify-content: center; margin-top: 16px; }
  .ckrm-csat button {
    flex: 1 1 auto; min-width: 34px; height: 34px; border-radius: 9px; cursor: pointer;
    border: 1px solid #e2e5ea; background: transparent; color: #64748b; font-size: 13px;
    font-family: inherit;
  }
  .ckrm-csat button[aria-pressed="true"] { background: ${primary}; color: #fff; border-color: ${primary}; }

  .ckrm-error { margin: 0 0 10px; font-size: 12px; color: #dc2626; }
  .ckrm-hint { margin: 0; font-size: 11px; color: #94a0b4; }

  /* ================= conversation surfaces (2a/2b/2c + 1b row) ================= */
  /* All hexes below are hardcoded design literals — none exist as apps/web tokens. */

  /* 2a/2b widen the launcher panel to 360px; 2b fixes its height to 620px (3 fixed regions). */
  .ckrm-layout-launcher[data-view="tickets"],
  .ckrm-layout-launcher[data-view="thread"] { width: 360px; }
  .ckrm-layout-launcher[data-view="thread"] {
    height: 620px; max-height: calc(100vh - 96px);
  }
  .ckrm-panel[data-view="tickets"] { box-shadow: 0 16px 50px rgba(15,23,42,.3); }
  .ckrm-panel[data-view="thread"] { box-shadow: 0 16px 50px rgba(15,23,42,.3); }

  /* ---- 1b-revised "Your conversations" home row ---- */
  .ckrm-convos-row {
    margin-top: 12px; padding-top: 12px; border-top: 1px solid #f1f3f6;
    display: flex; align-items: center; gap: 10px; width: 100%; font-size: 13px;
    font-family: inherit; background: none; border-left: 0; border-right: 0; border-bottom: 0;
    text-align: left; cursor: pointer; color: ${text};
  }
  .ckrm-convos-row > svg:first-child { flex: none; stroke: ${primary}; }
  .ckrm-convos-label { flex: 1; font-weight: 500; color: #0f172a; }
  .ckrm-convos-chevron { flex: none; stroke: #c2c8d2; }
  /* 1b panel-row pill: 18×18, NO ring (distinct from the 2c launcher badge). */
  .ckrm-pill {
    min-width: 18px; height: 18px; padding: 0 5px; border-radius: 20px; background: #EF4444;
    color: #fff; font-size: 10px; font-weight: 700; display: inline-flex; align-items: center;
    justify-content: center;
  }

  /* ---- 2a "My tickets" list ---- */
  .ckrm-tickets-list { display: flex; flex-direction: column; }
  .ckrm-ticket-row {
    display: flex; gap: 11px; padding: 14px 18px; width: 100%; text-align: left;
    border: none; border-bottom: 1px solid #f1f3f6; font-family: inherit; cursor: pointer;
    background: #fff; color: ${text};
  }
  .ckrm-ticket-row.ckrm-unread { background: #fbfcff; }
  .ckrm-ticket-sq {
    width: 28px; height: 28px; border-radius: 8px; flex: none;
    display: flex; align-items: center; justify-content: center;
  }
  .ckrm-ticket-body { flex: 1; min-width: 0; }
  .ckrm-ticket-titlerow { display: flex; align-items: center; gap: 8px; }
  .ckrm-ticket-subject {
    font-size: 13px; font-weight: 600; color: #0f172a; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .ckrm-ticket-dot { width: 8px; height: 8px; border-radius: 50%; background: #4F46E5; flex: none; }
  .ckrm-ticket-snippet {
    font-size: 12px; color: #64748b; margin-top: 3px; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .ckrm-ticket-meta { display: flex; align-items: center; gap: 8px; margin-top: 7px; }
  .ckrm-status-chip {
    font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 4px;
  }
  .ckrm-ticket-id {
    font-size: 10px; color: #94a0b4;
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .ckrm-ticket-time { margin-left: auto; font-size: 10px; color: #94a0b4; }
  .ckrm-tickets-footer { flex: none; padding: 14px 18px; }
  .ckrm-new-convo {
    width: 100%; background: ${primary}; color: #fff; border: none; border-radius: 10px;
    padding: 11px; font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 8px;
  }
  .ckrm-new-convo svg { stroke: #fff; }
  .ckrm-tickets-empty { padding: 28px 18px; text-align: center; font-size: 12px; color: #94a0b4; }

  /* ---- 2b conversation ---- */
  .ckrm-presence { margin-top: 3px; display: flex; align-items: center; gap: 6px; }
  .ckrm-presence-dot { width: 6px; height: 6px; border-radius: 50%; background: #4ADE80; flex: none; }
  .ckrm-presence-text { font-size: 10px; opacity: .9; }
  .ckrm-header-accent .ckrm-title-sub { min-width: 0; }
  .ckrm-thread {
    flex: 1; overflow: auto; padding: 16px; background: #f8f9fc;
    display: flex; flex-direction: column; gap: 12px;
  }
  .ckrm-date-divider { text-align: center; font-size: 10px; color: #a3abbb; }
  .ckrm-msg { display: flex; flex-direction: column; gap: 4px; }
  .ckrm-msg-start { align-items: flex-start; }
  .ckrm-msg-end { align-items: flex-end; }
  .ckrm-author-row { display: flex; align-items: center; gap: 6px; padding: 0 2px; }
  .ckrm-msg-avatar {
    width: 18px; height: 18px; border-radius: 50%; flex: none; display: flex;
    align-items: center; justify-content: center; font-size: 8px; font-weight: 700;
  }
  .ckrm-author-name { font-size: 10px; font-weight: 600; color: #64748b; }
  .ckrm-author-role { font-size: 10px; color: #a3abbb; }
  .ckrm-bubble {
    max-width: 82%; padding: 10px 13px; font-size: 13px; line-height: 1.5;
    border: 1px solid transparent; word-wrap: break-word; overflow-wrap: anywhere;
  }
  .ckrm-bubble-user {
    background: ${primary}; color: #fff; border-color: ${primary};
    border-radius: 13px 13px 4px 13px;
  }
  .ckrm-bubble-agent {
    background: #fff; color: #1f2937; border-color: #e6e9ef; border-radius: 13px 13px 13px 4px;
  }
  .ckrm-msg-attach {
    display: flex; align-items: center; gap: 8px; background: #fff; border: 1px solid #e6e9ef;
    border-radius: 9px; padding: 8px 10px; font-size: 11px; color: #475569;
  }
  .ckrm-msg-attach svg { flex: none; stroke: #94a0b4; }
  .ckrm-msg-time { font-size: 10px; color: #a3abbb; padding: 0 3px; }
  .ckrm-msg-system {
    align-self: center; font-size: 10px; color: #a3abbb; text-align: center; max-width: 90%;
  }
  .ckrm-typing { display: flex; align-items: center; gap: 7px; padding: 0 2px; }
  .ckrm-typing-avatar {
    width: 18px; height: 18px; border-radius: 50%; background: ${primary}; flex: none;
    display: flex; align-items: center; justify-content: center; font-size: 8px; font-weight: 700; color: #fff;
  }
  .ckrm-typing-dots {
    display: flex; gap: 3px; background: #fff; border: 1px solid #e6e9ef; border-radius: 12px;
    padding: 9px 12px;
  }
  .ckrm-typing-dots span { width: 5px; height: 5px; border-radius: 50%; }
  .ckrm-typing-dots span:nth-child(1) { background: #c2c8d2; }
  .ckrm-typing-dots span:nth-child(2) { background: #d6dae2; }
  .ckrm-typing-dots span:nth-child(3) { background: #e4e7ed; }
  .ckrm-composer { flex: none; border-top: 1px solid #eceef2; padding: 12px 14px; background: #fff; }
  .ckrm-composer-input {
    display: flex; align-items: center; gap: 10px; border: 1px solid #e2e5ea; border-radius: 11px;
    padding: 9px 12px;
  }
  .ckrm-composer-input input {
    flex: 1; min-width: 0; border: none; outline: none; background: transparent; font: inherit;
    font-size: 13px; color: ${text}; padding: 0;
  }
  .ckrm-composer-input input::placeholder { color: #94a0b4; }
  .ckrm-composer-input svg { flex: none; stroke: #94a0b4; }
  .ckrm-composer-send {
    width: 28px; height: 28px; border-radius: 8px; background: ${primary}; border: none;
    flex: none; display: flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .ckrm-composer-send svg { stroke: #fff; }
  .ckrm-composer-footer {
    display: flex; align-items: center; justify-content: space-between; margin-top: 9px;
  }
  .ckrm-ticket-state { font-size: 10px; color: #a3abbb; }
  .ckrm-mark-solved {
    font-size: 11px; color: #16a34a; font-weight: 600; cursor: pointer; background: none;
    border: none; padding: 0; font-family: inherit;
  }

  /* ---- 2c launcher badge (19×19, 2px page-bg ring — distinct from the 1b pill) ---- */
  .ckrm-launcher { position: fixed; }
  .ckrm-launcher-badge {
    position: absolute; top: -2px; right: -2px; min-width: 19px; height: 19px; padding: 0 4px;
    border-radius: 20px; background: #EF4444; border: 2px solid ${bg};
    display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700;
    color: #fff; pointer-events: none;
  }

  /* ---- 2c reply toast (270px, above the launcher) ---- */
  .ckrm-toast {
    position: fixed; width: 270px; background: #fff; border-radius: 13px;
    box-shadow: 0 12px 36px rgba(15,23,42,.24); padding: 13px; display: flex; gap: 10px;
    pointer-events: auto; text-align: left; border: none; font-family: inherit; cursor: pointer;
  }
  .ckrm-toast.ckrm-pos-bottom_right { right: ${lr}; bottom: ${toastBottom}; }
  .ckrm-toast.ckrm-pos-bottom_left { left: ${ll}; bottom: ${toastBottom}; }
  .ckrm-toast.ckrm-pos-center { left: 50%; bottom: ${toastBottom}; transform: translateX(-50%); }
  .ckrm-toast-avatar {
    width: 30px; height: 30px; border-radius: 50%; background: ${primary}; flex: none;
    display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #fff;
  }
  .ckrm-toast-body { flex: 1; min-width: 0; }
  .ckrm-toast-title { font-size: 12px; font-weight: 600; color: #0f172a; }
  .ckrm-toast-preview {
    font-size: 11px; color: #64748b; line-height: 1.45; margin-top: 3px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .ckrm-toast-cta { font-size: 10px; color: ${primary}; font-weight: 600; margin-top: 7px; }

  @media (max-width: 480px) {
    .ckrm-layout-launcher { width: calc(100vw - 36px); }
    .ckrm-layout-launcher[data-view="tickets"],
    .ckrm-layout-launcher[data-view="thread"] { width: calc(100vw - 36px); }
    .ckrm-layout-launcher[data-view="thread"] { height: calc(100vh - 96px); }
    .ckrm-layout-slide_out { width: 100vw; }
    .ckrm-toast { width: calc(100vw - 36px); }
  }

  /* ================= Inline (page) surface — frames 3a (two-pane) / 3b (stacked) ================= */
  /* The root is NOT fixed and draws no scrim: it fills \`opts.container\` and the panel is flush
     (no radius, no shadow). Everything here is gated on the \`data-embed\` flag the mount sets. */
  .ckrm-root[data-embed="true"] {
    position: static; inset: auto; pointer-events: auto; background: none;
    display: flex; flex-direction: column; width: 100%; height: 100%;
  }
  .ckrm-root[data-embed="true"] .ckrm-panel {
    position: static; width: 100%; height: 100%; max-width: none; max-height: none;
    border-radius: 0; box-shadow: none; flex: 1; min-height: 0;
  }

  /* Page header (two-pane). */
  .ckrm-inline-header {
    flex: none; padding: 22px 26px 16px; border-bottom: 1px solid #eef0f4;
    display: flex; align-items: flex-start; gap: 12px;
  }
  .ckrm-inline-stacked-header { padding: 18px 20px 14px; gap: 10px; }
  /* Back to the 4a home surface. Same affordance as the bot page's back arrow, nudged down so it
     optically aligns with the title's cap height rather than the flex row's top edge. */
  .ckrm-inline-back {
    border: none; background: none; padding: 0; cursor: pointer; display: flex; flex: none;
    margin-top: 3px;
  }
  .ckrm-inline-back svg { stroke: #64748b; }
  .ckrm-inline-headtext { flex: 1; min-width: 0; }
  .ckrm-inline-title {
    margin: 0; font-size: 19px; font-weight: 600; color: #0f172a; letter-spacing: -.01em;
  }
  .ckrm-inline-stacked-header .ckrm-inline-title { font-size: 17px; }
  .ckrm-inline-subtitle { margin: 4px 0 0; font-size: 13px; color: #64748b; }
  .ckrm-inline-stacked-header .ckrm-inline-subtitle { font-size: 12px; }

  /* Body: list rail + thread pane side by side. */
  .ckrm-inline-body { flex: 1; display: flex; min-height: 0; }

  /* List rail. */
  .ckrm-inline-rail {
    width: 290px; flex-shrink: 0; border-right: 1px solid #eef0f4;
    display: flex; flex-direction: column; min-height: 0;
  }
  .ckrm-inline-newwrap { padding: 12px 14px; flex: none; }
  .ckrm-inline-new {
    width: 100%; background: ${primary}; color: #fff; border: none; border-radius: 9px;
    padding: 9px; font-size: 12.5px; font-weight: 600; font-family: inherit; cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 7px;
  }
  .ckrm-inline-new svg { stroke: #fff; }
  .ckrm-inline-rows { flex: 1; overflow: auto; min-height: 0; }
  .ckrm-inline-row {
    display: flex; gap: 10px; padding: 12px 14px; border: none; border-bottom: 1px solid #f4f5f8;
    position: relative; width: 100%; text-align: left; background: none; font-family: inherit;
    cursor: pointer; color: ${text};
  }
  .ckrm-inline-row.ckrm-inline-selected { background: #f5f6ff; }
  .ckrm-inline-row.ckrm-inline-selected::before {
    content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: #4F46E5;
  }
  .ckrm-inline-sq {
    width: 26px; height: 26px; border-radius: 7px; flex: none;
    display: flex; align-items: center; justify-content: center;
  }
  .ckrm-inline-rowbody { flex: 1; min-width: 0; }
  .ckrm-inline-rowtop { display: flex; align-items: center; gap: 8px; }
  .ckrm-inline-subject {
    font-size: 12.5px; font-weight: 600; color: #0f172a; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .ckrm-inline-dot { width: 7px; height: 7px; border-radius: 50%; background: #4F46E5; flex: none; }
  .ckrm-inline-snippet {
    font-size: 11.5px; color: #64748b; margin-top: 3px; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .ckrm-inline-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .ckrm-inline-chip { font-size: 9.5px; font-weight: 600; padding: 2px 6px; border-radius: 4px; }
  .ckrm-inline-time { margin-left: auto; font-size: 9.5px; color: #94a0b4; }

  /* Thread pane. */
  .ckrm-inline-pane {
    flex: 1; min-width: 0; background: #fbfbfd; display: flex; flex-direction: column; min-height: 0;
  }
  .ckrm-inline-pane-header {
    padding: 14px 20px; border-bottom: 1px solid #eef0f4; display: flex; align-items: center;
    gap: 12px; flex: none;
  }
  .ckrm-inline-pane-subject { margin: 0; font-size: 14px; font-weight: 600; color: #0f172a; }
  .ckrm-inline-presence { margin-top: 3px; display: flex; align-items: center; gap: 6px; }
  .ckrm-inline-presence-dot {
    width: 6px; height: 6px; border-radius: 50%; background: #22C55E; flex: none;
  }
  .ckrm-inline-presence-text { font-size: 11px; color: #64748b; }
  .ckrm-inline-ticketmeta {
    margin-top: 3px; font-size: 10px; color: #94a0b4;
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .ckrm-inline-solve {
    margin-left: auto; font-size: 11.5px; font-weight: 600; color: #16a34a; background: none;
    border: none; padding: 0; cursor: pointer; font-family: inherit; align-self: flex-start;
  }
  /* Reuse the 2b messages + composer inside the pane, only re-skinning bg / padding / bubble cap. */
  .ckrm-inline-pane .ckrm-thread { background: #fbfbfd; padding: 18px 20px; }
  .ckrm-inline-pane .ckrm-bubble { max-width: 62%; }
  .ckrm-inline-pane .ckrm-composer {
    flex: none; border-top: 1px solid #eef0f4; padding: 12px 20px; background: #fff;
  }
  .ckrm-inline-compose { flex: 1; overflow-y: auto; padding: 16px 20px; }

  /* Empty / confirmed pane (centered). */
  .ckrm-inline-empty {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; padding: 24px; text-align: center;
  }
  .ckrm-inline-empty svg { stroke: #c2c8d2; }
  .ckrm-inline-empty-text { margin: 0; font-size: 13px; color: #64748b; }
  .ckrm-inline-empty .ckrm-inline-new { width: auto; padding: 9px 16px; }

  /* Branding footer pinned to the container bottom (dropped when hideBranding). */
  .ckrm-inline-branding {
    flex: none; padding: 12px 16px; border-top: 1px solid #eef0f4; text-align: center;
    font-size: 10px; color: #aab2c0;
  }
  .ckrm-inline-branding b { color: ${primary}; font-weight: 600; }

  /* ================= Inline HOME surface — frame 4a (search-first) ================= */
  /* A single scrolling column: hero (search posture only) + channel cards + popular articles +
     conversations strip. No branding footer — frame 4a's pane ends after the strip (3a/3b keep
     theirs). */
  .ckrm-home { flex: 1; overflow: auto; min-height: 0; }
  .ckrm-home-hero {
    background: linear-gradient(180deg,#f5f6ff 0%,#fff 100%); border-bottom: 1px solid #eef0f4;
    padding: 44px 40px 34px; text-align: center;
  }
  .ckrm-home-title {
    margin: 0; font-size: 24px; font-weight: 600; color: #0f172a; letter-spacing: -.015em;
  }
  .ckrm-home-sub { margin: 6px 0 0; font-size: 13.5px; color: #64748b; }
  .ckrm-home-search {
    margin: 20px auto 0; max-width: 520px; display: flex; align-items: center; gap: 11px;
    background: #fff; border: 1px solid #d9dbe6; border-radius: 12px; padding: 13px 16px;
    box-shadow: 0 4px 16px rgba(15,23,42,.06);
  }
  .ckrm-home-search svg { stroke: #94a0b4; flex: none; }
  .ckrm-home-search input {
    flex: 1; min-width: 0; border: none; outline: none; background: none; padding: 0;
    font-family: inherit; font-size: 14px; color: #0f172a;
  }
  .ckrm-home-search input::placeholder { color: #94a0b4; }
  .ckrm-home-kbd {
    flex: none; font-size: 10px; color: #aab2c0; border: 1px solid #e6e8f0; border-radius: 5px;
    padding: 2px 6px;
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .ckrm-home-content { padding: 26px 40px 34px; display: flex; flex-direction: column; gap: 26px; }
  /* The design frame is a 1080px window minus a 196px host nav ⇒ an ~884px content column, and
     every metric here (40px gutters, 3 cards, the 520px search, the 2-up convo grid) is tuned to
     it. On a wide host route the column centres instead of stretching the cards to ~600px each.
     The hero's gradient band stays full-bleed — only its text + search centre in the same column. */
  .ckrm-home-content,
  .ckrm-home-hero-inner,
  .ckrm-bot-header,
  .ckrm-bot-body { width: 100%; max-width: 884px; margin-inline: auto; }
  .ckrm-home-cards { display: grid; grid-template-columns: repeat(3,1fr); gap: 12px; }
  .ckrm-home-card {
    border: 1px solid #e8eaef; border-radius: 12px; padding: 16px; cursor: pointer; background: #fff;
    text-align: left; font-family: inherit; display: block; color: ${text};
  }
  .ckrm-home-card-icon {
    width: 32px; height: 32px; border-radius: 9px; display: flex; align-items: center;
    justify-content: center;
  }
  .ckrm-home-card-title { font-size: 13.5px; font-weight: 600; color: #0f172a; margin-top: 11px; }
  .ckrm-home-card-desc { font-size: 12px; color: #64748b; line-height: 1.45; margin-top: 3px; }
  .ckrm-home-eyebrow-row {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;
  }
  .ckrm-home-eyebrow {
    font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #94a0b4;
  }
  .ckrm-home-link {
    font-size: 12px; color: #4F46E5; font-weight: 500; background: none; border: none; padding: 0;
    cursor: pointer; font-family: inherit;
  }
  .ckrm-home-convo-right { display: flex; align-items: center; gap: 7px; }
  .ckrm-home-unread {
    min-width: 18px; height: 18px; padding: 0 6px; border-radius: 20px; background: #EF4444;
    color: #fff; font-size: 10px; font-weight: 700; display: flex; align-items: center;
    justify-content: center;
  }
  .ckrm-home-articles { border: 1px solid #eef0f4; border-radius: 12px; overflow: hidden; }
  .ckrm-home-article {
    display: flex; align-items: center; gap: 12px; padding: 13px 16px; width: 100%; text-align: left;
    background: none; border: none; border-bottom: 1px solid #f4f5f8; cursor: pointer;
    font-family: inherit;
  }
  /* No :last-child reset — the design keeps the hairline on EVERY row inside the rounded box. */
  .ckrm-home-article svg { flex: none; }
  .ckrm-home-article-book { stroke: #94a0b4; }
  .ckrm-home-article-title {
    flex: 1; min-width: 0; font-size: 13px; color: #0f172a; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .ckrm-home-article-meta { font-size: 11px; color: #94a0b4; }
  .ckrm-home-article-chev { stroke: #c2c8d2; }
  .ckrm-home-empty { margin: 0; padding: 16px; font-size: 12.5px; color: #94a0b4; text-align: center; }
  .ckrm-home-convo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .ckrm-home-convo-card {
    border: 1px solid #eef0f4; background: #fff; border-radius: 11px; padding: 13px 14px;
    display: flex; gap: 11px; cursor: pointer; width: 100%; text-align: left; font-family: inherit;
  }
  .ckrm-home-convo-card.ckrm-home-convo-unread { border-color: #dfe3ff; background: #fafaff; }
  .ckrm-home-convo-sq {
    width: 26px; height: 26px; border-radius: 7px; flex: none; display: flex; align-items: center;
    justify-content: center;
  }
  .ckrm-home-convo-body { flex: 1; min-width: 0; }
  .ckrm-home-convo-top { display: flex; align-items: center; gap: 7px; }
  .ckrm-home-convo-subject {
    font-size: 12.5px; font-weight: 600; color: #0f172a; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ckrm-home-convo-dot { width: 7px; height: 7px; border-radius: 50%; background: #4F46E5; flex: none; }
  .ckrm-home-convo-snippet {
    font-size: 11.5px; color: #64748b; margin-top: 3px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ckrm-home-convo-meta { display: flex; align-items: center; gap: 7px; margin-top: 7px; }
  .ckrm-home-convo-chip { font-size: 9.5px; font-weight: 600; padding: 2px 6px; border-radius: 4px; }
  .ckrm-home-convo-time { margin-left: auto; font-size: 9.5px; color: #94a0b4; }

  /* ---- Inline Ask-AI (bot) page — frame 4a "Ask AI": page-width thread + cited-sources sidebar ---- */
  .ckrm-bot { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .ckrm-bot-header {
    flex: none; padding: 14px 20px; border-bottom: 1px solid #eef0f4; display: flex;
    align-items: center; gap: 12px;
  }
  .ckrm-bot-back { border: none; background: none; padding: 0; cursor: pointer; display: flex; }
  .ckrm-bot-back svg { stroke: #64748b; }
  .ckrm-bot-title { margin: 0; font-size: 14px; font-weight: 600; color: #0f172a; }
  .ckrm-bot-soon {
    margin-left: auto; font-size: 10px; font-weight: 600; color: #7c3aed; background: #ede9fe;
    padding: 2px 8px; border-radius: 20px;
  }
  .ckrm-bot-body { flex: 1; display: flex; min-height: 0; }
  .ckrm-bot-main { flex: 1; min-width: 0; overflow: auto; padding: 24px 28px; }
  .ckrm-bot-sidebar {
    width: 260px; flex: none; border-left: 1px solid #eef0f4; overflow: auto; padding: 20px;
  }
  .ckrm-bot-sidebar-eyebrow {
    margin: 0 0 12px; font-size: 11px; font-weight: 600; letter-spacing: .06em;
    text-transform: uppercase; color: #94a0b4;
  }
  .ckrm-bot-cite {
    display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f4f5f8;
  }
  .ckrm-bot-cite:last-child { border-bottom: none; }
  .ckrm-bot-cite svg { flex: none; stroke: #94a0b4; margin-top: 1px; }
  .ckrm-bot-cite-title { font-size: 12.5px; color: #0f172a; }
  .ckrm-bot-cite-meta { font-size: 11px; color: #94a0b4; margin-top: 2px; }

  /* Stacked collapse (container < ~640px): single-column cards + conversations, sidebar under main. */
  .ckrm-panel[data-embed-stacked="true"] .ckrm-home-hero { padding: 30px 20px 24px; }
  .ckrm-panel[data-embed-stacked="true"] .ckrm-home-content { padding: 20px; gap: 22px; }
  .ckrm-panel[data-embed-stacked="true"] .ckrm-home-cards { grid-template-columns: 1fr; }
  .ckrm-panel[data-embed-stacked="true"] .ckrm-home-convo-grid { grid-template-columns: 1fr; }
  .ckrm-panel[data-embed-stacked="true"] .ckrm-bot-body { flex-direction: column; }
  .ckrm-panel[data-embed-stacked="true"] .ckrm-bot-main { padding: 20px; }
  .ckrm-panel[data-embed-stacked="true"] .ckrm-bot-sidebar {
    width: auto; border-left: none; border-top: 1px solid #eef0f4;
  }
`
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

const TITLE_ID = 'ckrm-support-title'

/**
 * Render the support widget into a shadow-DOM-isolated host.
 *
 * Pure: depends only on the passed `definition` + callbacks + DOM — never on the SDK's config
 * client. Safe to import from the web builder's preview pane with no-op callbacks.
 */
export function renderSupport(
  definition: SupportDefinition,
  opts: RenderSupportOptions,
): SupportRenderHandle {
  if (typeof document === 'undefined') {
    return { open() {}, close() {}, refresh() {}, destroy() {} }
  }

  const appearance: Required<SupportAppearance> = {
    ...DEFAULT_APPEARANCE,
    ...(definition?.appearance ?? {}),
    ...(opts.appearance ?? {}),
  }
  const layout: SupportLayout = appearance.layout
  const position: SupportPosition = appearance.position
  const fields = fieldsOf(definition)
  const triggers = definition?.triggers
  const tracking = definition?.tracking
  const sources = Array.isArray(definition?.sources) ? definition.sources : []
  /** `layout: 'inline'` — the support surface is a PAGE embedded in `opts.container`, not a FAB:
   *  no launcher, no scrim, no focus trap, no ESC, always open; a two-pane master-detail above a
   *  ~640px container, collapsing to the stacked 2a→2b nav below it (frames 3a/3b). */
  const embed = layout === 'inline'
  // Inline is a page, so it never steals focus and never traps Tab/ESC — `autoFocus` defaults
  // FALSE for inline (an explicit `true` is still honoured for the rare host that wants it).
  const autoFocus = embed ? opts.autoFocus === true : opts.autoFocus !== false
  /** Frame 1e: only step 1 keeps the indigo header, and only for the launcher layout. The
   *  slide-out (1c) and modal (1d) keep their own header on every step — it holds their close X. */
  const headerlessSteps = layout === 'launcher'

  // Live answer state. `subject`/`body` are the always-present pair every ticket carries
  // (capture-rs validates them separately from the declared custom fields).
  let subject = ''
  let body = ''
  let query = ''
  // Inline (frame 4a) home search query + the live <input> ref, so the ⌘K keydown can focus it and
  // the results list can re-paint without a full re-render (which would drop focus).
  let homeQuery = ''
  let homeSearchInput: HTMLInputElement | null = null
  const answers: Record<string, unknown> = {}
  const files: Record<string, File[]> = {}
  const focused = new Set<string>()

  let step: SupportView = opts.initialView ?? opts.initialStep ?? 'ask'
  let open = false
  let destroyed = false
  let submitting = false
  // Which compose entry point the user came through. Reset to 'conversation' on every
  // panel open and on every flow reset, so a bug filed in one session cannot type the next one.
  let composeType: 'conversation' | 'bug' = 'conversation'
  let errorText = ''
  let ticketNumber: number | undefined
  let csatScore: number | null = null

  // ---- conversation state (frames 2a/2b/2c + 1b row) --------------
  const identified = opts.identified === true
  let ticketRows: SupportTicketRow[] = Array.isArray(opts.tickets) ? [...opts.tickets] : []
  let activeTicketId: string | null =
    opts.initialThread?.id ??
    opts.initialThreadId ??
    (step === 'thread' ? (ticketRows[0]?.id ?? null) : null)
  let thread: SupportTicketThread | null = opts.initialThread ?? null
  let agentTyping = false
  let threadReq = 0
  let threadSub: SupportTicketSubscription | null = null
  let bgSub: SupportTicketSubscription | null = null
  let toastEl: HTMLElement | null = null
  let toastTimer: ReturnType<typeof setTimeout> | null = null

  // ---- inline (page) state (frames 3a/3b) — measured off the CONTAINER, not the viewport --------
  /** Last observed container width (px). Drives the two-pane ⇄ stacked collapse at ~640px. */
  let embedWidth = 0
  /** Whether the container is currently in the stacked (narrow) regime — only re-render on a flip. */
  let embedStacked = false
  let resizeObs: ResizeObserver | null = null

  /** Summed unread across the user's tickets — drives the 1b pill + 2c launcher badge. Falls back
   *  to the `unreadCount` override when no rows were provided. */
  const currentUnread = (): number =>
    ticketRows.length > 0
      ? ticketRows.reduce((n, t) => n + (t.unreadForUser ?? 0), 0)
      : (opts.unreadCount ?? 0)

  const asMs = (v?: string | number): number =>
    v == null ? 0 : typeof v === 'number' ? v : Date.parse(v) || 0

  /** The most-recently-created ticket that still has an unread agent/ai reply (open-to rules). */
  const mostRecentUnread = (): SupportTicketRow | undefined =>
    ticketRows
      .filter((t) => (t.unreadForUser ?? 0) > 0)
      .sort((a, b) => asMs(b.createdAt) - asMs(a.createdAt))[0]

  const newestTicket = (): SupportTicketRow | undefined =>
    [...ticketRows].sort((a, b) => asMs(b.createdAt) - asMs(a.createdAt))[0]

  const rowFor = (id: string | null): SupportTicketRow | undefined =>
    id == null ? undefined : ticketRows.find((t) => t.id === id)

  /** Whether the 1b "Your conversations" row shows: any user with ≥1 known ticket. Identified users
   *  get the server-backed list; anonymous users get the localStorage-seeded `ckrm_support_tickets`
   *  store (this-browser tickets only — cross-device history still needs the deferred email link). */
  const showConvosRow = (): boolean => ticketRows.length > 0

  // ---- shadow host -------------------------------------------------------

  const host = document.createElement('div')
  host.setAttribute('data-clickroom-support', '')
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = styleText(appearance)
  shadow.appendChild(style)

  const root = el('div', 'ckrm-root')
  root.setAttribute('data-layout', layout)
  root.setAttribute('data-open', 'false')
  shadow.appendChild(root)

  // 1b: round bubble (default 52px), configurable glyph, white. The label becomes the accessible
  // name — the design draws no text in the bubble. The bubble px lives in --ckrm-launcher-size (so
  // a host page can resize it); the glyph is drawn in JS and scales with it (~0.44×, 23 at 52).
  const launcher = button(`ckrm-launcher ckrm-pos-${position}`)
  launcher.setAttribute('aria-haspopup', 'dialog')
  launcher.setAttribute('aria-expanded', 'false')
  launcher.setAttribute('aria-label', `${appearance.launcherLabel} — open support`)
  const launcherIconName = LAUNCHER_ICONS[appearance.launcherIcon] ?? 'message-square'
  launcher.appendChild(icon(launcherIconName, Math.round(appearance.launcherSize * 0.44)))

  // 2c launcher badge (19×19, 2px page-bg ring). Distinct element from the 1b panel-row pill.
  const launcherBadge = el('span', 'ckrm-launcher-badge')
  launcherBadge.setAttribute('aria-hidden', 'true')
  if (opts.pageBackground) launcherBadge.style.borderColor = opts.pageBackground
  launcher.appendChild(launcherBadge)

  /** Reflect the current unread count on the launcher badge (and its accessible name). */
  function refreshBadge(): void {
    const n = currentUnread()
    if (n > 0) {
      launcherBadge.textContent = String(n)
      launcherBadge.style.display = ''
      launcher.setAttribute('aria-label', `${appearance.launcherLabel} — open support, ${n} unread`)
    } else {
      launcherBadge.textContent = ''
      launcherBadge.style.display = 'none'
      launcher.setAttribute('aria-label', `${appearance.launcherLabel} — open support`)
    }
  }
  refreshBadge()

  const panel = el('div', `ckrm-panel ckrm-layout-${layout} ckrm-pos-${position}`)
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', layout === 'modal' ? 'true' : 'false')
  panel.setAttribute('aria-labelledby', TITLE_ID)
  // Programmatically focusable (so open() can land focus in the dialog) but not tab-reachable.
  panel.tabIndex = -1

  // `showLauncher: false` means the form is opened only by `autoOpen` / a trigger / the host app
  // calling `handle.open()` — the persistent affordance is suppressed, not the widget.
  // Inline (`embed`) NEVER renders the launcher bubble: it is a page, not a floating FAB. The
  // launcher element is still constructed (so the launcher/badge helpers stay null-safe) but never
  // appended to the tree.
  const showLauncher = triggers?.showLauncher !== false
  if (showLauncher && !embed) root.appendChild(launcher)

  // ---- focus trap + ESC (captured at document level; shadow re-targets events) --------------

  const focusables = (): HTMLElement[] =>
    Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (node) => !node.hasAttribute('disabled'),
    )

  function onKeydown(e: KeyboardEvent): void {
    if (destroyed || !open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      closePanel()
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

  const safe = (fn?: () => void): void => {
    try {
      fn?.()
    } catch {
      // never throw from a callback
    }
  }

  /** Frame 4a: `⌘K` / `Ctrl+K` from ANYWHERE ON THE PAGE jumps to the search home and focuses its
   *  input — the design wants the shortcut to work while focus is in the host app, not just inside our
   *  shadow tree, so this is bound on `document` (capture, mirroring the focus-trap listener) at
   *  mount, inline only, and removed on destroy. */
  function onHomeKeydown(e: KeyboardEvent): void {
    if (destroyed || !embed || !open) return
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      // No search box mounted (another surface, or the conversations posture) → navigate to the
      // search surface, which always draws the hero.
      if (!homeSearchInput) {
        step = 'search'
        renderStep()
      }
      homeSearchInput?.focus()
    }
  }

  // ---- open / close / destroy -------------------------------------------

  function openPanel(): void {
    if (destroyed || open) return
    open = true
    errorText = ''
    composeType = 'conversation'
    root.setAttribute('data-open', 'true')
    launcher.setAttribute('aria-expanded', 'true')
    root.appendChild(panel)
    // Focus trap + ESC-to-close are wired only for the FAB layouts. Inline is a page: it never
    // hijacks Tab or ESC (and `autoFocus` is false there anyway).
    if (autoFocus && !embed) {
      try {
        document.addEventListener('keydown', onKeydown, true)
      } catch {
        // ignore
      }
    }
    safe(opts.onOpen)
    renderStep()
  }

  /** Decide the fresh (non-explicit) starting surface — the mount open-to rules, minus the actual
   *  panel open. Sets `step`/`activeTicketId` to home (`ask`) or, for an identified user with an
   *  unread reply, the most-recent unread thread, and returns that target row (if any) so the caller
   *  can perform the navigation (load + subscribe + open) exactly as mount does. */
  function resolveInitialSurface(): SupportTicketRow | undefined {
    const target = identified ? mostRecentUnread() : undefined
    if (target) {
      step = 'thread'
      activeTicketId = target.id
    } else {
      step = 'ask'
      activeTicketId = null
    }
    return target
  }

  /** Clear the transient ticket-composition + confirmation state, then re-resolve the next starting
   *  surface. Called after a `confirmed`-step close so the next open starts fresh instead of
   *  re-showing the stale confirmation. Never opens/closes the panel itself (avoids re-entrancy). */
  function resetFlow(): void {
    subject = ''
    body = ''
    query = ''
    for (const k of Object.keys(answers)) delete answers[k]
    for (const k of Object.keys(files)) delete files[k]
    focused.clear()
    submitting = false
    composeType = 'conversation'
    errorText = ''
    ticketNumber = undefined
    csatScore = null
    resolveInitialSurface()
  }

  function closePanel(): void {
    if (destroyed || !open) return
    // Inline is always open — `close()` only switches views (never hides the page). The panel and
    // its host stay mounted until `destroy()`.
    if (embed) return
    // Capture the surface being torn down: only the terminal `confirmed` step gets reset, so an
    // in-progress draft (ticket/answer/ask) or a persistent surface (tickets/thread) survives close.
    const closingStep = step
    open = false
    root.setAttribute('data-open', 'false')
    launcher.setAttribute('aria-expanded', 'false')
    try {
      panel.remove()
      document.removeEventListener('keydown', onKeydown, true)
    } catch {
      // ignore
    }
    safe(opts.onClose)
    if (autoFocus && showLauncher) {
      try {
        launcher.focus()
      } catch {
        // ignore
      }
    }
    if (closingStep === 'confirmed' && !explicitInitial) resetFlow()
  }

  function destroy(): void {
    if (destroyed) return
    // Close first so a mid-flight close callback still fires exactly once.
    if (open) closePanel()
    destroyed = true
    teardownSubs()
    dismissToast()
    try {
      resizeObs?.disconnect()
    } catch {
      // ignore
    }
    resizeObs = null
    try {
      document.removeEventListener('keydown', onKeydown, true)
      document.removeEventListener('keydown', onHomeKeydown as EventListener, true)
      host.remove()
    } catch {
      // ignore
    }
  }

  launcher.addEventListener('click', () => (open ? closePanel() : openPanel()))
  // Scrim click closes the two layouts that draw one (1c slide-out, 1d modal). Inline has no scrim
  // and never closes, so it is excluded.
  root.addEventListener('click', (e) => {
    if (layout !== 'launcher' && !embed && open && e.target === root) closePanel()
  })

  const goto = (next: SupportView): void => {
    step = next
    renderStep()
  }

  // ---- data-layer wiring (all PURE-render inputs; this layer never fetches) --------

  const asPromise = <T>(v: Promise<T> | T): Promise<T> => Promise.resolve(v)

  function teardownThreadSub(): void {
    try {
      threadSub?.unsubscribe()
    } catch {
      // ignore
    }
    threadSub = null
  }

  function teardownSubs(): void {
    teardownThreadSub()
    try {
      bgSub?.unsubscribe()
    } catch {
      // ignore
    }
    bgSub = null
  }

  /** Locally clear a ticket's unread (mirrors capture zeroing the counter on a thread read). */
  function markRowRead(id: string): void {
    let changed = false
    ticketRows = ticketRows.map((t) => {
      if (t.id === id && (t.unreadForUser ?? 0) > 0) {
        changed = true
        return { ...t, unreadForUser: 0 }
      }
      return t
    })
    if (changed) refreshBadge()
  }

  /** Reload the 2a list from the caller and re-render if we are showing it. */
  async function reloadTickets(): Promise<void> {
    if (!opts.onLoadTickets) return
    try {
      const rows = await asPromise(opts.onLoadTickets())
      if (destroyed || !Array.isArray(rows)) return
      ticketRows = [...rows]
      refreshBadge()
      // Repaint when the freshly-loaded list is on-screen: the 2a list, or the inline home surface
      // (frame 4a) whose conversations strip / unread pill read off `ticketRows`.
      if (open && (step === 'tickets' || step === 'home' || step === 'search')) renderStep()
    } catch {
      // ignore — keep the seeded rows
    }
  }

  /** Load a full thread for 2b, tracking the request so a stale resolve cannot clobber a newer one. */
  async function loadThread(id: string): Promise<void> {
    const mine = ++threadReq
    thread = null
    agentTyping = false
    renderStep()
    if (!opts.onLoadThread) return
    try {
      const t = await asPromise(opts.onLoadThread(id))
      if (destroyed || mine !== threadReq) return
      thread = t
    } catch {
      if (destroyed || mine !== threadReq) return
      thread = null
    }
    // Opening the thread reads it → clears its unread locally.
    markRowRead(id)
    if (open && step === 'thread') renderStep()
  }

  /** Subscribe the active thread to live updates: `onMessage` refetches it, `onTyping` toggles the
   *  2b typing indicator. (The refetch-ping SSE variant never fires `onTyping` today — reserved.) */
  function startThreadSub(id: string): void {
    teardownThreadSub()
    if (!opts.onSubscribe) return
    try {
      threadSub = opts.onSubscribe(id, {
        onMessage: () => {
          if (destroyed || activeTicketId !== id) return
          void loadThread(id)
        },
        onTyping: (typing) => {
          if (destroyed || activeTicketId !== id || step !== 'thread' || !open) return
          agentTyping = typing
          renderStep()
        },
        onError: () => {},
      })
    } catch {
      threadSub = null
    }
  }

  /** Open a specific ticket's 2b thread — navigates, loads, subscribes; opens the panel if closed. */
  function openTicket(id: string): void {
    activeTicketId = id
    step = 'thread'
    safe(() => opts.onTicketOpen?.({ id, number: rowFor(id)?.number }))
    dismissToast()
    if (!open) {
      openPanel() // renders the (loading) thread shell
    } else {
      renderStep()
    }
    void loadThread(id)
    startThreadSub(id)
  }

  // ---- 2c reply toast + background (badge) subscription ----------------------

  function dismissToast(): void {
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }
    if (toastEl) {
      try {
        toastEl.remove()
      } catch {
        // ignore
      }
      toastEl = null
    }
  }

  /** 2c in-app toast above the launcher on a reply-while-online. Auto-dismisses ~8s; click → 2b. */
  function showReplyToast(id: string): void {
    if (destroyed || typeof document === 'undefined') return
    dismissToast()
    const row = rowFor(id)
    const toast = el('div', `ckrm-toast ckrm-pos-${position}`)
    ;(toast as HTMLElement).setAttribute('role', 'button')
    ;(toast as HTMLElement).tabIndex = 0
    toast.setAttribute('aria-label', 'View new reply')
    const avatar = el('div', 'ckrm-toast-avatar', 'MK')
    const bodyCol = el('div', 'ckrm-toast-body')
    bodyCol.appendChild(
      el('div', 'ckrm-toast-title', `${opts.agentName ?? 'Support'}${COPY.repliedSuffix}`),
    )
    const preview = row?.snippet ?? row?.subject ?? ''
    if (preview) bodyCol.appendChild(el('div', 'ckrm-toast-preview', preview))
    bodyCol.appendChild(el('div', 'ckrm-toast-cta', COPY.toastCta))
    toast.appendChild(avatar)
    toast.appendChild(bodyCol)
    const activate = (): void => openTicket(id)
    toast.addEventListener('click', activate)
    toast.addEventListener('keydown', (e) => {
      const key = (e as KeyboardEvent).key
      if (key === 'Enter' || key === ' ') {
        e.preventDefault()
        activate()
      }
    })
    root.appendChild(toast)
    toastEl = toast
    toastTimer = setTimeout(dismissToast, 8000)
  }

  /** Watch the newest ticket in the background so a reply-while-online updates the badge + toasts,
   *  even with the panel closed. One subscription (to the newest ticket) — the open thread has its
   *  own. Wired for any user with a subscribable ticket: the SSE stream is per-ticket-token authed,
   *  and an anonymous user's this-browser tickets carry that token in the local store, so realtime
   *  works without identity (cross-device push still needs the deferred email link). */
  function startBackgroundSub(): void {
    if (!opts.onSubscribe) return
    const newest = newestTicket()
    if (!newest) return
    try {
      bgSub = opts.onSubscribe(newest.id, {
        onMessage: () => {
          if (destroyed) return
          void reloadTickets()
          // Toast only when we are not already reading that very thread.
          const viewing = open && step === 'thread' && activeTicketId === newest.id
          if (!viewing) showReplyToast(newest.id)
        },
        onError: () => {},
      })
    } catch {
      bgSub = null
    }
  }

  // ---- field widgets ----------------------------------------------------

  const noteFocus = (fieldId: string): void => {
    if (focused.has(fieldId)) return
    focused.add(fieldId)
    safe(() => opts.onFieldFocus?.(fieldId))
  }
  const noteEdit = (fieldId: string): void => {
    safe(() => opts.onFieldEdit?.(fieldId))
  }

  /** Wire the shared focus/input telemetry + answer write-back onto a control. */
  function bind(
    node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    fieldId: string,
    onValue: (value: string) => void,
  ): void {
    node.addEventListener('focus', () => noteFocus(fieldId))
    node.addEventListener('input', () => {
      onValue(node.value)
      noteEdit(fieldId)
      refreshSubmit()
    })
    // `<select>` fires `change`, not `input`, in older engines — listen to both.
    node.addEventListener('change', () => {
      onValue(node.value)
      refreshSubmit()
    })
  }

  /** 1c/1e-3 field group: an 11px/600 `#64748b` label above a r9 control. */
  function labelFor(field: Pick<SupportField, 'id' | 'label' | 'required'>, control: HTMLElement) {
    const wrap = el('div', 'ckrm-field')
    const label = el('label', 'ckrm-label', str(field.label, field.id))
    label.htmlFor = control.id
    if (field.required === true) {
      const req = el('span', 'ckrm-req', '*')
      req.setAttribute('aria-hidden', 'true')
      label.appendChild(req)
    }
    wrap.appendChild(label)
    wrap.appendChild(control)
    return wrap
  }

  function buildField(field: SupportField, index: number): HTMLElement {
    const id = `ckrm-f-${index}`
    switch (field.type) {
      case 'long_text': {
        const ta = el('textarea', 'ckrm-textarea')
        ta.id = id
        ta.rows = typeof field.rows === 'number' ? field.rows : 4
        ta.placeholder = str(field.placeholder, COPY.messagePlaceholder)
        if (field.maxLength) ta.maxLength = field.maxLength
        ta.required = isRequired(field)
        ta.value = str(answers[field.id])
        bind(ta, field.id, (v) => {
          answers[field.id] = v
        })
        return labelFor(field, ta)
      }
      case 'dropdown': {
        // 1c/1e-3 draw a select row with a 13×13 ChevronDown at the right edge.
        const wrap = el('div', 'ckrm-select-wrap')
        const select = el('select', 'ckrm-select')
        select.id = id
        select.required = isRequired(field)
        const placeholder = el('option', undefined, str(field.placeholder, 'Select…'))
        placeholder.value = ''
        select.appendChild(placeholder)
        for (const choice of Array.isArray(field.choices) ? field.choices : []) {
          const option = el('option', undefined, String(choice))
          option.value = String(choice)
          select.appendChild(option)
        }
        select.value = str(answers[field.id])
        bind(select, field.id, (v) => {
          answers[field.id] = v
        })
        wrap.appendChild(select)
        wrap.appendChild(icon('chevron-down', 13))
        const group = labelFor(field, wrap)
        // `labelFor` points the <label> at the wrapper's id; re-point it at the control.
        ;(group.firstChild as HTMLLabelElement).htmlFor = id
        return group
      }
      case 'file': {
        // 1c: a dashed dropzone with a 16×16 Paperclip. The real <input type=file> is visually
        // hidden but focusable, and the dropzone is its <label> — keyboard + SR reachable.
        const wrap = el('div', 'ckrm-field')
        const input = el('input', 'ckrm-drop-input')
        input.id = id
        input.type = 'file'
        if ((field.maxFiles ?? 1) > 1) input.multiple = true
        if (Array.isArray(field.accept) && field.accept.length > 0)
          input.accept = field.accept.join(',')
        const drop = el('label', 'ckrm-drop')
        drop.htmlFor = id
        drop.appendChild(icon('paperclip', 16))
        drop.appendChild(el('br'))
        drop.appendChild(document.createTextNode(str(field.label, COPY.attach)))
        const names = el('div', 'ckrm-drop-names')
        drop.appendChild(names)
        input.addEventListener('focus', () => noteFocus(field.id))
        input.addEventListener('change', () => {
          files[field.id] = Array.from(input.files ?? [])
          // The submitted answer is filled in by the caller with the storage keys the presign
          // upload returns; the filenames are only a client-side placeholder for the gate below.
          answers[field.id] = files[field.id].map((f) => f.name)
          names.textContent = files[field.id].map((f) => f.name).join(', ')
          noteEdit(field.id)
          refreshSubmit()
        })
        wrap.appendChild(input)
        wrap.appendChild(drop)
        return wrap
      }
      default: {
        // `short_text`, `email`, and any future/unknown type all render as a single-line input.
        const input = el('input', 'ckrm-input')
        input.id = id
        input.type = field.type === 'email' ? 'email' : 'text'
        if ('placeholder' in field && field.placeholder) input.placeholder = field.placeholder
        if ('maxLength' in field && field.maxLength) input.maxLength = field.maxLength
        input.required = isRequired(field)
        input.value = str(answers[field.id])
        bind(input, field.id, (v) => {
          answers[field.id] = v
        })
        return labelFor(field, input)
      }
    }
  }

  // ---- submit gate ------------------------------------------------------

  let submitBtn: HTMLButtonElement | null = null

  function canSubmit(): boolean {
    if (submitting) return false
    if (subject.trim() === '' || body.trim() === '') return false
    return fields.every((f) => !isRequired(f) || !isBlank(answers[f.id]))
  }

  function refreshSubmit(): void {
    if (submitBtn) submitBtn.disabled = !canSubmit()
  }

  async function doSubmit(): Promise<void> {
    if (destroyed || !canSubmit()) return
    submitting = true
    errorText = ''
    refreshSubmit()
    if (submitBtn) submitBtn.textContent = 'Sending…'
    const categoryField = fields.find((f) => f.id === 'category')
    const category =
      categoryField && !isBlank(answers.category) ? String(answers.category) : undefined
    const severity = deriveSeverity(category)
    let result: SupportSubmitResult
    try {
      result = await opts.onSubmit({
        subject: subject.trim(),
        body: body.trim(),
        ...(category ? { category } : {}),
        type: composeType,
        ...(severity ? { severity } : {}),
        fields: { ...answers },
        files: { ...files },
      })
    } catch {
      result = null
    }
    submitting = false
    if (destroyed) return
    if (result === null) {
      errorText = "We couldn't send that. Please try again."
      renderStep()
      return
    }
    ticketNumber = result && typeof result.number === 'number' ? result.number : undefined
    // Pull the freshly-created ticket into `ticketRows` so the 1b "Your conversations" row and the
    // 2a list surface it immediately on Close — without this, a first-time submitter can't reach
    // their new conversation until the widget is reloaded and re-seeds from the store.
    void reloadTickets()
    goto('confirmed')
  }

  // ---- chrome -----------------------------------------------------------

  /** Per-layout title/subtitle defaults (1b vs 1c vs 1d), overridable via `appearance.greeting`. */
  function headerCopy(): { title: string; subtitle?: string } {
    if (appearance.greeting) return { title: appearance.greeting }
    if (layout === 'modal') return { title: COPY.modalTitle, subtitle: COPY.modalSubtitle }
    if (layout === 'slide_out') return { title: COPY.contactTitle }
    return { title: COPY.launcherTitle, subtitle: COPY.launcherSubtitle }
  }

  /** 1b indigo header / 1c plain header / 1d modal header. */
  function header(title: string, subtitle?: string): HTMLElement {
    // `headerStyle` only swaps the launcher layout's header (accent ⇄ plain); slide_out/modal keep
    // their own header on every step because it holds their sole pointer-driven close affordance.
    const variant =
      layout === 'launcher'
        ? appearance.headerStyle === 'plain'
          ? 'ckrm-header-plain'
          : 'ckrm-header-accent'
        : layout === 'modal'
          ? 'ckrm-header-modal'
          : 'ckrm-header-plain'
    const wrap = el('div', `ckrm-header ${variant}`)
    const textCol = el('div')
    const h = el('h2', 'ckrm-title', title)
    h.id = TITLE_ID
    textCol.appendChild(h)
    if (subtitle) textCol.appendChild(el('p', 'ckrm-subtitle', subtitle))
    wrap.appendChild(textCol)
    const close = button('ckrm-close')
    close.setAttribute('aria-label', 'Close support')
    close.appendChild(icon('x', layout === 'modal' ? 17 : 16))
    close.addEventListener('click', closePanel)
    wrap.appendChild(close)
    return wrap
  }

  /** A visually-hidden <h2> so header-less 1e steps still name the dialog. */
  function srTitle(title: string): HTMLElement {
    const h = el('h2', 'ckrm-sr', title)
    h.id = TITLE_ID
    return h
  }

  function bodyEl(variant: string): HTMLElement {
    const node = el('div', `ckrm-body ${variant}`)
    if (errorText) {
      const err = el('p', 'ckrm-error', errorText)
      err.setAttribute('role', 'alert')
      node.appendChild(err)
    }
    return node
  }

  // ---- step 1: ask (frames 1b / 1d, with 1e-1's Suggested block) --------

  /** 1b/1d/1e-1 search row. The typed query seeds the ticket subject; ↵ escalates. */
  function searchRow(): HTMLElement {
    const row = el('div', 'ckrm-search')
    row.appendChild(icon('search', layout === 'modal' ? 16 : 15))
    const input = el('input', undefined)
    input.id = 'ckrm-ask'
    input.type = 'text'
    input.value = query
    input.placeholder = layout === 'modal' ? COPY.modalSearchPlaceholder : COPY.searchPlaceholder
    input.setAttribute('aria-label', input.placeholder)
    const enter = el('span', 'ckrm-enter', COPY.enter)
    enter.setAttribute('aria-hidden', 'true')
    enter.style.display = query === '' ? 'none' : ''
    input.addEventListener('focus', () => noteFocus('$ask'))
    input.addEventListener('input', () => {
      query = input.value
      // The query becomes the ticket subject (1e-3 shows it prefilled); the message stays empty.
      subject = query.slice(0, 300)
      enter.style.display = query === '' ? 'none' : ''
      noteEdit('$ask')
      toggleSuggested()
    })
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && query.trim() !== '') {
        e.preventDefault()
        goto('ticket')
      }
    })
    row.appendChild(input)
    row.appendChild(enter)
    return row
  }

  let suggestedBlock: HTMLElement | null = null
  function toggleSuggested(): void {
    if (suggestedBlock) suggestedBlock.style.display = query.trim() === '' ? 'none' : ''
  }

  /** 1e-1 "Suggested" rows. Inert — the help-centre index ships with the bot (deferred). */
  function suggestedList(): HTMLElement {
    const wrap = el('div', 'ckrm-suggest-list')
    wrap.appendChild(el('p', 'ckrm-eyebrow', COPY.suggested))
    for (const title of articleTitles().slice(0, 2)) {
      const row = button('ckrm-suggest', `${title} →`)
      row.disabled = true
      wrap.appendChild(row)
    }
    return wrap
  }

  /** Rows for 1d's "Popular articles" / 1e-1's "Suggested": the form's declared sources, or the
   *  design's sample titles when it declares none. */
  function articleTitles(): string[] {
    const fromSources = sources
      .map((s) => str(s.label) || str(s.value))
      .filter((s) => s !== '')
      .slice(0, 3)
    return fromSources.length > 0 ? fromSources : [...COPY.sampleArticles]
  }

  function actionRow(
    iconName: string,
    label: string,
    action: string,
    onClick?: () => void,
  ): HTMLButtonElement {
    const row = button('ckrm-action')
    row.setAttribute('data-action', action)
    row.appendChild(icon(iconName, 15))
    row.appendChild(el('span', undefined, label))
    if (onClick) row.addEventListener('click', onClick)
    else {
      row.disabled = true
      row.setAttribute('aria-disabled', 'true')
      row.appendChild(el('span', 'ckrm-soon', COPY.comingSoon))
    }
    return row
  }

  /** Step 1 — ask. 1b for launcher/slide-out, 1d for modal; both grow 1e-1's Suggested block. */
  function renderAsk(): void {
    const { title, subtitle } = headerCopy()
    panel.replaceChildren(header(title, subtitle))
    const isModal = layout === 'modal'
    const container = bodyEl(isModal ? 'ckrm-body-modal' : 'ckrm-body-home')

    container.appendChild(searchRow())

    suggestedBlock = suggestedList()
    container.appendChild(suggestedBlock)
    toggleSuggested()

    if (isModal) {
      // 1d — "Popular articles" chevron rows + a "Contact support" CTA.
      container.appendChild(el('p', 'ckrm-eyebrow', COPY.popularArticles))
      const list = el('div', 'ckrm-articles')
      for (const title2 of articleTitles()) {
        const row = button('ckrm-article')
        row.disabled = true
        row.appendChild(el('span', undefined, title2))
        row.appendChild(icon('chevron-right', 14))
        list.appendChild(row)
      }
      container.appendChild(list)

      const cta = button('ckrm-btn ckrm-btn-primary')
      cta.setAttribute('data-action', 'message')
      cta.appendChild(icon('message-square', 16))
      cta.appendChild(el('span', undefined, COPY.contactTitle))
      cta.addEventListener('click', () => {
        composeType = 'conversation'
        goto('ticket')
      })
      container.appendChild(cta)
    } else {
      // 1b — three action rows, then the "Powered by Clickroom" footer.
      const list = el('div', 'ckrm-action-list')
      // Answer bot deferred: rendered, disabled, badged — never reaches the `answer` step.
      list.appendChild(actionRow('bot', COPY.actionBot, 'bot'))
      list.appendChild(
        actionRow('message-square', COPY.actionMessage, 'message', () => {
          composeType = 'conversation'
          goto('ticket')
        }),
      )
      list.appendChild(
        actionRow('bug', COPY.actionBug, 'bug', () => {
          composeType = 'bug'
          // Legacy convention, deliberately KEPT — see `SupportSubmission.type`.
          if (fields.some((f) => f.id === 'category')) answers.category = 'Bug'
          goto('ticket')
        }),
      )
      container.appendChild(list)

      // 1b-revised: the "Your conversations" row (any user with ≥1 known ticket), set off
      // by a top border. Sits BELOW the three action rows, ABOVE the "Powered by" footer.
      if (showConvosRow()) container.appendChild(convosRow())

      // `hideBranding` drops the "Powered by Clickroom" footer entirely (paid white-label).
      if (!appearance.hideBranding) {
        const powered = el('p', 'ckrm-powered', COPY.poweredBy)
        powered.appendChild(el('b', undefined, COPY.poweredByBrand))
        container.appendChild(powered)
      }
    }

    panel.appendChild(container)
    submitBtn = null
  }

  /** 1b-revised "Your conversations" home row → navigates to the 2a list. The unread pill (18×18,
   *  NO ring) is hidden at zero unread. */
  function convosRow(): HTMLButtonElement {
    const row = button('ckrm-convos-row')
    row.setAttribute('data-action', 'conversations')
    row.appendChild(icon('message-square-more', 15))
    row.appendChild(el('span', 'ckrm-convos-label', COPY.yourConversations))
    const unread = currentUnread()
    if (unread > 0) row.appendChild(el('span', 'ckrm-pill', String(unread)))
    row.appendChild(icon('chevron-right', 14))
    ;(row.querySelector('svg:last-child') as SVGElement | null)?.classList.add(
      'ckrm-convos-chevron',
    )
    row.addEventListener('click', () => openTickets())
    return row
  }

  // ---- step 2: answer (frame 1e-2) — DEFERRED, inert --------------------

  function renderAnswer(): void {
    panel.replaceChildren(headerlessSteps ? srTitle(COPY.answerTitle) : header(COPY.answerTitle))
    const container = bodyEl('ckrm-body-answer')
    container.setAttribute('aria-disabled', 'true')

    const row = el('div', 'ckrm-answer')
    const avatar = el('div', 'ckrm-avatar')
    avatar.appendChild(icon('bot', 14))
    row.appendChild(avatar)
    const answer = el('p', 'ckrm-answer-text', COPY.answerLead)
    answer.appendChild(el('b', undefined, COPY.answerBold))
    answer.appendChild(document.createTextNode(COPY.answerTail))
    row.appendChild(answer)
    container.appendChild(row)

    const cite = el('div', 'ckrm-cite')
    cite.appendChild(icon('book-open', 13))
    const citeText = el('span', undefined, COPY.citedPrefix)
    citeText.appendChild(el('b', undefined, COPY.citedArticle))
    cite.appendChild(citeText)
    container.appendChild(cite)

    const choice = el('div', 'ckrm-choice')
    const solved = button('ckrm-btn ckrm-btn-solved', COPY.solved)
    // Deferred: there is no deflection signal to record yet, so the positive branch is inert.
    solved.disabled = true
    solved.setAttribute('aria-disabled', 'true')
    choice.appendChild(solved)
    const escalate = button('ckrm-btn ckrm-btn-escalate', COPY.stillNeedHelp)
    escalate.addEventListener('click', () => goto('ticket'))
    choice.appendChild(escalate)
    container.appendChild(choice)

    panel.appendChild(container)
    submitBtn = null
  }

  // ---- step 3: ticket (frame 1c full / 1e-3 compact) --------------------

  /** Split the declared fields into the design's order: Category first, then Subject, then the
   *  remaining text fields, the Message, and finally the file dropzone(s). */
  function orderedFields(): {
    category?: [SupportField, number]
    rest: [SupportField, number][]
    fileFields: [SupportField, number][]
  } {
    const indexed = fields.map((f, i) => [f, i] as [SupportField, number])
    const category = indexed.find(([f]) => f.id === 'category' && f.type === 'dropdown')
    const fileFields = indexed.filter(([f]) => f.type === 'file')
    const rest = indexed.filter(([f]) => f !== category?.[0] && f.type !== 'file')
    return { category, rest, fileFields }
  }

  function contextNotice(compact: boolean): HTMLElement | null {
    if (!tracking?.identity && !tracking?.recentEvents) return null
    const note = el('div', 'ckrm-notice')
    note.appendChild(icon(compact ? 'calendar-check' : 'shield', compact ? 14 : 15))
    note.appendChild(el('span', undefined, COPY.notice))
    return note
  }

  /** Append the ticket-composition fields (Category → Subject → rest → Message → files → context
   *  notice) to `container`, wire their telemetry + answer write-back, create the submit button
   *  (assigned to `submitBtn`) and RETURN it so the caller can place it (sticky footer vs inline).
   *  Shared by the FAB 1c/1e-3 form (`renderTicket`) and the inline compose pane (frame 3a). */
  function buildTicketFields(container: HTMLElement, compact: boolean): HTMLButtonElement {
    const { category, rest, fileFields } = orderedFields()
    if (category) container.appendChild(buildField(category[0], category[1]))

    const subjectInput = el('input', 'ckrm-input')
    subjectInput.id = 'ckrm-subject'
    subjectInput.type = 'text'
    subjectInput.maxLength = 300
    subjectInput.required = true
    subjectInput.value = subject
    subjectInput.placeholder = COPY.subjectPlaceholder
    subjectInput.addEventListener('focus', () => noteFocus('$subject'))
    subjectInput.addEventListener('input', () => {
      subject = subjectInput.value
      noteEdit('$subject')
      refreshSubmit()
    })
    container.appendChild(
      labelFor({ id: '$subject', label: COPY.subjectLabel, required: true }, subjectInput),
    )

    for (const [field, index] of rest) container.appendChild(buildField(field, index))

    const message = el('textarea', 'ckrm-textarea')
    message.id = 'ckrm-body'
    message.required = true
    message.value = body
    message.placeholder = COPY.messagePlaceholder
    message.addEventListener('focus', () => noteFocus('$body'))
    message.addEventListener('input', () => {
      body = message.value
      noteEdit('$body')
      refreshSubmit()
    })
    container.appendChild(
      labelFor({ id: '$body', label: COPY.messageLabel, required: true }, message),
    )

    for (const [field, index] of fileFields) container.appendChild(buildField(field, index))

    const notice = contextNotice(compact)
    if (notice) container.appendChild(notice)

    const send = button('ckrm-btn ckrm-btn-primary', COPY.submit)
    send.addEventListener('click', () => {
      void doSubmit()
    })
    submitBtn = send
    return send
  }

  function renderTicket(): void {
    const compact = headerlessSteps
    if (compact) panel.replaceChildren()
    else panel.replaceChildren(header(COPY.escalateTitle))
    const container = bodyEl(
      compact ? 'ckrm-body-compact' : layout === 'modal' ? 'ckrm-body-modal' : 'ckrm-body-form',
    )
    if (compact) {
      // 1e-3: the form title (14px/600) replaces the header bar and names the dialog.
      const heading = el('h2', 'ckrm-title ckrm-form-title', COPY.escalateTitle)
      heading.id = TITLE_ID
      container.appendChild(heading)
    }

    const send = buildTicketFields(container, compact)

    if (compact || layout === 'modal') {
      // 1e-3 / 1d: the CTA scrolls with the body.
      const actions = el('div', 'ckrm-actions')
      actions.appendChild(send)
      container.appendChild(actions)
      panel.appendChild(container)
    } else {
      // 1c: sticky footer, `padding:14px 18px; border-top:1px solid #eceef2`.
      panel.appendChild(container)
      const footer = el('div', 'ckrm-footer ckrm-actions')
      footer.appendChild(send)
      panel.appendChild(footer)
    }
    refreshSubmit()
  }

  // ---- step 4: confirmed (frame 1e-4) -----------------------------------

  /** The 1e-4 "How was this experience?" CSAT radiogroup, appended to whichever confirmation
   *  surface is being built. Shared by the FAB `confirmed` step and inline's confirmed pane — the
   *  surface spec: "CSAT after resolve applies unchanged in inline mode", so `$support_csat` has to be
   *  reachable from a page mount too. Markup/classes/roles are identical on both. */
  function appendCsat(container: HTMLElement): void {
    const csatLabel = el('p', 'ckrm-hint', 'How was this experience?')
    csatLabel.id = 'ckrm-csat-label'
    csatLabel.style.marginTop = '16px'
    container.appendChild(csatLabel)

    const csat = el('div', 'ckrm-csat')
    csat.setAttribute('role', 'radiogroup')
    csat.setAttribute('aria-labelledby', csatLabel.id)
    for (let score = 1; score <= 5; score += 1) {
      const btn = button('', String(score))
      btn.setAttribute('role', 'radio')
      btn.setAttribute('aria-label', `${score} out of 5`)
      btn.setAttribute('aria-checked', String(csatScore === score))
      btn.setAttribute('aria-pressed', String(csatScore === score))
      btn.addEventListener('click', () => {
        // One score per confirmation — re-clicking must not mint a second `$support_csat`.
        if (csatScore !== null) return
        csatScore = score
        for (const node of Array.from(csat.children) as HTMLElement[]) {
          const on = node === btn
          node.setAttribute('aria-checked', String(on))
          node.setAttribute('aria-pressed', String(on))
        }
        safe(() => opts.onCsat?.(score))
      })
      csat.appendChild(btn)
    }
    container.appendChild(csat)
  }

  function renderConfirmed(): void {
    const title =
      typeof ticketNumber === 'number' ? COPY.confirmedTitleWith(ticketNumber) : COPY.confirmedTitle
    if (headerlessSteps) panel.replaceChildren()
    else panel.replaceChildren(header(title))
    const container = bodyEl('ckrm-body-confirmed')
    container.setAttribute('role', 'status')

    const circle = el('div', 'ckrm-success')
    circle.appendChild(icon('check', 26, 2.4))
    container.appendChild(circle)

    // 1e-4's `15px/600` title doubles as the dialog's accessible name on the header-less layout.
    const heading = el('h2', 'ckrm-confirm-title', title)
    if (headerlessSteps) heading.id = TITLE_ID
    container.appendChild(heading)
    container.appendChild(el('p', 'ckrm-confirm-body', appearance.thanksMessage))
    container.appendChild(el('p', 'ckrm-footnote', COPY.firstReply))

    appendCsat(container)

    const done = button('ckrm-btn ckrm-btn-ghost', 'Close')
    done.addEventListener('click', closePanel)
    container.appendChild(done)

    panel.appendChild(container)
    submitBtn = null
  }

  // ---- 2a: "My tickets" list (frame 2a) ---------------------------------

  /** Navigate to the 2a list — refreshes it from the caller in the background. */
  function openTickets(): void {
    step = 'tickets'
    if (!open) openPanel()
    else renderStep()
    void reloadTickets()
  }

  /** An accent header with a back arrow + a title/subtitle block + a close X. Used by 2a and 2b. */
  function convoHeader(
    title: string,
    subtitle: string | undefined,
    onBack: () => void,
    subtitleNode?: HTMLElement,
  ): HTMLElement {
    const wrap = el('div', 'ckrm-header ckrm-header-accent')
    wrap.style.alignItems = 'center'
    const back = button('ckrm-close')
    back.setAttribute('aria-label', 'Back')
    back.appendChild(icon('arrow-left', 16))
    back.addEventListener('click', onBack)
    wrap.appendChild(back)
    const textCol = el('div', 'ckrm-title-sub')
    textCol.style.flex = '1'
    textCol.style.minWidth = '0'
    const h = el('h2', 'ckrm-title', title)
    h.id = TITLE_ID
    textCol.appendChild(h)
    if (subtitleNode) textCol.appendChild(subtitleNode)
    else if (subtitle) textCol.appendChild(el('p', 'ckrm-subtitle', subtitle))
    wrap.appendChild(textCol)
    const close = button('ckrm-close')
    close.setAttribute('aria-label', 'Close support')
    close.appendChild(icon('x', 16))
    close.addEventListener('click', closePanel)
    wrap.appendChild(close)
    return wrap
  }

  function ticketRow(row: SupportTicketRow): HTMLButtonElement {
    const unread = (row.unreadForUser ?? 0) > 0
    const btn = button(`ckrm-ticket-row${unread ? ' ckrm-unread' : ''}`)
    const cat = categoryStyle(row.category)
    const sq = el('div', 'ckrm-ticket-sq')
    sq.style.background = cat.tint
    const catIcon = icon(cat.icon, 14)
    catIcon.style.stroke = cat.stroke
    sq.appendChild(catIcon)
    btn.appendChild(sq)

    const bodyCol = el('div', 'ckrm-ticket-body')
    const titleRow = el('div', 'ckrm-ticket-titlerow')
    titleRow.appendChild(el('span', 'ckrm-ticket-subject', str(row.subject, 'Conversation')))
    if (unread) {
      const dot = el('span', 'ckrm-ticket-dot')
      dot.setAttribute('aria-hidden', 'true')
      titleRow.appendChild(dot)
    }
    bodyCol.appendChild(titleRow)

    if (row.snippet) bodyCol.appendChild(el('div', 'ckrm-ticket-snippet', row.snippet))

    const meta = el('div', 'ckrm-ticket-meta')
    const label = statusLabelFor(row.status, row.unreadForUser ?? 0)
    const chipStyle = STATUS_CHIP[label]
    const chip = el('span', 'ckrm-status-chip', label)
    chip.style.color = chipStyle.color
    chip.style.background = chipStyle.bg
    meta.appendChild(chip)
    const bug = bugChipFor(row, 'ckrm-status-chip')
    if (bug) meta.appendChild(bug)
    if (typeof row.number === 'number')
      meta.appendChild(el('span', 'ckrm-ticket-id', `#${row.number}`))
    const time = row.timeLabel ?? relTime(row.createdAt)
    if (time) meta.appendChild(el('span', 'ckrm-ticket-time', time))
    bodyCol.appendChild(meta)

    btn.appendChild(bodyCol)
    btn.addEventListener('click', () => openTicket(row.id))
    return btn
  }

  function renderTickets(): void {
    panel.replaceChildren(convoHeader(COPY.ticketsTitle, COPY.ticketsSubtitle, () => goto('ask')))
    const listWrap = el('div', 'ckrm-body ckrm-tickets-list')
    if (ticketRows.length === 0) {
      listWrap.appendChild(el('p', 'ckrm-tickets-empty', 'No conversations yet.'))
    } else {
      for (const row of ticketRows) listWrap.appendChild(ticketRow(row))
    }
    panel.appendChild(listWrap)

    const footer = el('div', 'ckrm-tickets-footer')
    const newBtn = button('ckrm-new-convo')
    newBtn.setAttribute('data-action', 'new-conversation')
    newBtn.appendChild(icon('plus', 15))
    newBtn.appendChild(el('span', undefined, COPY.newConversation))
    newBtn.addEventListener('click', () => goto('ask'))
    footer.appendChild(newBtn)
    panel.appendChild(footer)
    submitBtn = null
  }

  // ---- 2b: conversation thread (frame 2b) -------------------------------

  /** One message bubble (+ author row on first-of-run, + attachment chip, + timestamp). */
  function messageEl(m: SupportTicketMessage, showAuthor: boolean): HTMLElement {
    if (m.authorType === 'system') {
      return el('div', 'ckrm-msg-system', m.body)
    }
    const isUser = m.authorType === 'user'
    const wrap = el('div', `ckrm-msg ${isUser ? 'ckrm-msg-end' : 'ckrm-msg-start'}`)

    if (!isUser && showAuthor) {
      const isAi = m.authorType === 'ai'
      const authorRow = el('div', 'ckrm-author-row')
      const avatar = el('div', 'ckrm-msg-avatar')
      // AI is distinguished by the AVATAR ONLY: violet #A78BFA + "AI". Human agent → accent + initials.
      const name = isAi ? COPY.aiAuthor : (opts.agentName ?? COPY.agentFallbackName)
      avatar.style.background = isAi ? '#A78BFA' : appearance.primaryColor
      avatar.style.color = '#fff'
      avatar.textContent = isAi ? 'AI' : initialsOf(name)
      authorRow.appendChild(avatar)
      authorRow.appendChild(el('span', 'ckrm-author-name', name))
      authorRow.appendChild(el('span', 'ckrm-author-role', isAi ? COPY.aiRole : COPY.agentRole))
      wrap.appendChild(authorRow)
    }

    const bubble = el(
      'div',
      `ckrm-bubble ${isUser ? 'ckrm-bubble-user' : 'ckrm-bubble-agent'}`,
      m.body,
    )
    wrap.appendChild(bubble)

    const time = clockTime(m.createdAt)
    if (time) wrap.appendChild(el('div', 'ckrm-msg-time', time))
    return wrap
  }

  /** The descending-grey three-dot typing indicator at the thread tail. */
  function typingIndicator(): HTMLElement {
    const row = el('div', 'ckrm-typing')
    row.setAttribute('aria-live', 'polite')
    row.setAttribute('aria-label', `${opts.agentName ?? COPY.agentFallbackName} is typing`)
    const avatar = el('div', 'ckrm-typing-avatar', 'MK')
    const dots = el('div', 'ckrm-typing-dots')
    dots.appendChild(el('span'))
    dots.appendChild(el('span'))
    dots.appendChild(el('span'))
    row.appendChild(avatar)
    row.appendChild(dots)
    return row
  }

  /** The scrolling messages region (Today divider + bubbles + typing tail). Shared by the FAB 2b
   *  thread and the inline thread pane — only the wrapper class (hence bg/padding) differs. Caller
   *  pins `scrollTop` after it is in the DOM. */
  function buildThreadMessages(cls: string): HTMLElement {
    const threadEl = el('div', cls)
    threadEl.appendChild(el('div', 'ckrm-date-divider', COPY.today))
    const messages = thread && Array.isArray(thread.messages) ? thread.messages : []
    let prevAuthor: string | null = null
    for (const m of messages) {
      // First-of-run: author row shows only when the author changes from the previous message.
      const key = m.authorType
      const showAuthor = key !== prevAuthor
      prevAuthor = key
      threadEl.appendChild(messageEl(m, showAuthor))
    }
    if (agentTyping) threadEl.appendChild(typingIndicator())
    return threadEl
  }

  /** The pinned-bottom composer (input row + optional state/mark-solved footer). Shared by the FAB
   *  2b thread and the inline thread pane. Inline drops the footer (`withFooter: false`) because it
   *  surfaces the ticket id/status + "Mark as solved" in the pane header instead (frame 3a). */
  function buildComposer(withFooter: boolean, solved: boolean, number?: number): HTMLElement {
    const composer = el('div', 'ckrm-composer')
    const inputRow = el('div', 'ckrm-composer-input')
    const input = el('input', undefined)
    input.type = 'text'
    input.id = 'ckrm-reply'
    input.placeholder = COPY.composerPlaceholder
    input.setAttribute('aria-label', COPY.composerPlaceholder)
    const attach = icon('paperclip', 16)
    const send = button('ckrm-composer-send')
    send.setAttribute('aria-label', 'Send reply')
    send.appendChild(icon('send', 14))
    const doReply = (): void => {
      const value = input.value.trim()
      if (value === '' || !activeTicketId) return
      sendReply(activeTicketId, value)
      input.value = ''
    }
    send.addEventListener('click', doReply)
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault()
        doReply()
      }
    })
    inputRow.appendChild(input)
    inputRow.appendChild(attach)
    inputRow.appendChild(send)
    composer.appendChild(inputRow)

    if (withFooter) {
      const footer = el('div', 'ckrm-composer-footer')
      const state = solved ? COPY.ticketStateSolved : COPY.ticketStateOpen
      const stateText =
        typeof number === 'number' ? `${COPY.ticketNoWith(number)} · ${state}` : state
      footer.appendChild(el('span', 'ckrm-ticket-state', stateText))
      if (!solved) {
        const mark = button('ckrm-mark-solved', COPY.markSolvedLabel)
        mark.setAttribute('data-action', 'mark-solved')
        mark.addEventListener('click', () => {
          if (activeTicketId) markThreadSolved(activeTicketId)
        })
        footer.appendChild(mark)
      }
      composer.appendChild(footer)
    }
    return composer
  }

  function renderThread(): void {
    const row = rowFor(activeTicketId)
    const subject = str(thread?.subject, str(row?.subject, 'Conversation'))
    const number = thread?.number ?? row?.number
    const solved = isSolvedStatus(thread?.status)

    const presence = el('div', 'ckrm-presence')
    presence.appendChild(el('span', 'ckrm-presence-dot'))
    presence.appendChild(
      el('span', 'ckrm-presence-text', opts.presenceLabel ?? COPY.presenceFallback),
    )
    panel.replaceChildren(convoHeader(subject, undefined, () => openTickets(), presence))

    // Middle region — the only scrolling one (header + composer are fixed).
    const threadEl = buildThreadMessages('ckrm-thread')
    panel.appendChild(threadEl)
    // Pin to the latest message.
    threadEl.scrollTop = threadEl.scrollHeight

    panel.appendChild(buildComposer(true, solved, number))
    submitBtn = null
  }

  /** Optimistically append the user's reply to the thread, then POST it. A reply on a solved ticket
   *  reopens it (capture does this server-side; mirror it locally so the footer flips immediately). */
  function sendReply(id: string, bodyText: string): void {
    const stamp = new Date().toISOString()
    const optimistic: SupportTicketMessage = {
      authorType: 'user',
      body: bodyText,
      createdAt: stamp,
    }
    if (thread && thread.id === id) {
      thread = {
        ...thread,
        status: isSolvedStatus(thread.status) ? 'open' : thread.status,
        messages: [...(thread.messages ?? []), optimistic],
      }
    }
    if (open && step === 'thread') renderThread()
    if (opts.onAppendMessage) void asPromise(opts.onAppendMessage(id, bodyText)).catch(() => {})
  }

  /** Mark the active thread solved via the caller, flipping the footer optimistically. */
  function markThreadSolved(id: string): void {
    if (thread && thread.id === id) {
      thread = { ...thread, status: 'solved' }
      if (open && step === 'thread') renderThread()
    }
    ticketRows = ticketRows.map((t) => (t.id === id ? { ...t, status: 'solved' } : t))
    if (opts.onMarkSolved) void asPromise(opts.onMarkSolved(id)).catch(() => {})
  }

  // ---- inline (page) surface: two-pane master-detail (3a) + stacked collapse (3b) --------------

  /** Inline page header title/subtitle. Title = `appearance.greeting` (falls back to "Support");
   *  subtitle = greeting-derived design copy. */
  const inlineHeaderCopy = (): { title: string; subtitle: string } => ({
    title: appearance.greeting || 'Support',
    subtitle: 'Your conversations with our team',
  })

  /** The 3a/3b page header: a back arrow to the 4a home surface + the title/subtitle block. The
   *  back arrow is the page-level "leave conversations", distinct from the stacked thread's own
   *  2a→2b back (which returns to the list); it is omitted when home is not a reachable surface. */
  function inlineHeader(cls: string): HTMLElement {
    const { title, subtitle } = inlineHeaderCopy()
    const head = el('div', cls)
    if (embed) {
      const back = button('ckrm-inline-back')
      back.setAttribute('aria-label', 'Back to help')
      back.appendChild(icon('arrow-left', 16))
      back.addEventListener('click', () => goto('home'))
      head.appendChild(back)
    }
    const textCol = el('div', 'ckrm-inline-headtext')
    const h = el('h2', 'ckrm-inline-title', title)
    h.id = TITLE_ID
    textCol.appendChild(h)
    textCol.appendChild(el('p', 'ckrm-inline-subtitle', subtitle))
    head.appendChild(textCol)
    return head
  }

  /** The "Powered by Clickroom" branding footer, pinned to the container bottom. Dropped entirely
   *  when `hideBranding` is set (paid white-label) — frames 3a/3b. */
  function inlineBranding(): HTMLElement | null {
    if (appearance.hideBranding) return null
    const foot = el('div', 'ckrm-inline-branding')
    foot.appendChild(document.createTextNode(COPY.poweredBy))
    foot.appendChild(el('b', undefined, COPY.poweredByBrand))
    return foot
  }

  /** A list-rail row (frame 3a: 26px r7 square, subject + unread dot, snippet, status chip + time).
   *  The 2px accent left rail on the selected row is drawn via CSS `::before`. */
  function inlineTicketRow(row: SupportTicketRow): HTMLButtonElement {
    const unread = (row.unreadForUser ?? 0) > 0
    const selected = row.id === activeTicketId && step === 'thread'
    const btn = button(`ckrm-inline-row${selected ? ' ckrm-inline-selected' : ''}`)
    const cat = categoryStyle(row.category)
    const sq = el('div', 'ckrm-inline-sq')
    sq.style.background = cat.tint
    const catIcon = icon(cat.icon, 13)
    catIcon.style.stroke = cat.stroke
    sq.appendChild(catIcon)
    btn.appendChild(sq)

    const bodyCol = el('div', 'ckrm-inline-rowbody')
    const top = el('div', 'ckrm-inline-rowtop')
    top.appendChild(el('span', 'ckrm-inline-subject', str(row.subject, 'Conversation')))
    if (unread) {
      const dot = el('span', 'ckrm-inline-dot')
      dot.setAttribute('aria-hidden', 'true')
      top.appendChild(dot)
    }
    bodyCol.appendChild(top)
    if (row.snippet) bodyCol.appendChild(el('div', 'ckrm-inline-snippet', row.snippet))

    const meta = el('div', 'ckrm-inline-meta')
    const label = statusLabelFor(row.status, row.unreadForUser ?? 0)
    const chipStyle = STATUS_CHIP[label]
    const chip = el('span', 'ckrm-inline-chip', label)
    chip.style.color = chipStyle.color
    chip.style.background = chipStyle.bg
    meta.appendChild(chip)
    const bug = bugChipFor(row, 'ckrm-inline-chip')
    if (bug) meta.appendChild(bug)
    const time = row.timeLabel ?? relTime(row.createdAt)
    if (time) meta.appendChild(el('span', 'ckrm-inline-time', time))
    bodyCol.appendChild(meta)

    btn.appendChild(bodyCol)
    btn.addEventListener('click', () => openTicket(row.id))
    return btn
  }

  /** The "New conversation" button (list rail + empty state). */
  function inlineNewButton(): HTMLButtonElement {
    const b = button('ckrm-inline-new')
    b.setAttribute('data-action', 'new-conversation')
    b.appendChild(icon('plus', 14))
    b.appendChild(el('span', undefined, COPY.newConversation))
    b.addEventListener('click', () => goto('ticket'))
    return b
  }

  /** The list rail (frame 3a): New conversation button above a scrolling list of the user's rows. */
  function inlineRail(): HTMLElement {
    const rail = el('div', 'ckrm-inline-rail')
    const newWrap = el('div', 'ckrm-inline-newwrap')
    newWrap.appendChild(inlineNewButton())
    rail.appendChild(newWrap)
    const rows = el('div', 'ckrm-inline-rows')
    if (ticketRows.length === 0) {
      rows.appendChild(el('p', 'ckrm-tickets-empty', 'No conversations yet.'))
    } else {
      for (const row of ticketRows) rows.appendChild(inlineTicketRow(row))
    }
    rail.appendChild(rows)
    return rail
  }

  /** Thread-pane header (frame 3a): subject + green-dot presence + mono ticket id/status, and (in
   *  two-pane) a "Mark as solved" action at the right. `back` adds the stacked back arrow. */
  function inlinePaneHeader(twoPane: boolean, back?: () => void): HTMLElement {
    const row = rowFor(activeTicketId)
    const subject = str(thread?.subject, str(row?.subject, 'Conversation'))
    const number = thread?.number ?? row?.number
    const solved = isSolvedStatus(thread?.status)

    const head = el('div', 'ckrm-inline-pane-header')
    if (back) {
      const b = button('ckrm-close')
      b.setAttribute('aria-label', 'Back')
      b.appendChild(icon('arrow-left', 16))
      b.addEventListener('click', back)
      head.appendChild(b)
    }
    const textCol = el('div')
    textCol.style.flex = '1'
    textCol.style.minWidth = '0'
    const h = el('h2', 'ckrm-inline-pane-subject', subject)
    h.id = TITLE_ID
    textCol.appendChild(h)
    const presence = el('div', 'ckrm-inline-presence')
    presence.appendChild(el('span', 'ckrm-inline-presence-dot'))
    presence.appendChild(
      el('span', 'ckrm-inline-presence-text', opts.presenceLabel ?? COPY.presenceFallback),
    )
    textCol.appendChild(presence)
    const state = solved ? COPY.ticketStateSolved : COPY.ticketStateOpen
    const idText = typeof number === 'number' ? `#${number} · ${state}` : state
    textCol.appendChild(el('div', 'ckrm-inline-ticketmeta', idText))
    head.appendChild(textCol)

    if (twoPane && !solved) {
      const mark = button('ckrm-inline-solve', COPY.markSolvedLabel)
      mark.setAttribute('data-action', 'mark-solved')
      mark.addEventListener('click', () => {
        if (activeTicketId) markThreadSolved(activeTicketId)
      })
      head.appendChild(mark)
    }
    return head
  }

  /** The thread-pane content (header + scrolling messages + composer). `twoPane` drops the composer
   *  footer (mark-solved lives in the header) and omits the back arrow. */
  function inlinePaneThread(twoPane: boolean): HTMLElement {
    const pane = el('div', 'ckrm-inline-pane')
    const solved = isSolvedStatus(thread?.status)
    const row = rowFor(activeTicketId)
    const number = thread?.number ?? row?.number
    pane.appendChild(inlinePaneHeader(twoPane, twoPane ? undefined : () => goto('tickets')))
    const msgs = buildThreadMessages('ckrm-thread ckrm-inline-messages')
    pane.appendChild(msgs)
    pane.appendChild(buildComposer(!twoPane, solved, number))
    // Pin to the latest message once painted (RAF so the pane is laid out first).
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        msgs.scrollTop = msgs.scrollHeight
      })
    } else {
      msgs.scrollTop = msgs.scrollHeight
    }
    return pane
  }

  /** The compose pane: "New conversation" heading + the shared ticket form (frame 3a New button). */
  function inlinePaneCompose(twoPane: boolean): HTMLElement {
    const pane = el('div', 'ckrm-inline-pane')
    const head = el('div', 'ckrm-inline-pane-header')
    if (!twoPane) {
      const b = button('ckrm-close')
      b.setAttribute('aria-label', 'Back')
      b.appendChild(icon('arrow-left', 16))
      b.addEventListener('click', () => goto('tickets'))
      head.appendChild(b)
    }
    const h = el('h2', 'ckrm-inline-pane-subject', COPY.newConversation)
    h.id = TITLE_ID
    head.appendChild(h)
    pane.appendChild(head)

    const container = bodyEl('ckrm-inline-compose')
    const send = buildTicketFields(container, false)
    const actions = el('div', 'ckrm-actions')
    actions.appendChild(send)
    container.appendChild(actions)
    pane.appendChild(container)
    refreshSubmit()
    return pane
  }

  /** The confirmed pane after a ticket is filed inside inline mode. */
  function inlinePaneConfirmed(): HTMLElement {
    const pane = el('div', 'ckrm-inline-pane')
    const title =
      typeof ticketNumber === 'number' ? COPY.confirmedTitleWith(ticketNumber) : COPY.confirmedTitle
    const container = el('div', 'ckrm-inline-empty')
    container.setAttribute('role', 'status')
    const circle = el('div', 'ckrm-success')
    circle.appendChild(icon('check', 26, 2.4))
    container.appendChild(circle)
    const h = el('h2', 'ckrm-confirm-title', title)
    h.id = TITLE_ID
    container.appendChild(h)
    container.appendChild(el('p', 'ckrm-confirm-body', appearance.thanksMessage))
    // Same radiogroup the FAB draws — inline never reaches `renderConfirmed`, so without this
    // `onCsat` could never fire from a page mount.
    appendCsat(container)
    const backBtn = button('ckrm-inline-new')
    backBtn.appendChild(el('span', undefined, COPY.ticketsTitle))
    backBtn.addEventListener('click', () => goto('tickets'))
    container.appendChild(backBtn)
    pane.appendChild(container)
    submitBtn = null
    return pane
  }

  /** The empty thread pane (no conversation selected): centered icon + prompt + New conversation. */
  function inlinePaneEmpty(): HTMLElement {
    const pane = el('div', 'ckrm-inline-pane')
    const empty = el('div', 'ckrm-inline-empty')
    empty.appendChild(icon('message-square-more', 30))
    empty.appendChild(el('p', 'ckrm-inline-empty-text', 'Select a conversation'))
    empty.appendChild(inlineNewButton())
    pane.appendChild(empty)
    submitBtn = null
    return pane
  }

  /** Which pane the current `step` maps onto in inline mode. */
  const inlinePaneMode = (): 'thread' | 'compose' | 'confirmed' | 'empty' => {
    if (step === 'thread' && activeTicketId) return 'thread'
    if (step === 'ticket' || step === 'ask' || step === 'answer') return 'compose'
    if (step === 'confirmed') return 'confirmed'
    return 'empty'
  }

  function inlinePane(twoPane: boolean): HTMLElement {
    switch (inlinePaneMode()) {
      case 'thread':
        return inlinePaneThread(twoPane)
      case 'compose':
        return inlinePaneCompose(twoPane)
      case 'confirmed':
        return inlinePaneConfirmed()
      default:
        return inlinePaneEmpty()
    }
  }

  // ---- inline (page) HOME surface: frame 4a (search-first) --------------------------------------

  /** The home posture: `'search'` leads with the hero + docs search; `'conversations'` drops the
   *  hero. ONLY an explicit `home: 'conversations'` forces it — the "no docs source ⇒ drop the
   *  hero" auto-fallback is deliberately disabled for now, because the builder cannot yet connect a
   *  source, so keying off `sources` would hide the hero for every real tenant. */
  const homePosture = (): 'search' | 'conversations' =>
    // An explicit navigation to the search surface (⌘K, `view: 'search'`) always draws the hero.
    step === 'search' || opts.home !== 'conversations' ? 'search' : 'conversations'

  /** The full docs-article list for the home surface: the form's declared sources (uncapped, and
   *  carrying NO meta — a source has no read-time and we never fabricate one), or the design's
   *  sample rows (title + literal read-time) when it declares none. */
  const homeArticles = (): { title: string; meta?: string }[] => {
    const fromSources = sources
      .map((s) => str(s.label) || str(s.value))
      .filter((t) => t !== '')
      .map((title) => ({ title }))
    return fromSources.length > 0 ? fromSources : COPY.sampleArticleRows.map((r) => ({ ...r }))
  }

  /** The first `http(s)` source url, for the "Browse all" / article-row links. */
  const helpCenterUrl = (): string | undefined =>
    sources.map((s) => str(s.value)).find((v) => /^https?:\/\//i.test(v))

  const openUrl = (url?: string): void => {
    if (url && typeof window !== 'undefined') {
      try {
        window.open(url, '_blank', 'noopener,noreferrer')
      } catch {
        // ignore
      }
    }
  }

  /** One channel card (frame 4a): tinted 32px icon square + title + description. `action` is the
   *  stable `data-action` hook (kept independent of `iconName`, which follows the design's glyph). */
  function homeCard(
    action: string,
    iconName: string,
    tintBg: string,
    stroke: string,
    title: string,
    desc: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const card = button('ckrm-home-card')
    card.setAttribute('data-action', action)
    const sq = el('span', 'ckrm-home-card-icon')
    sq.style.background = tintBg
    const ic = icon(iconName, 16)
    ic.style.stroke = stroke
    sq.appendChild(ic)
    card.appendChild(sq)
    card.appendChild(el('div', 'ckrm-home-card-title', title))
    card.appendChild(el('div', 'ckrm-home-card-desc', desc))
    card.addEventListener('click', onClick)
    return card
  }

  /** The `category` option that reads as a plain question/message. : every channel card
   *  lands on a form with `category` already set, so card 2 presets the declared question-ish
   *  option (case-insensitive, first match wins) instead of clearing the field. Undefined when the
   *  form declares no such option — then the field is left unset rather than invented. */
  const messageCategory = (): string | undefined => {
    const field = fields.find((f) => f.id === 'category')
    const declared = field?.type === 'dropdown' && Array.isArray(field.choices) ? field.choices : []
    return declared.map(String).find((c) => /question|message|general/i.test(c))
  }

  /** The three channel cards. Each presets the ticket `category` so one shared compose form serves
   *  all three intents: AI assistant → the bot page; Send a message → the question-ish category +
   *  compose; Report a bug → preset `category='Bug'` (only if the form declares one, mirroring
   *  renderAsk) + compose.
   *
   *  Tints/strokes are the design's `channels[]` values. Cards 1 and 3 are fixed, brand-independent
   *  hues (literal rgba, not hex approximations); card 2 is the accent, so it stays tokenised off
   *  `primaryColor` — at the default `#4F46E5` that is exactly the design's `rgba(79,70,229,.1)`. */
  function homeCards(): HTMLElement {
    const grid = el('div', 'ckrm-home-cards')
    const accentRgb = rgbOf(appearance.primaryColor)
    grid.appendChild(
      homeCard(
        'bot',
        'bot',
        'rgba(167,139,250,.12)',
        '#A78BFA',
        COPY.actionBot,
        COPY.cardBotDesc,
        () => goto('bot'),
      ),
    )
    grid.appendChild(
      homeCard(
        'message-square',
        'message-square',
        `rgba(${accentRgb},.1)`,
        appearance.primaryColor,
        COPY.actionMessage,
        COPY.cardMessageDesc,
        () => {
          composeType = 'conversation'
          const preset = messageCategory()
          if (preset) answers.category = preset
          else delete answers.category
          goto('ticket')
        },
      ),
    )
    // The design's bug glyph is the 4-path 'bug-simple', not the busier lucide 'bug'.
    grid.appendChild(
      homeCard(
        'bug',
        'bug-simple',
        'rgba(239,68,68,.1)',
        '#EF4444',
        COPY.actionBug,
        COPY.cardBugDesc,
        () => {
          composeType = 'bug'
          // Legacy convention, deliberately KEPT — see `SupportSubmission.type`.
          if (fields.some((f) => f.id === 'category')) answers.category = 'Bug'
          goto('ticket')
        },
      ),
    )
    return grid
  }

  /** One popular-article row (closed-book icon + title + read-time + chevron). The meta column is
   *  omitted when the row carries no read-time (source-derived rows) rather than showing a made-up
   *  one. Inert-ish: opens the help centre url when the form declares one, else a no-op (there is
   *  no live KB endpoint). */
  function homeArticleRow(article: { title: string; meta?: string }): HTMLButtonElement {
    const row = button('ckrm-home-article')
    const book = icon('book', 15)
    book.classList.add('ckrm-home-article-book')
    row.appendChild(book)
    row.appendChild(el('span', 'ckrm-home-article-title', article.title))
    if (article.meta) row.appendChild(el('span', 'ckrm-home-article-meta', article.meta))
    const chev = icon('chevron-right', 14)
    chev.classList.add('ckrm-home-article-chev')
    row.appendChild(chev)
    const url = helpCenterUrl()
    row.addEventListener('click', () => openUrl(url))
    return row
  }

  /** One conversation card (frame 4a): 26px tinted category square + subject (+ unread dot) + snippet
   *  + status chip / time. Unread cards get the `#dfe3ff`/`#fafaff` treatment via a modifier class. */
  function homeConvoCard(row: SupportTicketRow): HTMLButtonElement {
    const unread = (row.unreadForUser ?? 0) > 0
    const card = button(`ckrm-home-convo-card${unread ? ' ckrm-home-convo-unread' : ''}`)
    const cat = categoryStyle(row.category)
    const sq = el('span', 'ckrm-home-convo-sq')
    sq.style.background = cat.tint
    const ci = icon(cat.icon, 13)
    ci.style.stroke = cat.stroke
    sq.appendChild(ci)
    card.appendChild(sq)

    const bodyCol = el('div', 'ckrm-home-convo-body')
    const top = el('div', 'ckrm-home-convo-top')
    top.appendChild(el('span', 'ckrm-home-convo-subject', str(row.subject, 'Conversation')))
    if (unread) {
      const dot = el('span', 'ckrm-home-convo-dot')
      dot.setAttribute('aria-hidden', 'true')
      top.appendChild(dot)
    }
    bodyCol.appendChild(top)
    if (row.snippet) bodyCol.appendChild(el('div', 'ckrm-home-convo-snippet', row.snippet))
    const meta = el('div', 'ckrm-home-convo-meta')
    const label = statusLabelFor(row.status, row.unreadForUser ?? 0)
    const chipStyle = STATUS_CHIP[label]
    const chip = el('span', 'ckrm-home-convo-chip', label)
    chip.style.color = chipStyle.color
    chip.style.background = chipStyle.bg
    meta.appendChild(chip)
    const bug = bugChipFor(row, 'ckrm-home-convo-chip')
    if (bug) meta.appendChild(bug)
    const time = row.timeLabel ?? relTime(row.createdAt)
    if (time) meta.appendChild(el('span', 'ckrm-home-convo-time', time))
    bodyCol.appendChild(meta)

    card.appendChild(bodyCol)
    card.addEventListener('click', () => openTicket(row.id))
    return card
  }

  /** The "Your conversations" strip: eyebrow + unread pill + View all, and the 2 most-recent tickets
   *  as cards routing into the EXISTING thread surface. */
  function homeConvos(): HTMLElement {
    const section = el('div', 'ckrm-home-section')
    const eyebrow = el('div', 'ckrm-home-eyebrow-row')
    eyebrow.appendChild(el('span', 'ckrm-home-eyebrow', COPY.yourConversations))
    const right = el('div', 'ckrm-home-convo-right')
    const unread = currentUnread()
    if (unread > 0) right.appendChild(el('span', 'ckrm-home-unread', String(unread)))
    const viewAll = button('ckrm-home-link', COPY.viewAll)
    viewAll.addEventListener('click', () => goto('tickets'))
    right.appendChild(viewAll)
    eyebrow.appendChild(right)
    section.appendChild(eyebrow)
    const grid = el('div', 'ckrm-home-convo-grid')
    const recent = [...ticketRows].sort((a, b) => asMs(b.createdAt) - asMs(a.createdAt)).slice(0, 2)
    for (const row of recent) grid.appendChild(homeConvoCard(row))
    section.appendChild(grid)
    return section
  }

  /** Frame 4a — the inline HOME surface (also serves `view: 'search'`). Search-first hero + channel
   *  cards + popular articles + the conversations strip; only an explicit `home: 'conversations'`
   *  drops the hero. No branding footer: frame 4a's pane ends after the conversations strip (3a/3b
   *  keep theirs), and on a tall route a footer would strand a bar under a big empty void. */
  function renderHome(): void {
    submitBtn = null
    homeSearchInput = null
    const posture = homePosture()
    const scroll = el('div', 'ckrm-home')

    // Popular-articles section is rebuilt in place as the query changes (search posture only).
    let articlesWrap: HTMLElement | null = null
    function paintArticles(): void {
      if (!articlesWrap) return
      const q = homeQuery.trim().toLowerCase()
      const all = homeArticles()
      const shown = q === '' ? all : all.filter((a) => a.title.toLowerCase().includes(q))
      articlesWrap.replaceChildren()
      if (shown.length === 0) {
        articlesWrap.appendChild(el('p', 'ckrm-home-empty', COPY.noMatchingArticles))
        return
      }
      for (const article of shown) articlesWrap.appendChild(homeArticleRow(article))
    }

    if (posture === 'search') {
      const hero = el('div', 'ckrm-home-hero')
      // The gradient band is full-bleed; its content centres in the same 884px column as the rest.
      const heroInner = el('div', 'ckrm-home-hero-inner')
      const h = el('h2', 'ckrm-home-title', COPY.homeTitle)
      h.id = TITLE_ID
      heroInner.appendChild(h)
      heroInner.appendChild(el('p', 'ckrm-home-sub', COPY.homeSubtitle))
      const searchWrap = el('div', 'ckrm-home-search')
      searchWrap.appendChild(icon('search', 18))
      const input = el('input')
      input.type = 'text'
      input.value = homeQuery
      input.placeholder = COPY.homeSearchPlaceholder
      input.setAttribute('aria-label', COPY.homeSearchPlaceholder)
      input.addEventListener('input', () => {
        homeQuery = input.value
        paintArticles()
      })
      homeSearchInput = input
      searchWrap.appendChild(input)
      const kbd = el('span', 'ckrm-home-kbd', '⌘K')
      kbd.setAttribute('aria-hidden', 'true')
      searchWrap.appendChild(kbd)
      heroInner.appendChild(searchWrap)
      hero.appendChild(heroInner)
      scroll.appendChild(hero)
    } else {
      // No hero → still name the dialog for a11y.
      scroll.appendChild(srTitle(COPY.homeTitle))
    }

    const content = el('div', 'ckrm-home-content')
    content.appendChild(homeCards())

    // Popular articles is ALWAYS present — `homeArticles()` falls back to the design's sample rows,
    // so a form with no connected docs source still gets the section (the design only drops the search
    // band in that case, never the list).
    const section = el('div', 'ckrm-home-section')
    const eyebrow = el('div', 'ckrm-home-eyebrow-row')
    eyebrow.appendChild(el('span', 'ckrm-home-eyebrow', COPY.popularArticles))
    const url = helpCenterUrl()
    // No help-centre url ⇒ no "Browse all" (the button would be a dead `openUrl(undefined)`).
    if (url) {
      const browse = button('ckrm-home-link', COPY.browseAll)
      browse.addEventListener('click', () => openUrl(url))
      eyebrow.appendChild(browse)
    }
    section.appendChild(eyebrow)
    articlesWrap = el('div', 'ckrm-home-articles')
    section.appendChild(articlesWrap)
    content.appendChild(section)
    paintArticles()

    if (showConvosRow()) content.appendChild(homeConvos())

    scroll.appendChild(content)
    panel.replaceChildren(scroll)

    // Autofocus the search input on mount (frame 4a) without stealing focus mid-interaction: focus
    // only when nothing in the surface is focused yet, or the host explicitly opened `view: 'search'`.
    if (homeSearchInput) {
      const focusInput = (): void => {
        if (destroyed || !homeSearchInput) return
        const active = shadow.activeElement
        if (step === 'search' || active == null || active === root) homeSearchInput.focus()
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusInput)
      else focusInput()
    }
  }

  /** Frame 4a "Ask AI" — the page-native answer bot. The FAB answer bot is DEFERRED/inert; this
   *  keeps that semantics (coming-soon badge, disabled "Solved") but lays it out as a page-width
   *  thread column PLUS a real cited-sources sidebar. Back returns to the home surface. */
  function renderBot(): void {
    submitBtn = null
    homeSearchInput = null
    const wrap = el('div', 'ckrm-bot')

    const head = el('div', 'ckrm-bot-header')
    const back = button('ckrm-bot-back')
    back.setAttribute('aria-label', 'Back')
    back.appendChild(icon('arrow-left', 16))
    back.addEventListener('click', () => goto('home'))
    head.appendChild(back)
    const h = el('h2', 'ckrm-bot-title', COPY.botTitle)
    h.id = TITLE_ID
    head.appendChild(h)
    head.appendChild(el('span', 'ckrm-bot-soon', COPY.comingSoon))
    wrap.appendChild(head)

    const bodyRow = el('div', 'ckrm-bot-body')
    const main = el('div', 'ckrm-bot-main')
    main.setAttribute('aria-disabled', 'true')
    const answerRow = el('div', 'ckrm-answer')
    const avatar = el('div', 'ckrm-avatar')
    avatar.appendChild(icon('bot', 14))
    answerRow.appendChild(avatar)
    const answer = el('p', 'ckrm-answer-text', COPY.answerLead)
    answer.appendChild(el('b', undefined, COPY.answerBold))
    answer.appendChild(document.createTextNode(COPY.answerTail))
    answerRow.appendChild(answer)
    main.appendChild(answerRow)

    const choice = el('div', 'ckrm-choice')
    const solved = button('ckrm-btn ckrm-btn-solved', COPY.solved)
    solved.disabled = true
    solved.setAttribute('aria-disabled', 'true')
    choice.appendChild(solved)
    const escalate = button('ckrm-btn ckrm-btn-escalate', COPY.stillNeedHelp)
    escalate.addEventListener('click', () => goto('ticket'))
    choice.appendChild(escalate)
    main.appendChild(choice)
    bodyRow.appendChild(main)

    const side = el('div', 'ckrm-bot-sidebar')
    side.appendChild(el('p', 'ckrm-bot-sidebar-eyebrow', COPY.citedSources))
    for (const article of homeArticles().slice(0, 6)) {
      const cite = el('div', 'ckrm-bot-cite')
      cite.appendChild(icon('book', 14))
      const col = el('div')
      col.appendChild(el('div', 'ckrm-bot-cite-title', article.title))
      // Source-derived citations carry no read-time — show nothing rather than fabricate one.
      if (article.meta) col.appendChild(el('div', 'ckrm-bot-cite-meta', article.meta))
      cite.appendChild(col)
      side.appendChild(cite)
    }
    bodyRow.appendChild(side)
    wrap.appendChild(bodyRow)

    // Like the home surface (and unlike 3a/3b), the design draws no branding footer on this page.
    panel.replaceChildren(wrap)
  }

  /** Frame 3a — two-pane master-detail: page header, list rail + thread pane side by side, branding
   *  footer pinned to the bottom. */
  function renderInlineTwoPane(): void {
    submitBtn = null
    const head = inlineHeader('ckrm-inline-header')

    const bodyRow = el('div', 'ckrm-inline-body')
    bodyRow.appendChild(inlineRail())
    bodyRow.appendChild(inlinePane(true))

    panel.replaceChildren(head, bodyRow)
    const brand = inlineBranding()
    if (brand) panel.appendChild(brand)
  }

  /** Frame 3b — stacked collapse (container < ~640px): a single column. The list is full-width;
   *  selecting a ticket pushes the thread over it (the existing 2a→2b nav, `step`/`activeTicketId`).
   *  Branding footer pinned to the bottom. */
  function renderInlineStacked(): void {
    submitBtn = null
    const mode = inlinePaneMode()
    if (mode === 'thread' || mode === 'compose' || mode === 'confirmed') {
      // Thread / compose / confirmed take over the whole column (with a back arrow).
      panel.replaceChildren(inlinePane(false))
    } else {
      // List home: small header + New conversation + full-width rows.
      const head = inlineHeader('ckrm-inline-header ckrm-inline-stacked-header')

      const newWrap = el('div', 'ckrm-inline-newwrap')
      newWrap.appendChild(inlineNewButton())

      const listWrap = el('div', 'ckrm-body ckrm-tickets-list')
      if (ticketRows.length === 0) {
        listWrap.appendChild(el('p', 'ckrm-tickets-empty', 'No conversations yet.'))
      } else {
        for (const row of ticketRows) listWrap.appendChild(ticketRow(row))
      }
      panel.replaceChildren(head, newWrap, listWrap)
    }
    const brand = inlineBranding()
    if (brand) panel.appendChild(brand)
  }

  /** Inline dispatcher: collapse to stacked below the CONTAINER's ~640px breakpoint (measured via
   *  the ResizeObserver in `embedWidth`, never the viewport). */
  function renderInline(): void {
    // Every inline surface re-paints from scratch, so drop the previous search-input ref up front —
    // a stale (detached) one would make ⌘K focus a node that is no longer in the tree.
    homeSearchInput = null
    panel.setAttribute('data-view', step)
    panel.setAttribute('data-embed-stacked', String(embedStacked))
    // Frame 4a home surfaces are single-column pages (not two-pane): they read well stacked as-is.
    if (step === 'home' || step === 'search') {
      renderHome()
      return
    }
    if (step === 'bot') {
      renderBot()
      return
    }
    if (embedStacked) renderInlineStacked()
    else renderInlineTwoPane()
  }

  function renderStep(): void {
    if (destroyed || !open) return
    suggestedBlock = null
    if (embed) {
      renderInline()
      return
    }
    panel.setAttribute('data-view', step)
    switch (step) {
      case 'answer':
        renderAnswer()
        break
      case 'ticket':
        renderTicket()
        break
      case 'confirmed':
        renderConfirmed()
        break
      case 'tickets':
        renderTickets()
        break
      case 'thread':
        renderThread()
        break
      default:
        renderAsk()
    }
    if (autoFocus) {
      try {
        // Focus the dialog itself, not its first control: the header-less 1e steps open straight
        // onto a form field, and auto-focusing it would mint a bogus `onFieldFocus` telemetry
        // entry the user never caused.
        panel.focus()
      } catch {
        // ignore
      }
    }
  }

  // ---- mount -------------------------------------------------------------

  const parent = opts.container ?? document.body
  parent.appendChild(host)
  safe(opts.onShown)

  const explicitInitial = opts.initialStep != null || opts.initialView != null

  if (embed) {
    // Inline (frames 3a/3b): the widget IS the page — fill the container, mark the root embedded
    // (activates the `[data-embed]` CSS), stay always-open, and collapse by CONTAINER width.
    host.style.display = 'block'
    host.style.width = '100%'
    host.style.height = '100%'
    root.setAttribute('data-embed', 'true')
    // Default surface when the host pins none: the frame 4a search-first HOME. An explicit
    // `initialView`/`initialStep` still wins (already set). Only an explicit `home:
    // 'conversations'` switches the posture — see `homePosture`.
    if (!explicitInitial) step = 'home'
    // ⌘K anywhere ON THE PAGE (host input included) focuses the home search (frame 4a). Exactly one
    // listener per handle; `destroy()` removes it.
    try {
      document.addEventListener('keydown', onHomeKeydown as EventListener, true)
    } catch {
      // ignore
    }

    const measure = (): number => {
      try {
        return host.getBoundingClientRect().width
      } catch {
        return 0
      }
    }
    embedWidth = measure()
    embedStacked = embedWidth > 0 && embedWidth < 640
    // Collapse keys off the CONTAINER width (ResizeObserver), never the viewport — re-render only
    // when the two-pane ⇄ stacked boundary is actually crossed.
    if (typeof ResizeObserver !== 'undefined') {
      try {
        resizeObs = new ResizeObserver((entries) => {
          if (destroyed) return
          const w = entries[0]?.contentRect?.width ?? measure()
          embedWidth = w
          const next = w > 0 && w < 640
          if (next !== embedStacked) {
            embedStacked = next
            if (open) renderStep()
          }
        })
        resizeObs.observe(host)
      } catch {
        resizeObs = null
      }
    }

    openPanel()
    if (step === 'thread' && activeTicketId) {
      const alreadySeeded = thread?.id === activeTicketId && !opts.onLoadThread
      if (!alreadySeeded) void loadThread(activeTicketId)
      startThreadSub(activeTicketId)
    } else {
      void reloadTickets()
    }
  } else {
    // Open-to rules. An explicit `initialStep`/`initialView` (the builder preview
    // path) wins and pins a single surface. Otherwise, for identified users:
    //   • ≥1 ticket AND unread > 0 → open straight to the 2b thread of the most-recent unread ticket
    //   • tickets, no unread       → home (`ask`), with the 1b "Your conversations" row visible
    //   • else                     → home as today (autoOpen still honoured)
    if (explicitInitial) {
      openPanel()
      if (step === 'thread' && activeTicketId) {
        // Preview seeds `initialThread` directly and passes no loader — don't clobber it with a fetch.
        const alreadySeeded = thread?.id === activeTicketId && !opts.onLoadThread
        if (!alreadySeeded) void loadThread(activeTicketId)
        startThreadSub(activeTicketId)
      } else if (step === 'tickets') {
        void reloadTickets()
      }
    } else {
      const target = resolveInitialSurface()
      if (target) {
        openTicket(target.id)
      } else if (triggers?.autoOpen === true) {
        openPanel()
      }
    }

    // Background watch for reply-while-online (badge + 2c toast), independent of the panel state.
    // Inline has no launcher/toast, so it is skipped there (the open thread's own sub still runs).
    startBackgroundSub()
  }

  return {
    open: openPanel,
    close: closePanel,
    refresh() {
      // Re-fetch the ticket list and re-render it (2a) without stealing focus or resetting the
      // open thread/compose — `reloadTickets` only repaints when the list is the visible step.
      if (destroyed) return
      void reloadTickets()
    },
    destroy,
  }
}
