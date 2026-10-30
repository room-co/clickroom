import crypto from 'node:crypto'
import { decryptApiKey, encryptApiKey } from '@clickroom/ai'
import {
  buildSupportCsat,
  buildSupportDeflectionRate,
  buildSupportVolumeByCategory,
  buildSupportVolumeTrend,
  clickhouse,
} from '@clickroom/clickhouse'
import { newId, slugify } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { entitlementMiddleware } from '../middleware/entitlement.js'
import { requirePermission, router, scopedForProject } from '../trpc.js'
import { rebuildFlagCache, recordFlagAudit } from './flags.cache.js'
import { defaultEnvironment, type FlagFilters } from './flags.router.js'
import {
  assignSupportTicketInput,
  createSupportFormInput,
  createSupportWebhookInput,
  deleteSupportFormInput,
  deleteSupportWebhookInput,
  exportSupportWebhookDeliveriesInput,
  getSupportFormInput,
  getSupportTicketInput,
  listSupportFormsInput,
  listSupportTicketsForUserInput,
  listSupportTicketsInput,
  listSupportWebhookDeliveriesInput,
  listSupportWebhooksInput,
  markSupportTicketSolvedInput,
  reEnableSupportWebhookInput,
  replySupportTicketInput,
  retryAllFailedSupportWebhookDeliveriesInput,
  retrySupportWebhookDeliveryInput,
  rotateSupportWebhookSecretInput,
  type SupportBugReportInput,
  type SupportWebhookDeliveryFilter,
  sendSupportWebhookTestInput,
  setSupportTicketPriorityInput,
  setSupportTicketSeverityInput,
  setSupportTicketStatusInput,
  supportResultsInput,
  supportThreadInput,
  supportTicketPayloadSchema,
  supportTrendInput,
  supportWebhookAffectedFormsInput,
  supportWebhookHealthInput,
  supportWebhookStatsInput,
  supportWebhookVolumeInput,
  updateSupportFormInput,
  updateSupportWebhookInput,
} from './support.schema.js'
import { admitWebhookUrl, webhookSignatureHeader } from './support.webhook-signing.js'

type Pdb = Awaited<ReturnType<typeof scopedForProject>>

/**
 * Support procedures: RBAC first, entitlement (`feature:support`) second —
 * identical gate order to `surveys.router.ts:50-53`. A user without the
 * permission gets the *permissions* error, never an upsell. Manage-tier ops
 * (form CRUD, ticket writes, webhook CRUD) require `projects:manage`; reads
 * (list/get/results) require `projects:read`.
 */
const supportProcedure = requirePermission('projects:manage').use(
  entitlementMiddleware('feature:support'),
)
const supportReadProcedure = requirePermission('projects:read').use(
  entitlementMiddleware('feature:support'),
)

/**
 * ClickHouse DateTime64 params reject the trailing `Z` zod's `.datetime()`
 * always emits — normalize to `YYYY-MM-DD HH:mm:ss.SSS` (UTC). Same contract as
 * `surveys.router.ts`'s `toChRange`.
 */
function toChRange(range: { from: string; to: string }): { from: string; to: string } {
  const fmt = (iso: string) => new Date(iso).toISOString().replace('T', ' ').replace('Z', '')
  return { from: fmt(range.from), to: fmt(range.to) }
}

// ── Linked feature flag ─────────────────────────────────────────────────────
// A support form owns a boolean FeatureFlag per environment, exactly as a survey
// does: the flag is the SINGLE eligibility/rollout/segment mechanism, so
// rollout %, per-segment conditions and env scoping all ride existing flag
// machinery straight through to the Rust evaluator. No new eval engine.

/** One always-eligible group; the flag's `active` gate does the real work. */
const SUPPORT_FLAG_FILTERS: FlagFilters = {
  groups: [{ properties: [], rollout_percentage: 100, variant: null }],
  kind: 'boolean',
}

type LinkedFlagRow = {
  id: string
  version: number
  active: boolean
  filters: unknown
  environment: { id: string; key: string }
}

/**
 * Every FeatureFlag row sharing the linked `key`, one per environment.
 * capture's `/v1/flags` resolves flags per-environment by key, so a key present
 * in only one env is invisible to SDKs pointed at any other env — resolve the
 * whole set by key (not by a single `featureFlagId`) so status-sync and delete
 * fan out everywhere.
 */
async function linkedFlagRows(pdb: Pdb, projectId: string, key: string): Promise<LinkedFlagRow[]> {
  return pdb.featureFlag.findMany({
    where: { projectId, key, deletedAt: null },
    select: {
      id: true,
      version: true,
      active: true,
      filters: true,
      environment: { select: { id: true, key: true } },
    },
  }) as unknown as Promise<LinkedFlagRow[]>
}

/** Rebuild the per-env Redis flag blob for each of the given environments. */
async function rebuildCachesForEnvironments(
  pdb: Pdb,
  projectId: string,
  environments: Array<{ id: string; key: string }>,
): Promise<void> {
  for (const env of environments) {
    await rebuildFlagCache(pdb, projectId, env)
  }
}

/**
 * The flag rows to create alongside a new form — one per environment, all
 * sharing a key suffixed with the form id's tail so two forms whose names
 * slugify identically never collide on `(projectId, key, environmentId)`
 * (mirrors surveys' `survey-` and experiments' `exp-` keys).
 */
function buildLinkedFlagInputs(args: {
  projectId: string
  name: string
  formId: string
  environments: Array<{ id: string }>
}) {
  const key = `support-${slugify(args.name)}-${args.formId.slice(-6).toLowerCase()}`
  return args.environments.map((env) => ({
    id: newId(),
    projectId: args.projectId,
    key,
    name: `${args.name} (support)`,
    // Off until the form goes active — the flag gates per-user eligibility, the
    // form's `status` gates whether capture serves the config at all.
    active: false,
    // No `$feature_flag_called` exposures: deflection/volume are computed off
    // `$support_*` events, not flag calls.
    track: false,
    environmentId: env.id,
    filters: SUPPORT_FLAG_FILTERS,
  }))
}

/** Resolve the linked flag's key (via the form's default-env row) + every row sharing it. */
async function resolveLinkedFlags(
  pdb: Pdb,
  projectId: string,
  featureFlagId: string,
): Promise<{ key: string | null; rows: LinkedFlagRow[] }> {
  const linked = await pdb.featureFlag.findFirst({
    where: { id: featureFlagId, deletedAt: null },
    select: { key: true },
  })
  if (!linked) return { key: null, rows: [] }
  return { key: linked.key, rows: await linkedFlagRows(pdb, projectId, linked.key) }
}

/** Write one FlagAudit row per linked flag after a fan-out mutation. */
async function auditLinkedFlags(
  pdb: Pdb,
  args: {
    projectId: string
    actorUserId: string
    action: 'created' | 'updated' | 'deleted'
    rows: Array<{ id: string; version: number; active: boolean; filters?: unknown }>
    after: (row: { active: boolean; filters?: unknown }) => unknown
    versionDelta: number
  },
): Promise<void> {
  for (const row of args.rows) {
    await recordFlagAudit(pdb, {
      flagId: row.id,
      projectId: args.projectId,
      action: args.action,
      actorUserId: args.actorUserId,
      diff: {
        before: args.action === 'created' ? null : { active: row.active, filters: row.filters },
        after: args.after(row),
      },
      version: row.version + args.versionDelta,
    })
  }
}

// ── Webhook delivery enqueue ────────────────────────────────────────────────
// Delivery itself is a Rust NATS/sweep worker. The control plane's only
// job is to durably enqueue a row; `nextAttemptAt = now` makes it eligible on
// the worker's very next sweep, so a missed NATS notification only costs
// latency, never the delivery.

type DeliveryRow = {
  id: string
  webhookId: string
  ticketId: string | null
  event: string
  payload: unknown
  status: string
  nextAttemptAt: Date
}

/**
 * Active, non-deleted webhooks in this project subscribed to `event`.
 *
 * An EMPTY `events[]` means subscribe-to-everything, matching the two Rust
 * readers — capture-rs (`services/capture/src/support/store.rs:684`) and the
 * delivery worker (`services/ingest/src/webhook_job.rs:230`) both admit a row
 * with `cardinality(events) = 0`. Before this query used `has` alone,
 * i.e. subscribe-to-NOTHING, so the same row meant opposite things depending on
 * which writer enqueued the delivery. Unreachable through the API (`events`
 * carries `.min(1)` on create and on patch), but old or hand-inserted rows can
 * hit it; adopting the Rust semantics is the fix.
 */
async function webhooksSubscribedTo(pdb: Pdb, event: string) {
  return pdb.supportWebhook.findMany({
    where: {
      deletedAt: null,
      active: true,
      OR: [{ events: { has: event } }, { events: { isEmpty: true } }],
    },
    select: { id: true },
  })
}

/**
 * Enqueue one pending delivery per subscribed webhook. Returns the rows created
 * (empty when nobody subscribes — an unrouted project is not an error).
 * `tx` lets the caller enqueue inside the same transaction as the state change
 * that caused it, so a reply can never land without its `ticket.replied` row.
 */
async function enqueueDeliveries(
  tx: Pick<Pdb, 'supportWebhookDelivery'>,
  args: {
    webhookIds: string[]
    ticketId: string | null
    event: string
    payload: Record<string, unknown>
  },
): Promise<DeliveryRow[]> {
  const rows: DeliveryRow[] = []
  for (const webhookId of args.webhookIds) {
    const created = await tx.supportWebhookDelivery.create({
      data: {
        id: newId(),
        webhookId,
        ticketId: args.ticketId,
        event: args.event,
        payload: args.payload,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(),
      },
    })
    rows.push(created as unknown as DeliveryRow)
  }
  return rows
}

// ── Webhook secrets ─────────────────────────────────────────────────────────

/**
 * 32 bytes of CSPRNG entropy, hex-encoded — the HMAC-SHA256 key the delivery
 * worker signs with. Returned to the caller exactly ONCE (on create); the stored
 * copy is encrypted with `encryptApiKey` and never decrypted by the control
 * plane, only by the worker.
 */
function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * The `whsec_••••3f7a` mask's four characters. Stored in plaintext because the
 * control plane cannot decrypt `secret` on a read path (constraint 7), so the
 * mask is otherwise impossible — 4 of 64 hex chars, never logged and never put
 * in an error message.
 */
function secretHint(secret: string): string {
  return secret.slice(-4)
}

/** How long a rotated-out secret keeps signing as `v1`. */
const SECRET_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Ceiling on `webhooks.retryAllFailed`. One click at an endpoint that has been
 * dead for a week must not be able to queue 100k deliveries at it; the UI
 * surfaces the number when it bites so "retry the rest" is an explicit second
 * action rather than an invisible truncation.
 */
const RETRY_ALL_CAP = 500

/**
 * Strip BOTH secret columns from a webhook row before it leaves the API.
 * `previousSecret` is the same `encryptApiKey` envelope as `secret`, so letting
 * it ride along would hand out ciphertext that constraint 7 exists to withhold.
 */
function publicWebhook<T extends { secret: string; previousSecret?: string | null }>(
  row: T,
): Omit<T, 'secret' | 'previousSecret'> {
  const { secret: _secret, previousSecret: _previousSecret, ...rest } = row
  return rest
}

// ── First-reply time (Postgres, not ClickHouse) ─────────────────────────────

/** Median of a numeric list; 0 for an empty list. Pure. */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Seconds between ticket creation and its first agent reply. */
function firstReplySeconds(t: { createdAt: Date; firstReplyAt: Date | null }): number | null {
  if (!t.firstReplyAt) return null
  return (new Date(t.firstReplyAt).getTime() - new Date(t.createdAt).getTime()) / 1000
}

// ── Ticket list filtering ───────────────────────────────────────────────────

/**
 * Translate the list input's optional filters into a Prisma `where`.
 *
 * `type` / `severity` follow the same `!== undefined` guard style as
 * `category` / `assigneeId`: omitted = no predicate (the inbox's "All" tab), so
 * the pre-phase call shape is byte-identical. Exported for unit testing.
 */
export function ticketListWhere(input: {
  formId?: string
  status?: string
  type?: string
  severity?: string
  category?: string
  assigneeId?: string
  from?: string
  to?: string
}): Record<string, unknown> {
  const createdAt = {
    ...(input.from !== undefined && { gte: new Date(input.from) }),
    ...(input.to !== undefined && { lte: new Date(input.to) }),
  }
  return {
    ...(input.formId !== undefined && { formId: input.formId }),
    ...(input.status !== undefined && { status: input.status }),
    ...(input.type !== undefined && { type: input.type }),
    ...(input.severity !== undefined && { severity: input.severity }),
    ...(input.category !== undefined && { category: input.category }),
    ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
    ...(Object.keys(createdAt).length > 0 && { createdAt }),
  }
}

/**
 * Validate a ticket's stored bug payload on the way OUT.
 *
 * capture-rs owns ingest validation; zod owns the read path. Rows written before
 * (and anything a future rogue writer stores) must never 500 the inbox,
 * so this `safeParse`s and returns `null` on failure rather than throwing.
 * Conversations always return `null` — the payload only exists on the `bug`
 * branch of the discriminated union. Exported for unit testing.
 */
export function parseBugReport(ticket: {
  type?: string | null
  severity?: string | null
  bugReport?: unknown
}): SupportBugReportInput | null {
  const parsed = supportTicketPayloadSchema.safeParse({
    type: ticket.type,
    severity: ticket.severity,
    bugReport: ticket.bugReport,
  })
  if (!parsed.success || parsed.data.type !== 'bug') return null
  return parsed.data.bugReport ?? null
}

/** Load a ticket in this project or 404. */
async function requireTicket(pdb: Pdb, id: string) {
  const ticket = await pdb.supportTicket.findFirst({ where: { id } })
  if (!ticket) throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket not found.' })
  return ticket
}

// ── Thread reads + status transitions (shared by inbox and widget) ───────────

/**
 * The one thread read path. Both `tickets.get` (1f inbox) and `tickets.thread`
 * (2b widget) render the identical `TicketMessage[]`, ordered oldest-first, so
 * neither builds a second query.
 */
function loadThread(pdb: Pdb, ticketId: string) {
  return pdb.supportTicketMessage.findMany({
    where: { ticketId },
    orderBy: { createdAt: 'asc' },
  })
}

/**
 * Move a ticket to `status`, stamping `resolvedAt` the first time it lands in a
 * terminal state and clearing it on reopen (so "time to resolution" always
 * reflects the CURRENT resolution). Shared by `setStatus` and `markSolved` so
 * the terminal-state semantics can never drift between the two.
 */
function isTerminalTicketStatus(status: string): boolean {
  return status === 'resolved' || status === 'closed'
}

/**
 * Which webhook event this transition emits, if any.
 *
 * `ticket.resolved` fires on every move INTO a terminal status, exactly as it
 * has earlier — including `resolved -> closed`, which customers already
 * receive. `ticket.reopened` is its mirror on the way OUT, and is the only new
 * emit: it is what makes the event added to `supportWebhookEventSchema` real
 * rather than another `ticket.updated`. Exported for unit testing.
 */
export function ticketStatusWebhookEvent(from: string, to: string): string | null {
  if (isTerminalTicketStatus(to)) return 'ticket.resolved'
  if (isTerminalTicketStatus(from)) return 'ticket.reopened'
  return null
}

async function applyTicketStatus(
  pdb: Pdb,
  ticket: { id: string; number: number; status: string; resolvedAt: Date | null },
  status: string,
) {
  const isTerminal = isTerminalTicketStatus(status)
  const now = new Date()
  const resolvedAt = isTerminal ? (ticket.resolvedAt ?? now) : null
  const event = ticketStatusWebhookEvent(ticket.status, status)
  const hooks = event ? await webhooksSubscribedTo(pdb, event) : []

  await pdb.$transaction(async (tx) => {
    await tx.supportTicket.updateMany({
      where: { id: ticket.id },
      data: { status, resolvedAt },
    })
    await enqueueDeliveries(tx as unknown as Pick<Pdb, 'supportWebhookDelivery'>, {
      webhookIds: hooks.map((h) => h.id),
      ticketId: ticket.id,
      // `webhookIds` is empty when `event` is null, so no row is written and the
      // event name is never read — the `??` only keeps the argument well-typed.
      event: event ?? 'ticket.updated',
      payload: {
        ticketId: ticket.id,
        number: ticket.number,
        status,
        resolvedAt: resolvedAt?.toISOString() ?? null,
        at: now.toISOString(),
      },
    })
  })

  return pdb.supportTicket.findFirstOrThrow({ where: { id: ticket.id } })
}

// ── End-user ticket-list row shape (widget frame 2a) ─────────────────────────

/**
 * The end-user's chip label for a ticket: a terminal ticket
 * reads "Solved"; an agent (or answer-bot) reply sitting on a live ticket reads
 * "Agent replied"; anything still awaiting us reads "Waiting on us". Exported so
 * the list-row builder and its test share one source of truth.
 */
export function endUserStatusLabel(status: string, lastAuthorType: string | null): string {
  if (status === 'resolved' || status === 'closed') return 'Solved'
  if (lastAuthorType === 'agent' || lastAuthorType === 'ai') return 'Agent replied'
  return 'Waiting on us'
}

/** First-person prefix on the last-message snippet: the user is "You", staff "Support". */
function authorPrefix(authorType: string | null): string {
  switch (authorType) {
    case 'user':
      return 'You'
    case 'agent':
    case 'ai':
      return 'Support'
    default:
      return 'System'
  }
}

/** `"<prefix>: <one-line, clipped body>"`, or null when the ticket has no messages. */
function messageSnippet(
  msg: { authorType: string; body: string } | null,
  max = 120,
): string | null {
  if (!msg) return null
  const body = String(msg.body).replace(/\s+/g, ' ').trim()
  const clipped = body.length > max ? `${body.slice(0, max - 1)}…` : body
  return `${authorPrefix(msg.authorType)}: ${clipped}`
}

/** Coarse "5m ago"/"3h ago"/"2d ago" stamp for the list row. Pure. */
export function relativeTime(from: Date, now: Date = new Date()): string {
  const s = Math.max(0, Math.floor((now.getTime() - new Date(from).getTime()) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  const w = Math.floor(d / 7)
  if (w < 5) return `${w}w ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(d / 365)}y ago`
}

type EndUserTicketRow = {
  id: string
  number: number
  subject: string
  category: string
  /** `'conversation' | 'bug'` — chips a bug row in the ONE end-user list. */
  type: string
  status: string
  statusLabel: string
  snippet: string | null
  lastAuthorType: string | null
  updatedAt: Date
  relativeTime: string
  unreadForUser: number
}

/** Assemble the 2a row from a ticket and its most-recent message. Pure. */
function buildEndUserTicketRow(
  ticket: {
    id: string
    number: number
    subject: string
    category: string
    type: string
    status: string
    unreadForUser: number
    updatedAt: Date
    createdAt: Date
  },
  lastMessage: { authorType: string; body: string; createdAt: Date } | null,
): EndUserTicketRow {
  const lastAuthorType = lastMessage ? String(lastMessage.authorType) : null
  const at = lastMessage?.createdAt ?? ticket.updatedAt ?? ticket.createdAt
  return {
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    category: ticket.category,
    type: ticket.type ?? 'conversation',
    status: ticket.status,
    statusLabel: endUserStatusLabel(ticket.status, lastAuthorType),
    snippet: messageSnippet(lastMessage),
    lastAuthorType,
    updatedAt: at,
    relativeTime: relativeTime(new Date(at)),
    unreadForUser: ticket.unreadForUser ?? 0,
  }
}

/** Load a support form in this project or 404. */
async function requireForm(pdb: Pdb, id: string) {
  const form = await pdb.supportForm.findFirst({ where: { id, deletedAt: null } })
  if (!form) throw new TRPCError({ code: 'NOT_FOUND', message: 'Support form not found.' })
  return form
}

/** Load a webhook in this project or 404. */
async function requireWebhook(pdb: Pdb, id: string) {
  const hook = await pdb.supportWebhook.findFirst({ where: { id, deletedAt: null } })
  if (!hook) throw new TRPCError({ code: 'NOT_FOUND', message: 'Webhook not found.' })
  return hook
}

// ── Routers ─────────────────────────────────────────────────────────────────

const ticketsRouter = router({
  list: supportReadProcedure.input(listSupportTicketsInput).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const rows = await pdb.supportTicket.findMany({
      where: ticketListWhere(input),
      orderBy: { createdAt: 'desc' },
      take: input.limit + 1,
      ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
    })
    const hasMore = rows.length > input.limit
    const items = hasMore ? rows.slice(0, input.limit) : rows
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null }
  }),

  // Ticket + full thread + the context bundle captured at submit time (identity,
  // recent events, active flags, form-fill telemetry) — everything the inbox's
  // context rail renders (frame 1f).
  get: supportReadProcedure.input(getSupportTicketInput).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const ticket = await requireTicket(pdb, input.id)
    const [messages, attachments] = await Promise.all([
      loadThread(pdb, ticket.id),
      pdb.supportAttachment.findMany({ where: { ticketId: ticket.id } }),
    ])
    // Opening the ticket in the inbox is the agent reading it — clear their
    // unread badge. (The user-side badge is cleared by the widget's own read.)
    await pdb.supportTicket.updateMany({ where: { id: ticket.id }, data: { unreadForAgent: 0 } })
    return {
      ticket: { ...ticket, unreadForAgent: 0 },
      messages,
      attachments,
      context: ticket.context,
      // Validated on the way out, `null` when absent/malformed/not a bug.
      // `ticket.type` / `ticket.severity` ride along on the spread above — the
      // inbox needs them as columns and as the `setSeverity` control's gate.
      bugReport: parseBugReport(ticket),
    }
  }),

  /**
   * Tickets raised by the current identified end-user (widget frame 2a). Scoped
   * to their `distinctId` (and `personId` once logged in) — never a form or an
   * agent — and cursor-paginated exactly like `list`. Each row carries the 2a
   * shape: subject, category, last-message snippet, the end-user chip label and
   * the per-ticket `unreadForUser` count.
   */
  listForUser: supportReadProcedure
    .input(listSupportTicketsForUserInput)
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const where = input.personId
        ? { OR: [{ distinctId: input.distinctId }, { personId: input.personId }] }
        : { distinctId: input.distinctId }
      const rows = await pdb.supportTicket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      })
      const hasMore = rows.length > input.limit
      const page = hasMore ? rows.slice(0, input.limit) : rows
      const items = await Promise.all(
        page.map(async (ticket) => {
          const [last] = await pdb.supportTicketMessage.findMany({
            where: { ticketId: ticket.id },
            orderBy: { createdAt: 'desc' },
            take: 1,
          })
          return buildEndUserTicketRow(
            ticket as unknown as Parameters<typeof buildEndUserTicketRow>[0],
            (last ?? null) as Parameters<typeof buildEndUserTicketRow>[1],
          )
        }),
      )
      return { items, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null }
    }),

  /**
   * One ticket's thread. When `distinctId`/`personId` are supplied the read is
   * scoped to the requesting end-user (a user may only read their OWN thread);
   * absent = an agent read. Same `TicketMessage[]` as `get` via `loadThread`.
   */
  thread: supportReadProcedure.input(supportThreadInput).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const ticket = await requireTicket(pdb, input.id)
    if (input.distinctId !== undefined) {
      const isRequester =
        ticket.distinctId === input.distinctId ||
        (input.personId != null && ticket.personId === input.personId)
      if (!isRequester) throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket not found.' })
    }
    const messages = await loadThread(pdb, ticket.id)
    return { ticket, messages }
  }),

  /**
   * Append an agent reply. `firstReplyAt` is stamped ONLY on the first one — it
   * is the median-first-reply metric's input, so a second reply must never
   * overwrite it.
   */
  reply: supportProcedure.input(replySupportTicketInput).mutation(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const ticket = await requireTicket(pdb, input.id)
    const isFirstReply = ticket.firstReplyAt == null
    const now = new Date()

    // Read the subscriber set before the transaction so the enqueue inside it is
    // a pure write.
    const hooks = await webhooksSubscribedTo(pdb, 'ticket.replied')

    const message = await pdb.$transaction(async (tx) => {
      const created = await tx.supportTicketMessage.create({
        data: {
          id: newId(),
          ticketId: ticket.id,
          authorType: 'agent',
          authorUserId: ctx.tokenPayload?.sub ?? null,
          body: input.body,
        },
      })
      // Every agent reply bumps the user's unread badge; the first one also
      // stamps `firstReplyAt` (the median-first-reply input, never overwritten).
      await tx.supportTicket.updateMany({
        where: { id: ticket.id },
        data: {
          unreadForUser: { increment: 1 },
          ...(isFirstReply && { firstReplyAt: now }),
        },
      })
      await enqueueDeliveries(tx as unknown as Pick<Pdb, 'supportWebhookDelivery'>, {
        webhookIds: hooks.map((h) => h.id),
        ticketId: ticket.id,
        event: 'ticket.replied',
        payload: {
          ticketId: ticket.id,
          number: ticket.number,
          messageId: created.id,
          body: input.body,
          authorUserId: ctx.tokenPayload?.sub ?? null,
          at: now.toISOString(),
        },
      })
      return created
    })

    return { message, firstReply: isFirstReply }
  }),

  /**
   * Move a ticket through its lifecycle. `resolvedAt` is stamped the first time
   * it lands in a terminal state (`resolved`/`closed`) and cleared if it is
   * reopened, so "time to resolution" always reflects the CURRENT resolution.
   *
   * Note: the `$support_ticket_resolved` ClickHouse event is emitted on the
   * capture path (/ the widget), not from the control plane — Node has no
   * NATS publisher. The webhook below is the control plane's outbound signal.
   */
  setStatus: supportProcedure
    .input(setSupportTicketStatusInput)
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const ticket = await requireTicket(pdb, input.id)
      return applyTicketStatus(pdb, ticket, input.status)
    }),

  /**
   * Agent "mark solved" — a thin alias over `setStatus`'s terminal path: sets
   * `status='resolved'` and stamps `resolvedAt` identically (via the shared
   * `applyTicketStatus`), so the two can never drift.
   */
  markSolved: supportProcedure
    .input(markSupportTicketSolvedInput)
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const ticket = await requireTicket(pdb, input.id)
      return applyTicketStatus(pdb, ticket, 'resolved')
    }),

  assign: supportProcedure.input(assignSupportTicketInput).mutation(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const ticket = await requireTicket(pdb, input.id)
    await pdb.supportTicket.updateMany({
      where: { id: ticket.id },
      data: { assigneeId: input.assigneeId },
    })
    return pdb.supportTicket.findFirstOrThrow({ where: { id: ticket.id } })
  }),

  /**
   * `priority` has been a real column since that no agent surface
   * could write — it rendered read-only in the detail view and was `"normal"`
   * forever. Same shape as `assign`: `requireTicket` -> `updateMany` ->
   * `findFirstOrThrow`.
   *
   * No ClickHouse event (Node has no NATS publisher — see `setStatus`'s note)
   * and no webhook: `ticket.updated` exists in `supportWebhookEventSchema` but
   * nothing emits it today, and starting here is an explicit phase non-goal.
   */
  setPriority: supportProcedure
    .input(setSupportTicketPriorityInput)
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const ticket = await requireTicket(pdb, input.id)
      await pdb.supportTicket.updateMany({
        where: { id: ticket.id },
        data: { priority: input.priority },
      })
      return pdb.supportTicket.findFirstOrThrow({ where: { id: ticket.id } })
    }),

  /**
   * Severity is bug-only metadata (hard constraint 4: it is orthogonal
   * to the shared `open|pending|resolved|closed` state machine, not a fork of
   * it). A severity on a conversation is a caller bug, so this FAILS LOUDLY with
   * `BAD_REQUEST` rather than silently no-op'ing — mirroring capture-rs's
   * `resolve_priority` allow-list posture. `null` clears it.
   */
  setSeverity: supportProcedure
    .input(setSupportTicketSeverityInput)
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const ticket = await requireTicket(pdb, input.id)
      if (ticket.type !== 'bug') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Severity can only be set on a bug ticket.',
        })
      }
      await pdb.supportTicket.updateMany({
        where: { id: ticket.id },
        data: { severity: input.severity },
      })
      return pdb.supportTicket.findFirstOrThrow({ where: { id: ticket.id } })
    }),
})

/**
 * Map the history sheet's filter view onto a Prisma `where` fragment.
 * `'retrying'` has no stored representation — see the comment on
 * `supportWebhookDeliveryFilterSchema`.
 */
function deliveryStatusFilter(view: SupportWebhookDeliveryFilter) {
  switch (view) {
    case 'delivered':
    case 'failed':
      return { status: view }
    case 'retrying':
      return { status: 'pending', attempts: { gt: 0 } }
    default:
      return {}
  }
}

/**
 * Bound the delivery list / stats window on `createdAt`. Same `!== undefined`
 * guard style as `ticketListWhere`, so omitting both leaves no predicate at all.
 */
function deliveryCreatedAtFilter(input: { from?: string; to?: string }) {
  const createdAt = {
    ...(input.from !== undefined && { gte: new Date(input.from) }),
    ...(input.to !== undefined && { lte: new Date(input.to) }),
  }
  return Object.keys(createdAt).length > 0 ? { createdAt } : {}
}

/** One event name, including the synthetic `'ping'` that `sendTest` writes. */
function deliveryEventFilter(event?: string) {
  return event === undefined ? {} : { event }
}

/**
 * The `7a` toolbar's "response code range". Bounds `lastStatusCode`, i.e. the
 * code the Response column renders, NOT a per-attempt code: a delivery that
 * 503'd four times and then 200'd is a `200` to the reader, and a range filter
 * that matched its earlier attempts would contradict the row it returns.
 *
 * A delivery with no response at all has `lastStatusCode = NULL` and therefore
 * matches no range — `IS NULL` never satisfies `>=`/`<=`, which is the correct
 * reading of "codes 500–599".
 */
function deliveryResponseCodeFilter(input: { responseCodeMin?: number; responseCodeMax?: number }) {
  const lastStatusCode = {
    ...(input.responseCodeMin !== undefined && { gte: input.responseCodeMin }),
    ...(input.responseCodeMax !== undefined && { lte: input.responseCodeMax }),
  }
  return Object.keys(lastStatusCode).length > 0 ? { lastStatusCode } : {}
}

/**
 * Free-text search over ticket identity and response bodies. See
 * `supportWebhookDeliveryFilterFields` in `support.schema.ts` for the contract
 * this implements; the short version is exact on ids/numbers, substring on
 * bodies.
 *
 * Ticket id is an equality match on purpose. Ids are opaque ULIDs, so a
 * `contains` on one buys nothing a paste cannot do and costs a full scan.
 * Response body IS a `contains` — pasting the error string your server returned
 * is the single most common way anyone finds the delivery they care about — and
 * that scan is bounded by the webhook + date filters that always accompany it.
 *
 * A purged attempt (`responseBody` NULLed by the retention job at 30 days)
 * cannot match. That is not recoverable here; `deliveries` counts those rows
 * separately so the page can say so instead of implying the search was
 * exhaustive.
 */
export function deliverySearchFilter(term?: string): Record<string, unknown> {
  const trimmed = term?.trim()
  if (!trimmed) return {}
  const or: Array<Record<string, unknown>> = [
    { ticketId: trimmed },
    { attempts_: { some: { responseBody: { contains: trimmed, mode: 'insensitive' } } } },
  ]
  // `#1042` and `1042` both mean ticket number 1042. Anything else numeric-ish
  // (`1042abc`) is not a number and only gets the id/body branches.
  const numeric = trimmed.replace(/^#/, '')
  if (/^\d{1,9}$/.test(numeric)) or.push({ ticket: { is: { number: Number(numeric) } } })
  return { OR: or }
}

/**
 * Everything except the status segment. Split out because the `7a` toolbar's
 * `All 248 / Failed 7 / Retrying 2` counts must respect every OTHER active
 * filter — a count that ignored the date range or the search term would
 * contradict the table beneath it.
 */
function deliveryFiltersExceptStatus(input: {
  event?: string
  search?: string
  responseCodeMin?: number
  responseCodeMax?: number
  from?: string
  to?: string
}) {
  return {
    ...deliveryCreatedAtFilter(input),
    ...deliveryEventFilter(input.event),
    ...deliveryResponseCodeFilter(input),
    ...deliverySearchFilter(input.search),
  }
}

/**
 * `INGEST_WEBHOOK_MAX_ATTEMPTS` — the retry budget the `7a` table renders as
 * "3 of 5".
 *
 * The value is owned by the worker (`services/ingest/src/config.rs:203`,
 * `parse_or("INGEST_WEBHOOK_MAX_ATTEMPTS", 5)`), and there is no config table,
 * no shared config package and no API→ingest RPC to ask over. The three options
 * were: hardcode 5 in the web app (what shipped — a constant in
 * `WebhookDeliveryHistorySheet.tsx` that goes silently wrong the day anyone
 * tunes the env), add a column, or read the SAME env var from the control plane
 * with the SAME default. The last is the least-bad: in dev both processes read
 * the repo-root `.env`, in prod it is one variable set on two services, the
 * default matches so an unset var is still correct, and the number reaches the
 * client from the server instead of being duplicated in the UI.
 *
 * KEEP IN SYNC WITH `services/ingest/src/config.rs:203`. Read per call (not
 * module-level) so a test can set the env var without module-cache games.
 */
export function webhookMaxAttempts(): number {
  const raw = Number.parseInt(process.env.INGEST_WEBHOOK_MAX_ATTEMPTS ?? '', 10)
  return Number.isFinite(raw) && raw >= 1 ? raw : 5
}

/**
 * `INGEST_WEBHOOK_RETENTION_DAYS` — after this many days the retention job
 * NULLs the request/response bodies. Same env-mirroring rationale and
 * the same default as `webhookMaxAttempts`; surfaced so the page can explain
 * why a body search found nothing in an old range.
 *
 * KEEP IN SYNC WITH `services/ingest/src/config.rs`.
 */
export function webhookBodyRetentionDays(): number {
  const raw = Number.parseInt(process.env.INGEST_WEBHOOK_RETENTION_DAYS ?? '', 10)
  return Number.isFinite(raw) && raw >= 1 ? raw : 30
}

/**
 * Ceiling on one `exportCsv` call. tRPC has no streaming response here, so the
 * CSV is built in memory and shipped in the JSON body: 5000 delivery rows of
 * metadata is roughly 1MB, which a browser download handles and a Node heap
 * does not notice. Past that the answer is a narrower filter, not a bigger
 * response — and the cap rides back in the payload so the page says so.
 */
const EXPORT_CSV_ROW_CAP = 5000

// ── Rolling health ─────────────────────────────────────────────────

/** The four-tone health chip `6a`, `5a` and `5b`'s header all render. */
export type SupportWebhookHealth = 'idle' | 'healthy' | 'degraded' | 'failing'

/** One webhook's last-20 rollup, as the `health` CTE returns it. */
export type SupportWebhookHealthRollup = {
  considered: number
  failures: number
  p95LatencyMs: number | null
}

/**
 * Map a rolling last-20 rollup onto the health chip. ONE pure function, shared
 * by `6a`'s list, `5a`'s destination rows and `5b`'s sheet header, so the three
 * surfaces can never disagree about what "degraded" means — and so the
 * thresholds are unit-testable without a database.
 *
 * There is deliberately no stored `health` column: a delivery ages out of the
 * last-20 window with no write happening anywhere, so a persisted value goes
 * stale on its own and every consumer reads a lie.
 *
 * Order matters and is the spec's: `failures <= 1` wins before the latency
 * clause, so a fast-failing endpoint is never excused by a good p95 and a
 * healthy-but-slow one is not dragged below `healthy` by latency alone.
 */
export function supportWebhookHealth(rollup: SupportWebhookHealthRollup): SupportWebhookHealth {
  if (rollup.considered === 0) return 'idle'
  if (rollup.failures <= 1) return 'healthy'
  if (rollup.failures <= 5 || (rollup.p95LatencyMs ?? 0) > 3000) return 'degraded'
  return 'failing'
}

/** Raw row shape of the `health` CTE — Postgres `count()` arrives as `bigint`. */
type HealthRow = {
  webhookId: string
  considered: bigint | number
  failures: bigint | number
  p95_latency_ms: number | null
  last_delivery_at: Date | null
}

/** Raw row shape of the `stats` aggregate. */
type StatsRow = {
  delivered_24h: bigint | number
  delivered: bigint | number
  failed: bigint | number
  p95_latency_ms: number | null
}

/** `count()` comes back as a JS `bigint`; every caller wants a `number`. */
function toNumber(value: bigint | number | null | undefined): number {
  return value == null ? 0 : Number(value)
}

// ── Synchronous send-test ──────────────────────────────────────────
// `webhooks.test` used to enqueue a row and hand back a `deliveryId`, leaving
// the customer to go looking for the result. Frame `6b` renders the outcome
// inline, and must do it BEFORE the webhook is saved. Enqueue-and-poll cannot
// serve either requirement: the tRPC enqueue path publishes no NATS nudge (the
// worker's module doc is explicit that it relies on the sweep), so
// `INGEST_WEBHOOK_JOB_INTERVAL_SECS` (30s) would become the floor latency of
// every button click, it would couple an interactive control to ingest being
// up, and pre-save there is no row to enqueue at all. So this signs in Node and
// POSTs directly.

/** Matches `INGEST_WEBHOOK_REQUEST_TIMEOUT_SECS` and `6b`'s "a 2xx within 10s". */
const SEND_TEST_TIMEOUT_MS = 10_000

/** Same 64KB cut the worker applies, so both paths store comparable rows. */
const SEND_TEST_MAX_BODY_CHARS = 64 * 1024

type SendTestResult = {
  status: 'delivered' | 'failed'
  code: number | null
  latencyMs: number
  body: string
  bodyTruncated: boolean
  error: string | null
  /** The `SupportWebhookAttempt.outcome` vocabulary, shared with the worker. */
  outcome: string
  responseHeaders: Record<string, string>
}

/** Non-2xx classification, mirroring the worker's `classify`. */
function testOutcomeForStatus(code: number): string {
  if (code === 429) return 'rate_limited'
  if (code === 404 || code === 408 || code >= 500) return 'retryable_http'
  return 'fatal_http'
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

/**
 * POST the signed ping and capture everything frame `6b` and the history sheet
 * need. Latency is stopped after the response BODY is read, not at headers —
 * that is customer-perceived latency, and stopping early hides a slow-streaming
 * endpoint entirely.
 */
async function postWebhookTest(args: {
  url: string
  body: string
  headers: Record<string, string>
}): Promise<SendTestResult> {
  const startedAt = Date.now()
  try {
    const response = await fetch(args.url, {
      method: 'POST',
      headers: args.headers,
      body: args.body,
      signal: AbortSignal.timeout(SEND_TEST_TIMEOUT_MS),
    })
    const raw = await response.text()
    const latencyMs = Date.now() - startedAt
    const code = response.status
    const delivered = code >= 200 && code < 300
    return {
      status: delivered ? 'delivered' : 'failed',
      code,
      latencyMs,
      body: raw.slice(0, SEND_TEST_MAX_BODY_CHARS),
      bodyTruncated: raw.length > SEND_TEST_MAX_BODY_CHARS,
      error: delivered ? null : `Endpoint responded ${code}`,
      outcome: delivered ? 'delivered' : testOutcomeForStatus(code),
      responseHeaders: headersToObject(response.headers),
    }
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    const name = error instanceof Error ? error.name : ''
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    return {
      status: 'failed',
      code: null,
      latencyMs,
      body: '',
      bodyTruncated: false,
      error: timedOut
        ? `No response within ${SEND_TEST_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : 'Request failed',
      outcome: timedOut ? 'timeout' : 'network',
      responseHeaders: {},
    }
  }
}

// ── CSV export (7a "Export CSV") ────────────────────────────────────────────

/** The view the status chip renders — `'retrying'` derived, never stored. */
export function deliveryStatusView(row: {
  status: string
  attempts: number
}): 'delivered' | 'failed' | 'retrying' | 'pending' {
  if (row.status === 'delivered' || row.status === 'failed') return row.status
  return row.attempts > 0 ? 'retrying' : 'pending'
}

/** A structural subset of what `deliveries` selects — all the CSV needs. */
export type DeliveryCsvRow = {
  id: string
  event: string
  status: string
  attempts: number
  createdAt: Date | string
  ticketId: string | null
  lastStatusCode: number | null
  lastError: string | null
  isTest: boolean
  ticket?: { number: number; subject: string | null } | null
  attempts_?: Array<{ attempt: number; latencyMs: number }>
}

const DELIVERY_CSV_COLUMNS = [
  'delivery_id',
  'created_at',
  'event',
  'status',
  'attempt',
  'max_attempts',
  'response_code',
  'latency_ms',
  'ticket_number',
  'ticket_id',
  'ticket_subject',
  'is_test',
  'last_error',
] as const

/**
 * RFC4180 quoting, plus a leading `'` on anything a spreadsheet would evaluate
 * as a formula. `last_error` and `ticket_subject` are attacker-influenced text
 * (a customer's endpoint chooses its own error string), and `=cmd|…` in an
 * unquoted CSV cell is a real, boring way to get code run on the machine of the
 * person debugging a webhook.
 */
function csvCell(value: unknown): string {
  if (value == null) return ''
  const raw = value instanceof Date ? value.toISOString() : String(value)
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/**
 * Build the export body. Bodies and payloads are deliberately NOT columns: they
 * are unbounded (64KB each), they are the PII the retention job exists to purge,
 * and they are already one click away in the expanded row. The export is the
 * *index* of a failure window, not a second copy of the log.
 */
export function toDeliveryCsv(rows: DeliveryCsvRow[], maxAttempts: number): string {
  const lines = [DELIVERY_CSV_COLUMNS.join(',')]
  for (const row of rows) {
    const latest = row.attempts_?.[0]
    lines.push(
      [
        row.id,
        row.createdAt,
        row.event,
        deliveryStatusView(row),
        latest?.attempt ?? row.attempts,
        maxAttempts,
        row.lastStatusCode,
        latest?.latencyMs ?? null,
        row.ticket?.number ?? null,
        row.ticketId ?? null,
        row.ticket?.subject ?? null,
        row.isTest,
        row.lastError,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  // Trailing newline so `wc -l` and `tail` behave and the file ends cleanly.
  return `${lines.join('\n')}\n`
}

/** Raw row shape of the `volume` bucket query. */
type VolumeRow = {
  hour_start: Date
  delivered: bigint | number
  failed: bigint | number
}

/**
 * Hard ceiling on `volume`'s `generate_series`. The chart draws 24 bars; a
 * pasted URL carrying a year-wide range must not ask Postgres for 8760 rows and
 * the client for a chart it will not render.
 */
const VOLUME_MAX_BUCKETS = 168

const webhooksRouter = router({
  list: supportReadProcedure.input(listSupportWebhooksInput).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const rows = await pdb.supportWebhook.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    })
    // The secret never leaves the API after create — not even encrypted.
    return rows.map(publicWebhook)
  }),

  /**
   * The plaintext `secret` in this response is the ONLY time it is readable:
   * the stored copy is encrypted and `list` strips it. A customer who loses it
   * rotates by deleting and recreating the webhook.
   */
  create: supportProcedure.input(createSupportWebhookInput).mutation(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const secret = generateWebhookSecret()
    const row = await pdb.supportWebhook.create({
      data: {
        id: newId(),
        projectId: input.projectId,
        name: input.name,
        url: input.url,
        secret: encryptApiKey(secret),
        secretHint: secretHint(secret),
        events: input.events,
        active: true,
      },
    })
    return { ...publicWebhook(row), secret }
  }),

  update: supportProcedure.input(updateSupportWebhookInput).mutation(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    await requireWebhook(pdb, input.id)
    await pdb.supportWebhook.updateMany({
      where: { id: input.id, deletedAt: null },
      data: {
        ...(input.patch.name !== undefined && { name: input.patch.name }),
        ...(input.patch.url !== undefined && { url: input.patch.url }),
        ...(input.patch.events !== undefined && { events: input.patch.events }),
        ...(input.patch.active !== undefined && { active: input.patch.active }),
      },
    })
    const row = await pdb.supportWebhook.findFirstOrThrow({ where: { id: input.id } })
    return publicWebhook(row)
  }),

  /**
   * Mint a new signing secret, keeping the outgoing one alive as `v1` for 24h
   * (the worker's grace-window signing). Like `create`, the plaintext
   * is returned exactly once.
   *
   * A second rotation while a grace window is open is REFUSED rather than
   * queued or overwritten: `previousSecret` holds one slot, so the second
   * rotation would silently invalidate a secret the customer may still be
   * running — a security action causing an outage, which is the exact failure
   * mode the grace window exists to prevent.
   */
  rotateSecret: supportProcedure
    .input(rotateSupportWebhookSecretInput)
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const hook = await requireWebhook(pdb, input.id)
      const now = new Date()
      if (hook.previousSecretExpiresAt && hook.previousSecretExpiresAt.getTime() > now.getTime()) {
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'A rotation is already in its 24h grace window. Wait for it to end before rotating again.',
        })
      }
      const secret = generateWebhookSecret()
      await pdb.supportWebhook.updateMany({
        where: { id: hook.id, deletedAt: null },
        data: {
          secret: encryptApiKey(secret),
          previousSecret: hook.secret,
          secretRotatedAt: now,
          previousSecretExpiresAt: new Date(now.getTime() + SECRET_ROTATION_GRACE_MS),
          secretHint: secretHint(secret),
        },
      })
      const row = await pdb.supportWebhook.findFirstOrThrow({ where: { id: hook.id } })
      return { ...publicWebhook(row), secret }
    }),

  delete: supportProcedure.input(deleteSupportWebhookInput).mutation(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    await requireWebhook(pdb, input.id)
    await pdb.supportWebhook.updateMany({
      where: { id: input.id, deletedAt: null },
      data: { deletedAt: new Date() },
    })
    return { id: input.id, deleted: true }
  }),

  /**
   * POST a synthetic `ping` to the endpoint right now and return what came
   * back, so `6b` can render `200 OK in 214ms` inline. Replaces
   * `test`, which enqueued a row and returned a `deliveryId` — see the block
   * comment above `SEND_TEST_TIMEOUT_MS` for why enqueue-and-poll was rejected.
   *
   * Works with no saved row at all (`{ url, events }`), which is the whole
   * point: the customer tests the endpoint before committing to it.
   */
  sendTest: supportProcedure.input(sendSupportWebhookTestInput).mutation(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const hook = input.id ? await requireWebhook(pdb, input.id) : null
    const url = input.url ?? hook?.url
    if (!url) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'No endpoint URL to test.' })
    }

    // This is a user-supplied outbound fetch FROM the API host, i.e. textbook
    // SSRF reach. The guard is the shared one so the async worker gets the
    // identical admission rule.
    const admission = await admitWebhookUrl(url)
    if (!admission.ok) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: admission.message })
    }

    const deliveryId = newId()
    const sentAt = new Date()
    const timestamp = Math.floor(sentAt.getTime() / 1000)
    const payload = {
      type: 'ping',
      webhookId: hook?.id ?? null,
      projectId: input.projectId,
      events: input.events ?? hook?.events ?? [],
      at: sentAt.toISOString(),
    }
    // The signed bytes are the delivery payload verbatim, exactly as the worker
    // signs `due.payload` — sign a re-serialization and every signature drifts.
    const body = JSON.stringify(payload)

    // Signing needs the PLAINTEXT secret, so a saved webhook's ciphertext is
    // decrypted HERE and only here. Constraint 7 is about the read path: the
    // secret is never *returned* (`publicWebhook` strips both columns) and
    // never logged. With no saved row there is no secret yet, so the ping is
    // signed with a throwaway key — the pre-save test proves reachability and
    // header shape, not the customer's verification code.
    const signingSecret = hook ? decryptApiKey(hook.secret) : generateWebhookSecret()
    const previous =
      hook?.previousSecret && hook.previousSecretExpiresAt
        ? { secret: decryptApiKey(hook.previousSecret), expiresAt: hook.previousSecretExpiresAt }
        : null
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'clickroom-webhooks/1',
      'X-Clickroom-Delivery': deliveryId,
      'X-Clickroom-Event': 'ping',
      'X-Clickroom-Signature': webhookSignatureHeader(signingSecret, previous, timestamp, body),
    }

    const result = await postWebhookTest({ url, body, headers })

    // Only a saved webhook gets a history row — there is no `webhookId` to hang
    // one off before the first save. `status` is terminal on write (never
    // `'pending'`), so the sweep can never pick a test up and retry it.
    if (hook) {
      await pdb.supportWebhookDelivery.create({
        data: {
          id: deliveryId,
          webhookId: hook.id,
          ticketId: null,
          event: 'ping',
          payload,
          status: result.status,
          attempts: 1,
          lastError: result.error,
          lastStatusCode: result.code,
          nextAttemptAt: sentAt,
          isTest: true,
        },
      })
      await pdb.supportWebhookAttempt.create({
        data: {
          id: newId(),
          deliveryId,
          webhookId: hook.id,
          attempt: 1,
          startedAt: sentAt,
          latencyMs: result.latencyMs,
          responseCode: result.code,
          outcome: result.outcome,
          errorMessage: result.error,
          // Stored verbatim including `X-Clickroom-Signature`: the "signed
          // request" pane is what a customer debugging a verification failure
          // actually needs.
          requestHeaders: headers,
          requestBody: body,
          responseHeaders: result.responseHeaders,
          responseBody: result.body,
          bodyTruncated: result.bodyTruncated,
        },
      })
    }

    return {
      status: result.status,
      code: result.code,
      latencyMs: result.latencyMs,
      body: result.body,
      error: result.error,
      deliveryId: hook ? deliveryId : null,
    }
  }),

  /**
   * The delete guard's data: which forms route at this webhook.
   *
   * A separate read rather than a field on `delete`'s response, because the
   * confirm dialog has to name the affected forms BEFORE anything is deleted.
   *
   * Destinations live inside `SupportForm.definition` —
   * `routing.destinations[].webhookId`. `array_contains` compiles to jsonb `@>`,
   * which does object containment on array elements, so a destination carrying
   * extra keys still matches. If a Prisma upgrade ever changes that semantics,
   * the fallback is `$queryRaw` with
   * `"definition" -> 'routing' -> 'destinations' @> $2::jsonb` — which would
   * have to bind `"projectId" = $1` by hand, because `createScopedClient`'s
   * `$extends` rewrites `where` clauses on model calls only and does NOT cover
   * `$queryRaw` (constraint 4).
   */
  affectedForms: supportReadProcedure
    .input(supportWebhookAffectedFormsInput)
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      await requireWebhook(pdb, input.id)
      return pdb.supportForm.findMany({
        where: {
          deletedAt: null,
          definition: {
            path: ['routing', 'destinations'],
            array_contains: [{ webhookId: input.id }],
          },
        },
        select: { id: true, name: true },
        orderBy: { createdAt: 'asc' },
      })
    }),

  /**
   * Delivery history for one webhook. The only way a customer can answer "did my
   * endpoint actually get called, and what came back" — `lastError` /
   * `lastStatusCode` / `attempts` are the whole point, so nothing is truncated.
   * `requireWebhook` runs first so a hook in another project or a soft-deleted
   * one 404s instead of leaking that its id exists, matching `update`/`delete`.
   * The `webhook` relation is deliberately NOT joined: it carries the encrypted
   * `secret`, and `publicWebhook` is the only sanctioned way that row leaves.
   */
  deliveries: supportReadProcedure
    .input(listSupportWebhookDeliveriesInput)
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const hook = await requireWebhook(pdb, input.webhookId)
      // `status` is a filter VIEW, not the stored column: `'retrying'` is
      // derived (`pending` with at least one attempt behind it) and is never
      // written to a row — the worker's claim predicate is `status='pending'`
      // (`services/ingest/src/webhook_job.rs:226`), so a third stored value
      // would silently stop every retry.
      //
      // Filters split in two: everything EXCEPT the status segment, and the
      // segment itself. The `7a` toolbar renders `All 248 / Failed 7 /
      // Retrying 2`, and those counts have to respect the date range, the event
      // chip, the response-code range and the search term — but obviously not
      // the segment you are standing on.
      const shared = { webhookId: hook.id, ...deliveryFiltersExceptStatus(input) }
      const where = { ...shared, ...deliveryStatusFilter(input.status) }
      const [rows, grouped, retrying, purgedDeliveries] = await Promise.all([
        pdb.supportWebhookDelivery.findMany({
          where,
          // `id` breaks the tie so a cursor page is stable when two deliveries
          // share a `createdAt` (a fan-out enqueues them in the same tick).
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
          include: {
            // The ticket number + subject the `5b` row renders under the event
            // name. Denormalizing them onto the delivery is an explicit phase
            // non-goal — the relation already exists and one `include` provides
            // both without touching either enqueue writer.
            ticket: { select: { number: true, subject: true } },
            // Newest attempt first, so "Attempt 3 of 5" and the expanded
            // request/response panes read `[0]` without re-sorting client-side.
            attempts_: { orderBy: { attempt: 'desc' } },
          },
        }),
        // The segment counts. They live HERE rather than on a sibling procedure
        // for one reason: the page renders the table and the segments from a
        // single view, so two procedures would mean two round trips that can
        // disagree mid-flight — a `Failed 7` beside a table that already shows
        // 8. Same `where` builder, one call, one consistent snapshot. It is also
        // the same rule constraint 8 states for the list page: one read per
        // surface, not one per widget.
        pdb.supportWebhookDelivery.groupBy({
          by: ['status'],
          where: shared,
          _count: { _all: true },
        }),
        // `'retrying'` cannot come out of that `groupBy` — it is not a stored
        // status (constraint 1), it is `pending AND attempts > 0` — so it is one
        // extra count rather than a third status value on the row.
        pdb.supportWebhookDelivery.count({
          where: { ...shared, status: 'pending', attempts: { gt: 0 } },
        }),
        // Only when searching: how many deliveries in this view have had their
        // bodies purged (NULLs them at 30 days). A body search cannot
        // match those rows, and the page has to be able to say so rather than
        // report "no results" for a delivery whose body simply no longer exists.
        input.search
          ? pdb.supportWebhookDelivery.count({
              where: {
                webhookId: hook.id,
                ...deliveryStatusFilter(input.status),
                ...deliveryCreatedAtFilter(input),
                ...deliveryEventFilter(input.event),
                ...deliveryResponseCodeFilter(input),
                attempts_: { some: { bodiesPurgedAt: { not: null } } },
              },
            })
          : Promise.resolve(0),
      ])
      const byStatus = new Map(grouped.map((g) => [g.status, g._count._all]))
      const counts = {
        all: grouped.reduce((sum, g) => sum + g._count._all, 0),
        delivered: byStatus.get('delivered') ?? 0,
        failed: byStatus.get('failed') ?? 0,
        retrying,
      }
      // "Showing 1–9 of 248" is by definition the count of the segment you are
      // on, which the segment counts already hold — so no separate `count()`.
      const total = counts[input.status]
      const hasMore = rows.length > input.limit
      // `payload` rides along unredacted: it is the customer's own ticket data
      // (subject, body, distinctId), i.e. end-user PII — inspecting exactly what
      // was POSTed is the reason this log exists. Gated by `projects:read`.
      const items = hasMore ? rows.slice(0, input.limit) : rows
      return {
        items,
        total,
        nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
        counts,
        // The retry budget "3 of 5" reads against, from the worker's own env
        // rather than a constant in the UI — see `webhookMaxAttempts`.
        maxAttempts: webhookMaxAttempts(),
        search: input.search
          ? {
              term: input.search,
              purgedDeliveries,
              retentionDays: webhookBodyRetentionDays(),
            }
          : null,
      }
    }),

  /**
   * Hourly delivery volume for the `7a` stacked bar chart.
   *
   * `generate_series` over the hour boundaries is the whole point: the chart
   * draws 24 bars unconditionally, so an hour with no deliveries has to arrive
   * as `{ delivered: 0, failed: 0 }` rather than be missing and shift every bar
   * after it. That is also why the deliveries are LEFT JOINed onto the buckets
   * instead of being grouped and back-filled in TS.
   *
   * `isTest` is excluded, matching the health rollup: a Send test burst against
   * a staging URL must not paint an incident window that never happened.
   */
  volume: supportReadProcedure.input(supportWebhookVolumeInput).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const hook = await requireWebhook(pdb, input.webhookId)
    const from = input.from ? new Date(input.from) : null
    const to = input.to ? new Date(input.to) : null
    // TENANCY: raw query — `createScopedClient`'s `$extends` rewrites `where`
    // clauses on MODEL calls only and does NOT cover `$queryRaw` (constraint 4).
    // `requireWebhook` above has already proved the hook belongs to this
    // project, and the `EXISTS` below re-binds `w."projectId"` by hand inside
    // the join so the predicate survives even if this query is ever copied
    // somewhere `requireWebhook` does not run.
    //
    // The projectId check sits in the LEFT JOIN's ON clause, not the WHERE:
    // in the WHERE it would filter away the empty buckets, which are the
    // reason this query exists.
    const rows = await pdb.$queryRaw<VolumeRow[]>`
      WITH bounds AS (
        SELECT date_trunc('hour', COALESCE(${to}::timestamptz, now())) AS to_hour
      ),
      win AS (
        SELECT to_hour,
               GREATEST(
                 date_trunc('hour', COALESCE(${from}::timestamptz, to_hour - interval '23 hours')),
                 to_hour - make_interval(hours => ${VOLUME_MAX_BUCKETS - 1})
               ) AS from_hour
          FROM bounds
      ),
      buckets AS (
        SELECT generate_series(from_hour, to_hour, interval '1 hour') AS hour_start FROM win
      )
      SELECT b.hour_start                                          AS hour_start,
             count(d."id") FILTER (WHERE d."status" = 'delivered') AS delivered,
             count(d."id") FILTER (WHERE d."status" = 'failed')    AS failed
        FROM buckets b
        LEFT JOIN "SupportWebhookDelivery" d
          ON d."webhookId" = ${hook.id}
         AND d."isTest" = false
         AND d."createdAt" >= b.hour_start
         AND d."createdAt" <  b.hour_start + interval '1 hour'
         AND EXISTS (
           SELECT 1 FROM "SupportWebhook" w
            WHERE w."id" = d."webhookId"
              AND w."projectId" = ${input.projectId}
              AND w."deletedAt" IS NULL
         )
       GROUP BY b.hour_start
       ORDER BY b.hour_start ASC
    `
    return rows.map((row) => ({
      hourStart: row.hour_start,
      delivered: toNumber(row.delivered),
      failed: toNumber(row.failed),
    }))
  }),

  /**
   * Export the CURRENT VIEW as CSV. The acceptance check is explicit that this
   * respects the ACTIVE FILTERS rather than the page on screen, so it takes the
   * same filter fields as `deliveries` and runs them through the same `where`
   * builder — no cursor, no limit.
   *
   * Returns the file as a string rather than streaming it. tRPC's JSON
   * transport has no streaming response here, and adding a REST download route
   * for this would mean a second auth/tenancy path for one button. The
   * bounded-response version of that trade is `EXPORT_CSV_ROW_CAP`: the newest
   * 5000 matching rows, with `capped` in the payload so the page can tell the
   * customer to narrow the range instead of quietly handing them a truncated
   * file.
   */
  exportCsv: supportReadProcedure
    .input(exportSupportWebhookDeliveriesInput)
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const hook = await requireWebhook(pdb, input.webhookId)
      const where = {
        webhookId: hook.id,
        ...deliveryStatusFilter(input.status),
        ...deliveryFiltersExceptStatus(input),
      }
      const rows = await pdb.supportWebhookDelivery.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: EXPORT_CSV_ROW_CAP + 1,
        include: {
          ticket: { select: { number: true, subject: true } },
          // Only the newest attempt: the CSV carries "attempt N" and the
          // latency the customer saw, not the whole per-attempt history.
          attempts_: { orderBy: { attempt: 'desc' }, take: 1 },
        },
      })
      const capped = rows.length > EXPORT_CSV_ROW_CAP
      const items = capped ? rows.slice(0, EXPORT_CSV_ROW_CAP) : rows
      const maxAttempts = webhookMaxAttempts()
      return {
        csv: toDeliveryCsv(items as unknown as DeliveryCsvRow[], maxAttempts),
        rowCount: items.length,
        cap: EXPORT_CSV_ROW_CAP,
        capped,
        maxAttempts,
        filename: `webhook-deliveries-${hook.id}-${new Date().toISOString().slice(0, 10)}.csv`,
      }
    }),

  /**
   * Rolling health for EVERY webhook in the project in ONE query (constraint 8:
   * `6a` and `RoutingCard` each run one `list` + one `health`, never a
   * per-webhook `deliveries` call).
   *
   * Raw because Prisma cannot express "the last 20 deliveries per webhook" —
   * `groupBy` has no window functions. Tests are excluded (`isTest = false`) so
   * hammering Send test at a broken staging URL cannot drag a production
   * endpoint's chip down, and the p95 comes off the LAST attempt of each
   * delivery, which is the one whose latency the customer actually saw.
   *
   * A webhook with no deliveries at all has no row here; `supportWebhookHealth`
   * maps `considered === 0` to `'idle'`, which is what the caller renders for a
   * missing entry.
   */
  health: supportReadProcedure.input(supportWebhookHealthInput).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    // TENANCY: `createScopedClient`'s `$extends` rewrites `where` clauses on
    // MODEL calls only — it does NOT cover `$queryRaw` (constraint 4). The
    // `w."projectId" = $1` bind below is the whole tenant boundary for this
    // query; deleting it silently exposes every project's webhook health.
    const rows = await pdb.$queryRaw<HealthRow[]>`
      WITH ranked AS (
        SELECT d."webhookId", d."status", d."createdAt", a."latencyMs",
               row_number() OVER (PARTITION BY d."webhookId"
                                  ORDER BY d."createdAt" DESC, d."id" DESC) AS rn
          FROM "SupportWebhookDelivery" d
          JOIN "SupportWebhook" w ON w."id" = d."webhookId"
          LEFT JOIN LATERAL (
            SELECT x."latencyMs" FROM "SupportWebhookAttempt" x
             WHERE x."deliveryId" = d."id" ORDER BY x."attempt" DESC LIMIT 1
          ) a ON true
         WHERE w."projectId" = ${input.projectId}
           AND w."deletedAt" IS NULL
           AND d."isTest" = false
      )
      SELECT "webhookId",
             count(*)                                                  AS considered,
             count(*) FILTER (WHERE "status" = 'failed')               AS failures,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY "latencyMs") AS p95_latency_ms,
             max("createdAt")                                          AS last_delivery_at
        FROM ranked WHERE rn <= 20 GROUP BY "webhookId"
    `
    return rows.map((row) => {
      const rollup = {
        considered: toNumber(row.considered),
        failures: toNumber(row.failures),
        p95LatencyMs: row.p95_latency_ms == null ? null : Number(row.p95_latency_ms),
      }
      return {
        webhookId: row.webhookId,
        ...rollup,
        lastDeliveryAt: row.last_delivery_at,
        health: supportWebhookHealth(rollup),
      }
    })
  }),

  /**
   * The history sheet's four stat cards, over a USER-CHOSEN window — which is
   * exactly why this is separate from `health`, whose window is fixed at the
   * last 20 deliveries. One aggregate with `FILTER` clauses rather than four
   * counts.
   *
   * `delivered24h` deliberately ignores `from`/`to`: the card says "Delivered
   * (24h)", so scoping it to the filter would make the label a lie.
   */
  stats: supportReadProcedure.input(supportWebhookStatsInput).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const hook = await requireWebhook(pdb, input.webhookId)
    const from = input.from ? new Date(input.from) : null
    const to = input.to ? new Date(input.to) : null
    // TENANCY: raw query — `$extends` does NOT cover `$queryRaw` (constraint 4),
    // so `w."projectId"` is bound by hand here even though `requireWebhook`
    // above has already proved the hook belongs to this project.
    const [row] = await pdb.$queryRaw<StatsRow[]>`
      SELECT
        count(*) FILTER (
          WHERE d."status" = 'delivered' AND d."createdAt" >= now() - interval '24 hours'
        )                                                         AS delivered_24h,
        count(*) FILTER (WHERE d."status" = 'delivered')          AS delivered,
        count(*) FILTER (WHERE d."status" = 'failed')             AS failed,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY a."latencyMs") AS p95_latency_ms
      FROM "SupportWebhookDelivery" d
      JOIN "SupportWebhook" w ON w."id" = d."webhookId"
      LEFT JOIN LATERAL (
        SELECT x."latencyMs" FROM "SupportWebhookAttempt" x
         WHERE x."deliveryId" = d."id" ORDER BY x."attempt" DESC LIMIT 1
      ) a ON true
      WHERE w."projectId" = ${input.projectId}
        AND w."id" = ${hook.id}
        AND w."deletedAt" IS NULL
        AND d."isTest" = false
        AND (${from}::timestamptz IS NULL OR d."createdAt" >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR d."createdAt" <= ${to}::timestamptz)
    `
    const delivered = toNumber(row?.delivered)
    const failed = toNumber(row?.failed)
    const terminal = delivered + failed
    return {
      delivered24h: toNumber(row?.delivered_24h),
      failed,
      // Pending deliveries are not a failure yet, so they are out of the
      // denominator entirely — a queue backlog must not read as a success dip.
      successRate: terminal === 0 ? 0 : delivered / terminal,
      p95LatencyMs: row?.p95_latency_ms == null ? null : Number(row.p95_latency_ms),
    }
  }),

  /**
   * Requeue ONE delivery. `attempts = 0` rewinds the backoff schedule so the
   * retry goes out on the next sweep instead of inheriting the 6h tail, and the
   * delivery id — the customer's `X-Clickroom-Delivery` idempotency key
   * (constraint 2) — is deliberately unchanged.
   */
  retry: supportProcedure
    .input(retrySupportWebhookDeliveryInput)
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const hook = await requireWebhook(pdb, input.webhookId)
      const { count } = await pdb.supportWebhookDelivery.updateMany({
        where: { id: input.deliveryId, webhookId: hook.id },
        data: { status: 'pending', attempts: 0, nextAttemptAt: new Date() },
      })
      if (count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Delivery not found.' })
      return { deliveryId: input.deliveryId, requeued: true }
    }),

  /**
   * Requeue the failed backlog, CAPPED (`RETRY_ALL_CAP`) so one click at a dead
   * endpoint cannot queue 100k deliveries. The cap rides back in the response so
   * the toolbar can say "requeued 500 of the failed deliveries — run it again
   * for the rest" rather than silently doing part of the job.
   *
   * Oldest-first, so repeated invocations drain the backlog in creation order
   * instead of re-picking the same newest 500 forever.
   */
  retryAllFailed: supportProcedure
    .input(retryAllFailedSupportWebhookDeliveriesInput)
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const hook = await requireWebhook(pdb, input.webhookId)
      const where = {
        webhookId: hook.id,
        status: 'failed',
        ...deliveryCreatedAtFilter(input),
      }
      // Prisma has no LIMIT on `updateMany`, so the cap is expressed as a
      // bounded id read followed by a single `IN` update.
      const targets = await pdb.supportWebhookDelivery.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: RETRY_ALL_CAP,
        select: { id: true },
      })
      const { count } = await pdb.supportWebhookDelivery.updateMany({
        where: { id: { in: targets.map((t) => t.id) } },
        data: { status: 'pending', attempts: 0, nextAttemptAt: new Date() },
      })
      return { requeued: count, cap: RETRY_ALL_CAP, capped: count >= RETRY_ALL_CAP }
    }),

  /**
   * Clear an auto-disable and replay the backlog IN ORDER (`5c`'s
   * "Re-enable & replay").
   *
   * Pausing already queues rather than drops — the sweep's `due_select!` filters
   * on `w."active"` (`services/ingest/src/webhook_job.rs:226-230`), so the rows
   * sat `pending` the whole time and nothing was lost. The only thing missing
   * was ordering: without the stagger every queued delivery becomes due at the
   * same `now()` and the worker's `ORDER BY d."nextAttemptAt" ASC, d."createdAt"
   * ASC` has nothing left to order by within the tie.
   *
   * One transaction so the endpoint can never come back active with an
   * un-staggered backlog behind it.
   */
  reEnableAndReplay: supportProcedure
    .input(reEnableSupportWebhookInput)
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const hook = await requireWebhook(pdb, input.id)
      const replayed = await pdb.$transaction(async (tx) => {
        await tx.supportWebhook.updateMany({
          where: { id: hook.id, deletedAt: null },
          data: { active: true, autoDisabledAt: null, consecutiveFailures: 0 },
        })
        // TENANCY: raw — `$extends` does NOT cover `$executeRaw` (constraint 4).
        // The scope here is the webhook id, which `requireWebhook` has already
        // proved belongs to this project; the delivery table carries no
        // `projectId` by design, so `webhookId` IS the boundary.
        //
        // `row_number()` over `createdAt ASC` spreads the backlog one second
        // apart so it drains in creation order.
        return tx.$executeRaw`
          UPDATE "SupportWebhookDelivery" d
             SET "attempts" = 0,
                 "nextAttemptAt" = now() + make_interval(secs => r.rn - 1)
            FROM (SELECT "id", row_number() OVER (ORDER BY "createdAt" ASC) rn
                    FROM "SupportWebhookDelivery"
                   WHERE "webhookId" = ${hook.id} AND "status" = 'pending') r
           WHERE d."id" = r."id"
        `
      })
      return { id: hook.id, active: true, replayed }
    }),
})

// ── results.* ───────────────────────────────────────────────────────────────
// `openCount` and `firstReplyTime` are ticket-STATE reads, so they come from
// Postgres (is explicit about this); deflection/trend/category/CSAT are
// event aggregates and come from the ClickHouse builders. Reads are gated by
// `supportReadProcedure` (projects:read + feature:support).
const resultsRouter = router({
  /**
   * Tickets currently awaiting an agent (`open` + `pending`). This is a snapshot
   * of live state, so `range` is accepted for input-shape parity with the other
   * results procedures but deliberately not applied — an "open tickets" stat card
   * filtered to last week would under-report the queue.
   */
  openCount: supportReadProcedure.input(supportResultsInput).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const rows = await pdb.supportTicket.findMany({
      where: { formId: input.formId, status: { in: ['open', 'pending'] } },
      select: { id: true, status: true },
    })
    return {
      open: rows.filter((r) => r.status === 'open').length,
      pending: rows.filter((r) => r.status === 'pending').length,
      total: rows.length,
    }
  }),

  /** Median seconds from ticket creation to the first agent reply, over the range. */
  firstReplyTime: supportReadProcedure.input(supportResultsInput).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const rows = await pdb.supportTicket.findMany({
      where: {
        formId: input.formId,
        firstReplyAt: { not: null },
        createdAt: { gte: new Date(input.range.from), lte: new Date(input.range.to) },
      },
      select: { createdAt: true, firstReplyAt: true },
    })
    const seconds = rows
      .map((r) => firstReplySeconds(r as { createdAt: Date; firstReplyAt: Date | null }))
      .filter((s): s is number => s != null)
    return { replied: seconds.length, medianSeconds: median(seconds) }
  }),

  deflectionRate: supportReadProcedure.input(supportResultsInput).query(async ({ input, ctx }) => {
    await scopedForProject(ctx, input.projectId)
    const range = toChRange(input.range)
    const rs = await clickhouse.query({
      ...buildSupportDeflectionRate({
        projectId: input.projectId,
        formId: input.formId,
        from: range.from,
        to: range.to,
      }),
      format: 'JSONEachRow',
    })
    const [row] = await rs.json<{
      opened: string
      deflected: string
      ticketed: string
      rate: string
    }>()
    return {
      opened: Number(row?.opened ?? 0),
      deflected: Number(row?.deflected ?? 0),
      ticketed: Number(row?.ticketed ?? 0),
      rate: Number(row?.rate ?? 0),
    }
  }),

  trend: supportReadProcedure.input(supportTrendInput).query(async ({ input, ctx }) => {
    await scopedForProject(ctx, input.projectId)
    const range = toChRange(input.range)
    const rs = await clickhouse.query({
      ...buildSupportVolumeTrend({
        projectId: input.projectId,
        formId: input.formId,
        interval: input.interval,
        from: range.from,
        to: range.to,
      }),
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{
      bucket: string
      shown: string
      opened: string
      deflected: string
      created: string
      resolved: string
    }>()
    return rows.map((r) => ({
      bucket: r.bucket,
      shown: Number(r.shown),
      opened: Number(r.opened),
      deflected: Number(r.deflected),
      created: Number(r.created),
      resolved: Number(r.resolved),
    }))
  }),

  volumeByCategory: supportReadProcedure
    .input(supportResultsInput)
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const range = toChRange(input.range)
      const rs = await clickhouse.query({
        ...buildSupportVolumeByCategory({
          projectId: input.projectId,
          formId: input.formId,
          from: range.from,
          to: range.to,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ value: string; count: string; users: string }>()
      return rows.map((r) => ({ value: r.value, count: Number(r.count), users: Number(r.users) }))
    }),

  /**
   * Bug-vs-conversation split, from POSTGRES — deliberately not the
   * ClickHouse `support_events` table its `volumeByCategory` neighbour reads.
   *
   * `support_events` is fed by a materialized view that only populates from rows
   * inserted after it existed (`013_support_events.sql:22-25`), so a CH-backed
   * by-type chart would park every pre-phase ticket in an empty bucket forever.
   * Postgres is the source of truth for tickets, the aggregate is trivial, and it
   * works retroactively against backfill. The CH columns still land
   * — for the funnel, which only CH can answer.
   *
   * Response mirrors `volumeByCategory`'s `{ value, count }` row so the analytics
   * pane consumes it identically. There is no `users` count: distinct-user
   * attribution lives in ClickHouse, and a fabricated zero would read as real.
   */
  volumeByType: supportReadProcedure.input(supportResultsInput).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const rows = await pdb.supportTicket.groupBy({
      by: ['type'],
      where: {
        formId: input.formId,
        createdAt: { gte: new Date(input.range.from), lte: new Date(input.range.to) },
      },
      _count: { _all: true },
    })
    return rows
      .map((r) => ({ value: r.type, count: r._count._all }))
      .sort((a, b) => b.count - a.count)
  }),

  csat: supportReadProcedure.input(supportResultsInput).query(async ({ input, ctx }) => {
    await scopedForProject(ctx, input.projectId)
    const range = toChRange(input.range)
    const rs = await clickhouse.query({
      ...buildSupportCsat({
        projectId: input.projectId,
        formId: input.formId,
        from: range.from,
        to: range.to,
      }),
      format: 'JSONEachRow',
    })
    const [row] = await rs.json<{
      responses: string
      average: string
      topBox: string
      score: string
    }>()
    return {
      responses: Number(row?.responses ?? 0),
      average: Number(row?.average ?? 0),
      topBox: Number(row?.topBox ?? 0),
      score: Number(row?.score ?? 0),
    }
  }),
})

export const supportRouter = router({
  list: supportReadProcedure.input(listSupportFormsInput).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    return pdb.supportForm.findMany({
      where: {
        deletedAt: null,
        ...(input.status !== undefined && { status: input.status }),
      },
      orderBy: { name: 'asc' },
    })
  }),

  get: supportReadProcedure.input(getSupportFormInput).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    return requireForm(pdb, input.id)
  }),

  create: supportProcedure.input(createSupportFormInput).mutation(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    // The linked flag must exist in EVERY environment — capture resolves flags
    // per-env by key, so a key present only in the default env is invisible to
    // an SDK pointed anywhere else. The form's `featureFlagId` points at the
    // DEFAULT env's row so the builder's "Advanced targeting" link resolves.
    const environments = await pdb.environment.findMany({ where: { projectId: input.projectId } })
    const defaultEnv = await defaultEnvironment(pdb, input.projectId)

    const formId = newId()
    const flagInputs = buildLinkedFlagInputs({
      projectId: input.projectId,
      name: input.name,
      formId,
      environments,
    })
    const defaultFlagId =
      flagInputs.find((f) => f.environmentId === defaultEnv.id)?.id ?? flagInputs[0]?.id

    // Flag-creates + form-create run in ONE transaction so a mid-failure never
    // leaves orphaned flags with no form (or vice versa). Prisma extensions
    // propagate through `$transaction`, so tenant scoping still applies inside.
    const { createdFlags, form } = await pdb.$transaction(async (tx) => {
      const createdFlags = []
      for (const data of flagInputs) {
        createdFlags.push(await tx.featureFlag.create({ data }))
      }
      const form = await tx.supportForm.create({
        data: {
          id: formId,
          projectId: input.projectId,
          name: input.name,
          description: input.description ?? null,
          status: 'draft',
          definition: input.definition,
          version: 1,
          featureFlagId: defaultFlagId,
          createdBy: ctx.tokenPayload?.sub ?? '',
        },
      })
      return { createdFlags, form }
    })

    await rebuildCachesForEnvironments(pdb, input.projectId, environments)
    await auditLinkedFlags(pdb, {
      projectId: input.projectId,
      actorUserId: ctx.tokenPayload?.sub ?? '',
      action: 'created',
      rows: createdFlags,
      after: (row) => ({ active: row.active, filters: row.filters }),
      versionDelta: 0,
    })

    return form
  }),

  update: supportProcedure.input(updateSupportFormInput).mutation(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const existing = await requireForm(pdb, input.id)

    const { key: flagKey, rows: flagRows } = await resolveLinkedFlags(
      pdb,
      input.projectId,
      existing.featureFlagId,
    )

    // `active` when the form is running, off when draft/archived. Only touch the
    // flags when `status` is being changed AND at least one row differs from the
    // desired value — no flag churn on a name/definition-only edit.
    const desiredActive = input.patch.status === 'active'
    const flagActiveChanges =
      flagKey != null &&
      input.patch.status !== undefined &&
      flagRows.some((f) => f.active !== desiredActive)

    await pdb.$transaction(async (tx) => {
      const { count } = await tx.supportForm.updateMany({
        where: { id: input.id, deletedAt: null },
        data: {
          ...(input.patch.name !== undefined && { name: input.patch.name }),
          ...(input.patch.description !== undefined && { description: input.patch.description }),
          ...(input.patch.status !== undefined && { status: input.patch.status }),
          // Every definition edit bumps `version` so the SDK's localStorage
          // version gate re-fetches the changed config.
          ...(input.patch.definition !== undefined && {
            definition: input.patch.definition,
            version: { increment: 1 },
          }),
        },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Support form not found.' })
      }
      if (flagActiveChanges && flagKey) {
        await tx.featureFlag.updateMany({
          where: { projectId: input.projectId, key: flagKey, deletedAt: null },
          data: { active: desiredActive, version: { increment: 1 } },
        })
      }
    })

    if (flagActiveChanges) {
      await rebuildCachesForEnvironments(
        pdb,
        input.projectId,
        flagRows.map((f) => f.environment),
      )
      await auditLinkedFlags(pdb, {
        projectId: input.projectId,
        actorUserId: ctx.tokenPayload?.sub ?? '',
        action: 'updated',
        rows: flagRows,
        after: () => ({ active: desiredActive }),
        versionDelta: 1,
      })
    }

    return pdb.supportForm.findFirstOrThrow({ where: { id: input.id } })
  }),

  delete: supportProcedure.input(deleteSupportFormInput).mutation(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const existing = await requireForm(pdb, input.id)

    // A form's linked flags are private to the form (unlike an experiment's,
    // which may have other consumers) — soft-delete both together.
    const { key: flagKey, rows: flagRows } = await resolveLinkedFlags(
      pdb,
      input.projectId,
      existing.featureFlagId,
    )

    await pdb.$transaction(async (tx) => {
      await tx.supportForm.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { deletedAt: new Date() },
      })
      if (flagKey) {
        await tx.featureFlag.updateMany({
          where: { projectId: input.projectId, key: flagKey, deletedAt: null },
          data: { deletedAt: new Date(), version: { increment: 1 } },
        })
      }
    })

    if (flagRows.length > 0) {
      await rebuildCachesForEnvironments(
        pdb,
        input.projectId,
        flagRows.map((f) => f.environment),
      )
      await auditLinkedFlags(pdb, {
        projectId: input.projectId,
        actorUserId: ctx.tokenPayload?.sub ?? '',
        action: 'deleted',
        rows: flagRows,
        after: () => null,
        versionDelta: 1,
      })
    }

    return { id: input.id, deleted: true }
  }),

  tickets: ticketsRouter,
  webhooks: webhooksRouter,
  results: resultsRouter,
})
