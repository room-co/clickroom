import { keepPreviousData } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Clock,
  Download,
  Eye,
  Filter,
  Flag,
  Inbox,
  IndentIncrease,
  LayoutDashboard,
  Loader2,
  LogIn,
  MessageSquare,
  Paperclip,
  ShoppingBag,
  TriangleAlert,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import { DateRangeControl } from '@/components/DateRangeControl'
import { SkeletonCard, SkeletonChart, SkeletonList } from '@/components/skeletons'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { useUrlDateRange } from '@/hooks/useUrlDateRange'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'
import { formatDuration, type SupportFormRow, type SupportTicketStatus } from './types'

// Frame 1f ("Inbox & results — tickets with attached user context"). Every px /
// hex / weight below is lifted from the prototype markup; where the design
// bundle's README disagrees with the HTML, the HTML wins.

type Tab = 'inbox' | 'analytics'
type SortOrder = 'newest' | 'oldest'

/*he ticket discriminator, mirrored from `supportTicketTypeSchema`. */
type TicketType = 'conversation' | 'bug'
type TicketSeverity = 'blocker' | 'major' | 'minor'
type TicketPriority = 'low' | 'normal' | 'high' | 'urgent'
type TypeTab = 'all' | TicketType

const TICKET_STATUSES: readonly SupportTicketStatus[] = ['open', 'pending', 'resolved', 'closed']
const TICKET_SEVERITIES: readonly TicketSeverity[] = ['blocker', 'major', 'minor']
const TICKET_PRIORITIES: readonly TicketPriority[] = ['urgent', 'high', 'normal', 'low']

interface TicketRow {
  id: string
  number: number
  subject: string
  status: SupportTicketStatus
  priority: string
  category: string
  /** `'conversation' | 'bug'` — Prisma defaults it, so rows are never missing it. */
  type: TicketType
  /** Bug-only; `null` on a conversation. */
  severity: TicketSeverity | null
  distinctId: string
  assigneeId: string | null
  firstReplyAt: string | Date | null
  unreadForAgent: number
  createdAt: string | Date
}

/** The `bugReport` blob `tickets.get` returns (validated server-side). */
interface BugEnvironment {
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
interface BugConsoleEntry {
  level: 'error' | 'warn'
  message: string
  timestamp: string
  source?: string
}
interface BugNetworkEntry {
  method: string
  url: string
  /** `null` = rejected/aborted — the request never reached a status. */
  status: number | null
  durationMs?: number
  timestamp: string
  error?: string
}
interface BugReport {
  capturedAt: string
  environment?: BugEnvironment
  consoleErrors?: BugConsoleEntry[]
  networkErrors?: BugNetworkEntry[]
}

interface TicketMessage {
  id: string
  authorType: string
  authorUserId: string | null
  body: string
  createdAt: string | Date
}

// ── Frame-literal style fragments ────────────────────────────────────────────

/** `#8a8aa6` — secondary body copy. No theme token maps to it, so it stays an arbitrary value rather than being rounded
 *  to `text-muted-foreground` (`#6B6B8A`). */
const SECONDARY = 'text-[#8a8aa6]'

/** Section heading in the context rail: 10px/600, `.06em`, uppercase. */
const RAIL_HEADING = 'text-[10px] font-semibold uppercase tracking-[.06em] text-muted-foreground'

/** `cat()` from the prototype script — text + 14%-tint background per category. */
const CATEGORY_CHIP: Record<string, string> = {
  bug: 'text-destructive bg-destructive/[.14]',
  billing: 'text-chart-3 bg-chart-3/[.14]',
  feature: 'text-chart-2 bg-chart-2/[.14]',
  question: 'text-chart-5 bg-chart-5/[.14]',
}
const CATEGORY_CHIP_FALLBACK = 'text-muted-foreground bg-muted'

/** Priority chip. Only "High" is specified in the frame (amber on a 14% tint). */
const PRIORITY_CHIP: Record<string, string> = {
  urgent: 'text-destructive bg-destructive/[.14]',
  high: 'text-chart-3 bg-chart-3/[.14]',
  normal: 'text-chart-5 bg-chart-5/[.14]',
  low: 'text-muted-foreground bg-muted',
}

/** Severity chip (bug-only). Same 14%-tint shape as the category/priority chips. */
const SEVERITY_CHIP: Record<TicketSeverity, string> = {
  blocker: 'text-destructive bg-destructive/[.14]',
  major: 'text-chart-3 bg-chart-3/[.14]',
  minor: 'text-muted-foreground bg-muted',
}

/** Avatar palette for ticket initials (tokens.md, addressed by hash so the
 *  same person keeps the same colour between renders. */
const AVATAR_BG = ['bg-primary', 'bg-chart-2', 'bg-chart-3', 'bg-[#6B6B8A]', 'bg-chart-5']

const STATUS_BADGE_CLASS: Record<string, string> = {
  active: 'bg-primary text-primary-foreground',
  draft: 'bg-muted text-muted-foreground',
  archived: 'bg-muted text-muted-foreground',
}

// ── Small pure helpers ───────────────────────────────────────────────────────

function hashIndex(value: string, buckets: number): number {
  let h = 0
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0
  return Math.abs(h) % buckets
}

/** `SC` for "sara chen" / "sara@acme.co", `?` for an anonymous distinct id. */
function initialsOf(value: string | undefined): string {
  if (!value) return '?'
  const cleaned = value.replace(/^(anon|anonymous)[-_]?/i, '').trim()
  if (!cleaned || /^[0-9a-f-]{16,}$/i.test(cleaned)) return '?'
  const words = cleaned.split(/[\s._@-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/** Ticket-list timestamps in the frame are bare: `2m`, `1h`, `3h`, `1d`. */
function shortRelative(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const seconds = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** Thread + meta line use the long form: `2m ago`. */
function longRelative(value: string | Date): string {
  const short = shortRelative(value)
  return short ? `${short} ago` : ''
}

/** The agent's 1f unread badge: `unreadForAgent` is bumped by end-user activity
 *  and cleared to 0 server-side by `tickets.get` the moment the agent opens the
 *  ticket. */
function isUnread(t: TicketRow): boolean {
  return (t.unreadForAgent ?? 0) > 0
}
function isResolved(t: TicketRow): boolean {
  return t.status === 'resolved' || t.status === 'closed'
}

const EVENT_ICON: { test: RegExp; icon: ComponentType<{ className?: string }> }[] = [
  { test: /export|download/i, icon: Download },
  { test: /session|login|sign_?in|identify/i, icon: LogIn },
  { test: /view|open|pageview|\$page/i, icon: Eye },
]
function eventIcon(name: string): ComponentType<{ className?: string }> {
  return EVENT_ICON.find((e) => e.test.test(name))?.icon ?? LayoutDashboard
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function SupportInboxPage() {
  const { id } = useParams<{ id: string }>()
  const projectId = useProjectId()
  const enabled = !!projectId && !!id
  const { can } = useAuth()
  const canManage = can('projects:manage')

  const [tab, setTab] = useState<Tab>('inbox')
  const [statusFilter, setStatusFilter] = useState<SupportTicketStatus | 'all'>('all')
  const [typeTab, setTypeTab] = useState<TypeTab>('all')
  const [severityFilter, setSeverityFilter] = useState<TicketSeverity | 'all'>('all')
  const [sort, setSort] = useState<SortOrder>('newest')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { selection, setSelection, customRange, setCustomRange, range, interval } = useUrlDateRange(
    {
      defaultSelection: '30d',
      presetOptions: ['7d', '14d', '30d'],
    },
  )

  const formQuery = trpc.support.get.useQuery(
    { projectId: projectId as string, id: id as string },
    { enabled },
  )
  const form = formQuery.data as unknown as SupportFormRow | undefined

  const resultsInput = { projectId: projectId as string, formId: id as string, range }
  const resultsOpts = { enabled, placeholderData: keepPreviousData }

  const openQuery = trpc.support.results.openCount.useQuery(resultsInput, resultsOpts)
  const replyQuery = trpc.support.results.firstReplyTime.useQuery(resultsInput, resultsOpts)
  const deflectionQuery = trpc.support.results.deflectionRate.useQuery(resultsInput, resultsOpts)
  const csatQuery = trpc.support.results.csat.useQuery(resultsInput, resultsOpts)

  // Filtered/paginated — `keepPreviousData` so flipping the status filter never
  // collapses loaded rows back to a skeleton.
  const utils = trpc.useUtils()
  const listInput = {
    projectId: projectId as string,
    formId: id as string,
    ...(statusFilter !== 'all' && { status: statusFilter }),
    ...(typeTab !== 'all' && { type: typeTab }),
    // Severity is bug-only metadata, so the filter only applies on the Bugs tab —
    // it stays in state (so flipping back restores it) but never leaks into an
    // "All"/"Conversations" query, which would return nothing.
    ...(typeTab === 'bug' && severityFilter !== 'all' && { severity: severityFilter }),
    limit: 50,
  }
  const ticketsQuery = trpc.support.tickets.list.useQuery(listInput, {
    enabled,
    placeholderData: keepPreviousData,
  })

  // Opening a ticket clears its agent-unread badge server-side (`tickets.get`,
  // Optimistically zero the row's `unreadForAgent` in the list cache so
  // the dot disappears the instant it's opened, without waiting for a refetch.
  function handleSelect(ticketId: string) {
    setSelectedId(ticketId)
    // `list` returns raw Prisma rows whose `Json` columns are deeply recursive
    // types; narrow the cache blob to the fields we touch (TS2589 otherwise) and
    // cast the result back to the query's output shape.
    utils.support.tickets.list.setData(listInput, (prev) => {
      const data = prev as unknown as { items: TicketRow[]; nextCursor: string | null } | undefined
      if (!data) return prev
      return {
        ...data,
        items: data.items.map((it) => (it.id === ticketId ? { ...it, unreadForAgent: 0 } : it)),
      } as unknown as typeof prev
    })
  }
  const tickets = useMemo(() => {
    const rows = (ticketsQuery.data?.items ?? []) as unknown as TicketRow[]
    // The server always returns newest-first; "oldest" is the same page reversed
    // (there is no next-page control, so the loaded page IS the result set).
    return sort === 'oldest' ? [...rows].reverse() : rows
  }, [ticketsQuery.data, sort])

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No project selected.
      </div>
    )
  }

  const status = form?.status
  const listLabel = statusFilter === 'all' ? 'All' : statusFilter

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* back link bar — padding:12px 24px 0 */}
      <div className="shrink-0 px-4 pt-3 md:px-6">
        <Link
          to="/support"
          className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-[13px] w-[13px]" />
          Back to Support
        </Link>
      </div>

      {/* header row — padding:12px 24px 16px; border-bottom */}
      <div className="flex shrink-0 flex-col items-start gap-3 border-b border-border px-4 pt-3 pb-4 md:flex-row md:items-start md:justify-between md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
            {form?.name ?? 'Support inbox'}
          </h1>
          {status && (
            <span
              className={cn(
                'shrink-0 rounded-[5px] px-[9px] py-[3px] text-[11px] font-semibold capitalize',
                STATUS_BADGE_CLASS[status] ?? 'bg-muted text-muted-foreground',
              )}
            >
              {status}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TabToggle tab={tab} onChange={setTab} />
          <DateRangeControl
            selection={selection}
            onSelectionChange={setSelection}
            customRange={customRange}
            onCustomRangeChange={setCustomRange}
            presetOptions={['7d', '14d', '30d']}
          />
          <Link
            to={`/support/${id}/edit`}
            className={cn(
              'rounded-lg border border-border px-3 py-1.5 text-[12px] transition-colors hover:text-foreground',
              SECONDARY,
            )}
          >
            Edit
          </Link>
        </div>
      </div>

      {/* stat row — grid-template-columns:repeat(4,1fr); gap:12px; padding:18px 24px 6px */}
      <div className="grid shrink-0 grid-cols-1 gap-3 px-4 pt-[18px] pb-1.5 sm:grid-cols-2 md:px-6 lg:grid-cols-4">
        <StatTile
          icon={MessageSquare}
          label="Open tickets"
          value={(openQuery.data?.total ?? 0).toLocaleString()}
          delta={openQuery.data?.pending ? `${openQuery.data.pending} pending` : null}
          deltaClass="text-chart-3"
          loading={openQuery.isPending}
        />
        <StatTile
          icon={Clock}
          label="Median first reply"
          // `median([])` comes back as 0, which would read as an instant reply —
          // show a dash until at least one ticket has been replied to.
          value={
            replyQuery.data && replyQuery.data.replied > 0
              ? formatDuration(replyQuery.data.medianSeconds)
              : '—'
          }
          delta={replyQuery.data?.replied ? `${replyQuery.data.replied} replied` : null}
          deltaClass="text-primary"
          loading={replyQuery.isPending}
        />
        <StatTile
          icon={Bot}
          label="AI deflection"
          value={`${((deflectionQuery.data?.rate ?? 0) * 100).toFixed(1)}%`}
          delta={
            deflectionQuery.data?.deflected ? `${deflectionQuery.data.deflected} deflected` : null
          }
          deltaClass="text-primary"
          loading={deflectionQuery.isPending}
        />
        <StatTile
          icon={ShoppingBag}
          label="CSAT"
          value={
            csatQuery.data && csatQuery.data.responses > 0
              ? `${(csatQuery.data.score * 100).toFixed(0)}%`
              : '—'
          }
          delta={csatQuery.data?.responses ? `${csatQuery.data.responses} responses` : null}
          deltaClass="text-primary"
          loading={csatQuery.isPending}
        />
      </div>

      {tab === 'analytics' ? (
        <AnalyticsPane
          projectId={projectId}
          formId={id as string}
          range={range}
          interval={interval}
          enabled={enabled}
        />
      ) : (
        /* list + detail — flex:1; padding:14px 24px 24px; gap:0. Below `md` it
           collapses to a single column: list first, and picking a ticket swaps
           it for the detail view. */
        <div className="flex min-h-0 flex-1 flex-col px-4 pt-3.5 pb-6 md:flex-row md:px-6">
          {/* ticket list — 340px, joins the detail pane (border-right:none) */}
          <div
            className={cn(
              'flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card md:w-[340px] md:flex-none md:rounded-r-none md:border-r-0',
              selectedId && 'hidden md:flex',
            )}
          >
            {/* type tabs — in the LIST column, not the page header (which already
                carries three controls and wraps at 375px). */}
            <div className="shrink-0 border-b border-border px-3.5 py-2.5">
              <Segmented
                value={typeTab}
                items={TYPE_TAB_ITEMS}
                onChange={setTypeTab}
                size="sm"
                ariaLabel="Filter tickets by type"
              />
            </div>

            <div className="flex shrink-0 items-center justify-between border-b border-border px-3.5 py-[11px]">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold capitalize text-foreground">
                  {listLabel}
                </span>
                <span className="rounded-[20px] bg-muted px-[7px] py-px text-[10px] text-muted-foreground">
                  {ticketsQuery.isPending ? '—' : tickets.length}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label="Filter tickets by status and severity"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Filter className="h-[14px] w-[14px]" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[160px]">
                    <DropdownMenuLabel className="text-[11px]">Status</DropdownMenuLabel>
                    <DropdownMenuCheckboxItem
                      checked={statusFilter === 'all'}
                      onCheckedChange={() => setStatusFilter('all')}
                      className="text-xs"
                    >
                      All statuses
                    </DropdownMenuCheckboxItem>
                    {TICKET_STATUSES.map((s) => (
                      <DropdownMenuCheckboxItem
                        key={s}
                        checked={statusFilter === s}
                        onCheckedChange={() => setStatusFilter(s)}
                        className="text-xs capitalize"
                      >
                        {s}
                      </DropdownMenuCheckboxItem>
                    ))}
                    {/* Severity only exists on bugs — hide the section entirely on
                        the All/Conversations tabs rather than offering a filter
                        that can only return an empty list. */}
                    {typeTab === 'bug' && (
                      <>
                        <DropdownMenuLabel className="text-[11px]">Severity</DropdownMenuLabel>
                        <DropdownMenuCheckboxItem
                          checked={severityFilter === 'all'}
                          onCheckedChange={() => setSeverityFilter('all')}
                          className="text-xs"
                        >
                          All severities
                        </DropdownMenuCheckboxItem>
                        {TICKET_SEVERITIES.map((s) => (
                          <DropdownMenuCheckboxItem
                            key={s}
                            checked={severityFilter === s}
                            onCheckedChange={() => setSeverityFilter(s)}
                            className="text-xs capitalize"
                          >
                            {s}
                          </DropdownMenuCheckboxItem>
                        ))}
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label="Sort tickets"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <IndentIncrease className="h-[14px] w-[14px]" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[160px]">
                    <DropdownMenuLabel className="text-[11px]">Sort</DropdownMenuLabel>
                    <DropdownMenuCheckboxItem
                      checked={sort === 'newest'}
                      onCheckedChange={() => setSort('newest')}
                      className="text-xs"
                    >
                      Newest first
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={sort === 'oldest'}
                      onCheckedChange={() => setSort('oldest')}
                      className="text-xs"
                    >
                      Oldest first
                    </DropdownMenuCheckboxItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {ticketsQuery.isPending ? (
                <SkeletonList rows={8} className="p-3.5" />
              ) : ticketsQuery.error ? (
                <ErrorBanner message={ticketsQuery.error.message} />
              ) : tickets.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                  <Inbox className="mb-3 h-8 w-8 text-muted-foreground/30" />
                  <div className="text-[12px] font-semibold text-foreground">No tickets</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Tickets submitted through this form land here.
                  </div>
                </div>
              ) : (
                <ul>
                  {tickets.map((t) => (
                    <li key={t.id}>
                      <TicketListRow
                        ticket={t}
                        active={selectedId === t.id}
                        onSelect={() => handleSelect(t.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* detail shell — bg-card/50 per the HTML (README says bg-card) */}
          <div
            className={cn(
              'flex min-h-0 min-w-0 flex-1 rounded-xl border border-border bg-card/50 md:rounded-none',
              !selectedId && 'hidden md:flex',
            )}
          >
            {selectedId ? (
              <TicketDetail
                key={selectedId}
                projectId={projectId}
                ticketId={selectedId}
                canManage={canManage}
                onBack={() => setSelectedId(null)}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-[11px] text-muted-foreground">
                Pick a ticket to read the thread.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Stat card (frame 1f variant) ─────────────────────────────────────────────

/** The frame's stat card is not the shared `StatCard` shape: label sits inline
 *  with the icon in `--mfg`, and the value/delta share a baseline row. */
function StatTile({
  icon: Icon,
  label,
  value,
  delta,
  deltaClass,
  loading,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
  delta?: string | null
  deltaClass: string
  loading: boolean
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-[14px]">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-[15px] w-[15px]" />
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      <div className="mt-2.5 flex items-baseline gap-2">
        {loading ? (
          <Skeleton className="h-[24px] w-20" />
        ) : (
          <span className="text-[24px] font-semibold leading-none tracking-[-0.02em] text-foreground">
            {value}
          </span>
        )}
        {!loading && delta && <span className={cn('text-[11px]', deltaClass)}>{delta}</span>}
      </div>
    </div>
  )
}

// ── Segmented control ────────────────────────────────────────────────────────

/** The frame's pill toggle, shared by the header's Inbox/Analytics switch and the
 *  list column's All/Conversations/Bugs type tabs — one set of classes,
 *  not a per-call-site copy. `size="sm"` is the denser variant the list column
 *  needs to sit three labels beside the count row at 375px. */
function Segmented<T extends string>({
  value,
  items,
  onChange,
  size = 'md',
  ariaLabel,
}: {
  value: T
  items: readonly { key: T; label: string }[]
  onChange: (next: T) => void
  size?: 'sm' | 'md'
  ariaLabel?: string
}) {
  return (
    // `fieldset` rather than a `div role="group"` — same semantics, and Biome's
    // `useSemanticElements` rejects the ARIA form. `min-w-0` overrides the UA's
    // `min-inline-size: min-content` so it can shrink inside a 375px column.
    // `max-w-full` + wrapping keeps three tabs from overflowing there.
    <fieldset
      className="inline-flex min-w-0 max-w-full flex-wrap gap-[2px] rounded-[7px] border border-border bg-muted p-[3px]"
      aria-label={ariaLabel}
    >
      {items.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          aria-pressed={value === key}
          className={cn(
            'rounded-[5px] font-medium transition-colors',
            size === 'sm' ? 'px-2.5 py-[3px] text-[11px]' : 'px-3 py-[5px] text-[12px]',
            value === key
              ? 'bg-primary text-primary-foreground'
              : cn(SECONDARY, 'hover:text-foreground'),
          )}
        >
          {label}
        </button>
      ))}
    </fieldset>
  )
}

const TAB_ITEMS: readonly { key: Tab; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'analytics', label: 'Analytics' },
]

const TYPE_TAB_ITEMS: readonly { key: TypeTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'conversation', label: 'Conversations' },
  { key: 'bug', label: 'Bugs' },
]

function TabToggle({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return <Segmented value={tab} items={TAB_ITEMS} onChange={onChange} ariaLabel="Inbox view" />
}

// ── Ticket list row ──────────────────────────────────────────────────────────

/** Shared chip geometry — category / type / severity / priority all use it. */
const CHIP_BASE = 'shrink-0 rounded-md px-[7px] py-[2px] text-[9px] font-semibold capitalize'

function CategoryChip({ value }: { value: string }) {
  if (!value) return null
  return (
    <span className={cn(CHIP_BASE, CATEGORY_CHIP[value.toLowerCase()] ?? CATEGORY_CHIP_FALLBACK)}>
      {value}
    </span>
  )
}

/** Rendered only for bugs: a conversation is the default and needs no badge. */
function TypeChip({ type }: { type: TicketType | undefined }) {
  if (type !== 'bug') return null
  return (
    <span className={cn(CHIP_BASE, 'flex items-center gap-[3px]', CATEGORY_CHIP.bug)}>
      <TriangleAlert className="h-2.5 w-2.5" />
      Bug
    </span>
  )
}

function SeverityChip({ severity }: { severity: TicketSeverity | null | undefined }) {
  if (!severity) return null
  return <span className={cn(CHIP_BASE, SEVERITY_CHIP[severity])}>{severity}</span>
}

function Avatar({ seed, size }: { seed: string; size: 30 | 34 | 28 }) {
  const dim = size === 30 ? 'h-[30px] w-[30px]' : size === 34 ? 'h-[34px] w-[34px]' : 'h-7 w-7'
  const type = size === 34 ? 'text-[12px]' : 'text-[10px]'
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-bold text-primary-foreground',
        dim,
        type,
        AVATAR_BG[hashIndex(seed, AVATAR_BG.length)],
      )}
    >
      {initialsOf(seed)}
    </span>
  )
}

function TicketListRow({
  ticket,
  active,
  onSelect,
}: {
  ticket: TicketRow
  active: boolean
  onSelect: () => void
}) {
  const unread = isUnread(ticket)
  const resolved = isResolved(ticket)
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative flex w-full gap-[11px] border-b border-border px-3.5 py-3 text-left transition-colors',
        active ? 'bg-primary/[.06]' : 'bg-transparent hover:bg-primary/[.03]',
      )}
    >
      {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
      <Avatar seed={ticket.distinctId} size={30} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'min-w-0 truncate text-[12px] text-foreground',
              unread ? 'font-semibold' : 'font-medium',
            )}
          >
            {ticket.distinctId}
          </span>
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            {shortRelative(ticket.createdAt)}
          </span>
        </div>
        <div
          className={cn(
            'mt-[2px] truncate text-[12px]',
            resolved ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {ticket.subject}
        </div>
        {/* `flex-wrap` — up to four chips (type + severity + category + resolved)
            wrap to a second line instead of squeezing the row at 375px. */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <TypeChip type={ticket.type} />
          <SeverityChip severity={ticket.severity} />
          <CategoryChip value={ticket.category} />
          {resolved && (
            <span className="flex items-center gap-[3px] text-[9px] text-primary">
              <Check className="h-2.5 w-2.5" strokeWidth={3} />
              Resolved
            </span>
          )}
          {unread && <span className="ml-auto h-[7px] w-[7px] shrink-0 rounded-full bg-primary" />}
        </div>
      </div>
    </button>
  )
}

// ── Ticket detail + context rail ─────────────────────────────────────────────

function TicketDetail({
  projectId,
  ticketId,
  canManage,
  onBack,
}: {
  projectId: string
  ticketId: string
  canManage: boolean
  onBack: () => void
}) {
  const utils = trpc.useUtils()
  const detail = trpc.support.tickets.get.useQuery({ projectId, id: ticketId })
  const reply = trpc.support.tickets.reply.useMutation()
  const setStatus = trpc.support.tickets.setStatus.useMutation()
  const setPriority = trpc.support.tickets.setPriority.useMutation()
  const setSeverity = trpc.support.tickets.setSeverity.useMutation()
  const [body, setBody] = useState('')

  // `tickets.get` returns Prisma rows whose `Json` columns are deeply recursive
  // types; widening the whole payload once keeps TS's instantiation budget out
  // of trouble (TS2589) and gives the rail a plain `unknown` to narrow.
  const data = detail.data as unknown as
    | {
        ticket: TicketRow
        messages: TicketMessage[]
        context: unknown
        bugReport?: BugReport | null
      }
    | undefined
  const ticket = data?.ticket
  const messages = data?.messages ?? []

  async function handleReply() {
    if (!body.trim()) return
    try {
      await reply.mutateAsync({ projectId, id: ticketId, body: body.trim() })
      setBody('')
      await utils.support.tickets.get.invalidate({ projectId, id: ticketId })
      await utils.support.tickets.list.invalidate()
      toast.success('Reply sent')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to send reply')
    }
  }

  async function handleStatus(next: SupportTicketStatus) {
    try {
      await setStatus.mutateAsync({ projectId, id: ticketId, status: next })
      await utils.support.tickets.get.invalidate({ projectId, id: ticketId })
      await utils.support.tickets.list.invalidate()
      toast.success(`Ticket ${next}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update ticket')
    }
  }

  async function handlePriority(next: TicketPriority) {
    try {
      await setPriority.mutateAsync({ projectId, id: ticketId, priority: next })
      await utils.support.tickets.get.invalidate({ projectId, id: ticketId })
      await utils.support.tickets.list.invalidate()
      toast.success(`Priority set to ${next}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update priority')
    }
  }

  // `setSeverity` 400s on a conversation, fail-loudly) — the control is
  // only rendered for `type === 'bug'`, and the toast surfaces it if that ever
  // races a re-classification.
  async function handleSeverity(next: TicketSeverity) {
    try {
      await setSeverity.mutateAsync({ projectId, id: ticketId, severity: next })
      await utils.support.tickets.get.invalidate({ projectId, id: ticketId })
      await utils.support.tickets.list.invalidate()
      toast.success(`Severity set to ${next}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update severity')
    }
  }

  if (detail.isPending) {
    return (
      <div className="flex-1 space-y-4 overflow-auto p-5">
        <SkeletonCard lines={2} />
        <SkeletonCard lines={5} />
      </div>
    )
  }
  if (detail.error) {
    return <ErrorBanner message={detail.error.message} />
  }

  const resolved = ticket ? isResolved(ticket) : false

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
      {/* conversation column */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-border lg:border-r">
        <div className="shrink-0 border-b border-border px-5 py-4">
          <button
            type="button"
            onClick={onBack}
            className="mb-2 flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground md:hidden"
          >
            <ArrowLeft className="h-[13px] w-[13px]" />
            Back
          </button>
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="min-w-0 text-[15px] font-semibold text-foreground">{ticket?.subject}</h2>
            <TypeChip type={ticket?.type} />
            {ticket?.category && <CategoryChip value={ticket.category} />}
            {ticket?.priority && (
              <span
                className={cn(
                  CHIP_BASE,
                  PRIORITY_CHIP[ticket.priority.toLowerCase()] ?? CATEGORY_CHIP_FALLBACK,
                )}
              >
                {ticket.priority}
              </span>
            )}
            <SeverityChip severity={ticket?.severity} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2.5 font-mono text-[11px] text-muted-foreground">
            <span>#{ticket?.number}</span>
            <span>·</span>
            <span className="truncate">{ticket?.distinctId}</span>
            <span>·</span>
            <span>opened {ticket ? longRelative(ticket.createdAt) : ''}</span>
            {ticket?.assigneeId && (
              <>
                <span>·</span>
                <span className="text-primary">assigned → {ticket.assigneeId}</span>
              </>
            )}
          </div>
        </div>

        {/* thread */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
          {messages.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No messages on this ticket.</p>
          ) : (
            messages.map((m) => (
              <ThreadMessage key={m.id} message={m} authorSeed={ticket?.distinctId ?? '?'} />
            ))
          )}
        </div>

        {/* composer */}
        {canManage && (
          <div className="shrink-0 border-t border-border px-5 py-3.5">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              placeholder={`Reply to ${ticket?.distinctId ?? 'customer'}…`}
              className="w-full resize-none rounded-xl border border-border bg-card px-3.5 py-3 text-[13px] leading-[1.55] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
              {/* Decorative in the frame too — attachments and the answer bot
                  have no composer affordance yet. */}
              <div className="flex items-center gap-2 text-muted-foreground" aria-hidden="true">
                <Paperclip className="h-4 w-4" />
                <Bot className="h-4 w-4" />
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={setPriority.isPending}
                    className="flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-[7px] text-[12px] text-foreground transition-colors hover:bg-muted disabled:opacity-60"
                  >
                    {setPriority.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Flag className="h-3.5 w-3.5" />
                    )}
                    Priority
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[150px]">
                    <DropdownMenuLabel className="text-[11px]">Priority</DropdownMenuLabel>
                    {TICKET_PRIORITIES.map((p) => (
                      <DropdownMenuCheckboxItem
                        key={p}
                        checked={ticket?.priority?.toLowerCase() === p}
                        onCheckedChange={() => handlePriority(p)}
                        className="text-xs capitalize"
                      >
                        {p}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                {ticket?.type === 'bug' && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      disabled={setSeverity.isPending}
                      className="flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-[7px] text-[12px] text-foreground transition-colors hover:bg-muted disabled:opacity-60"
                    >
                      {setSeverity.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <TriangleAlert className="h-3.5 w-3.5" />
                      )}
                      Severity
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[150px]">
                      <DropdownMenuLabel className="text-[11px]">Severity</DropdownMenuLabel>
                      {TICKET_SEVERITIES.map((s) => (
                        <DropdownMenuCheckboxItem
                          key={s}
                          checked={ticket?.severity === s}
                          onCheckedChange={() => handleSeverity(s)}
                          className="text-xs capitalize"
                        >
                          {s}
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <button
                  type="button"
                  onClick={() => handleStatus(resolved ? 'open' : 'resolved')}
                  disabled={setStatus.isPending}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-[7px] text-[12px] text-foreground transition-colors hover:bg-muted disabled:opacity-60"
                >
                  {setStatus.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {resolved ? 'Reopen' : 'Resolve'}
                </button>
                <button
                  type="button"
                  onClick={handleReply}
                  disabled={reply.isPending || !body.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-[7px] text-[12px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {reply.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Send reply
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <ContextRail context={data?.context} ticket={ticket} bugReport={data?.bugReport ?? null} />
    </div>
  )
}

function ThreadMessage({ message, authorSeed }: { message: TicketMessage; authorSeed: string }) {
  // `system` rows render as the frame's centred divider ("Escalated to a human").
  if (message.authorType === 'system') {
    return (
      <div className="flex items-center gap-2.5 text-[10px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span className="text-center">{message.body}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    )
  }

  const isUser = message.authorType === 'user'
  // A reply with no `authorUserId` is the auto-reply — the frame's AI message.
  const isAi = !isUser && message.authorUserId == null
  const meta = isUser
    ? `${authorSeed} · ${longRelative(message.createdAt)}`
    : isAi
      ? `AI assistant · auto-reply · ${longRelative(message.createdAt)}`
      : `Support agent · ${longRelative(message.createdAt)}`

  return (
    <div className="flex gap-[11px]">
      {isUser ? (
        <Avatar seed={authorSeed} size={28} />
      ) : (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-chart-2">
          <Bot className="h-[15px] w-[15px] text-primary-foreground" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-[5px] text-[11px] text-muted-foreground">{meta}</div>
        <div
          className={cn(
            'rounded-xl border px-3.5 py-3 text-[13px] leading-[1.55] text-foreground whitespace-pre-wrap',
            isUser ? 'border-border bg-card' : 'border-chart-2/20 bg-chart-2/[.06]',
          )}
        >
          {message.body}
        </div>
      </div>
    </div>
  )
}

// ── Context rail (280px) ─────────────────────────────────────────────────────

interface RecentEventLike {
  event?: string
  name?: string
  timestamp?: string
  properties?: Record<string, unknown>
}

interface FormAnalyticsLike {
  focusOrder?: string[]
  editCounts?: Record<string, number>
  timeToSubmitMs?: number | null
  droppedOffAt?: string | null
}

function ContextRail({
  context,
  ticket,
  bugReport,
}: {
  context: unknown
  ticket: TicketRow | undefined
  bugReport: BugReport | null
}) {
  const ctx = (context ?? {}) as {
    identity?: { distinctId?: string; personProperties?: Record<string, unknown> }
    recentEvents?: RecentEventLike[]
    activeFlags?: Record<string, boolean | string>
    formAnalytics?: FormAnalyticsLike
  }
  const distinctId = ctx.identity?.distinctId ?? ticket?.distinctId ?? '—'
  const props = ctx.identity?.personProperties ?? {}
  const email = typeof props.email === 'string' ? props.email : undefined
  const name = typeof props.name === 'string' ? props.name : distinctId
  const recentEvents = Array.isArray(ctx.recentEvents) ? ctx.recentEvents : []
  const flags = Object.entries(ctx.activeFlags ?? {}).filter(([, v]) => v !== false)
  const analytics = ctx.formAnalytics

  const identityRows = Object.entries(props)
    .filter(([k]) => k !== 'name' && k !== 'email')
    .slice(0, 6)
    .map(([k, v]) => ({
      key: k.replace(/^\$/, '').replace(/_/g, ' '),
      value: String(v),
      mono: /id$|url|path|email|version/i.test(k),
    }))
  identityRows.push({ key: 'User ID', value: distinctId, mono: true })

  const activityRows = analytics ? buildActivityRows(analytics) : []

  return (
    <aside className="w-full shrink-0 overflow-auto border-t border-border bg-muted/20 lg:w-[280px] lg:border-t-0">
      <div className="flex flex-col gap-[18px] px-[18px] py-4">
        {/* 0. bug evidence — first, because it's why the ticket exists.
               Lives in the rail rather than a third column: `TicketDetail` is
               already `flex-col lg:flex-row`, and a third column would break the
               two-pane layout below 1024px. */}
        {bugReport && <BugContextSection bugReport={bugReport} />}

        {/* 1. heading + Auto pill */}
        <div className="flex items-center gap-[7px]">
          <span className={RAIL_HEADING}>User context</span>
          <span className="rounded-md bg-primary/[.12] px-1.5 py-px text-[9px] text-primary">
            Auto
          </span>
        </div>

        {/* 2. identity block */}
        <div className="flex flex-col gap-[9px]">
          <div className="flex items-center gap-2.5">
            <Avatar seed={distinctId} size={34} />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-foreground">{name}</div>
              {email && (
                <div className="truncate font-mono text-[11px] text-muted-foreground">{email}</div>
              )}
            </div>
          </div>
          <KeyValueRows rows={identityRows} />
        </div>

        {/* 3. recent events */}
        <div>
          <div className={cn(RAIL_HEADING, 'mb-2.5')}>Recent events</div>
          {recentEvents.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">No recent events captured.</p>
          ) : (
            <div>
              {recentEvents.slice(0, 8).map((e, i) => {
                const label = String(e.event ?? e.name ?? 'event')
                const Icon = eventIcon(label)
                return (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: the ring is positional
                    key={`${label}-${i}`}
                    className="relative flex items-start gap-2.5 pb-3"
                  >
                    <span
                      className={cn(
                        'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full',
                        i === 0 ? 'bg-destructive' : 'bg-[#3a3a52]',
                      )}
                    >
                      <Icon className="h-3 w-3 text-background" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[11px] text-foreground">{label}</div>
                      {e.timestamp && (
                        <div className="text-[10px] text-muted-foreground">
                          {longRelative(e.timestamp)}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 4. form activity */}
        <div>
          <div className={cn(RAIL_HEADING, 'mb-2.5')}>Form activity</div>
          {activityRows.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">No form telemetry captured.</p>
          ) : (
            <KeyValueRows rows={activityRows} />
          )}
        </div>

        {/* 5. active flags */}
        <div>
          <div className={cn(RAIL_HEADING, 'mb-2.5')}>Active flags</div>
          {flags.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">No flags captured.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {flags.map(([k, v]) => (
                <span
                  key={k}
                  className="rounded-[5px] border border-border bg-muted px-2 py-[3px] font-mono text-[10px] text-foreground"
                >
                  {v === true ? k : `${k}: ${v}`}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}

interface KvRow {
  key: string
  value: string
  mono?: boolean
  valueClass?: string
}

function buildActivityRows(a: FormAnalyticsLike): KvRow[] {
  const rows: KvRow[] = []
  if (typeof a.timeToSubmitMs === 'number') {
    rows.push({ key: 'Time to submit', value: `${Math.round(a.timeToSubmitMs / 1000)}s` })
  }
  const counts = a.editCounts ?? {}
  const subjectKey = Object.keys(counts).find((k) => /subject/i.test(k))
  if (subjectKey) {
    rows.push({ key: 'Subject edits', value: String(counts[subjectKey]) })
  } else if (Object.keys(counts).length > 0) {
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
    rows.push({ key: 'Field edits', value: String(total) })
  }
  rows.push({
    key: 'Drop-off',
    value: a.droppedOffAt ?? 'None',
    valueClass: a.droppedOffAt ? 'text-chart-3' : 'text-primary',
  })
  return rows
}

function KeyValueRows({ rows }: { rows: KvRow[] }) {
  return (
    <div className="flex flex-col gap-px text-[11px]">
      {rows.map((r) => (
        <div
          key={r.key}
          className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-b-0"
        >
          <span className="shrink-0 capitalize text-muted-foreground">{r.key}</span>
          <span
            className={cn('min-w-0 truncate text-foreground', r.mono && 'font-mono', r.valueClass)}
            title={r.value}
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Bug context ─────────────────────────────────────────────────────

/** A rail section that folds. The rail is already long; three more blocks would
 *  bury "User context" without this, so everything but Environment starts shut. */
function RailCollapsible({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string
  count?: number
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-left">
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className={RAIL_HEADING}>{title}</span>
        {count !== undefined && (
          <span className="ml-auto rounded-[20px] bg-muted px-[6px] py-px text-[9px] text-muted-foreground">
            {count}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function buildEnvironmentRows(env: BugEnvironment): KvRow[] {
  const rows: KvRow[] = []
  if (env.url) rows.push({ key: 'URL', value: env.url, mono: true })
  if (env.browser) {
    rows.push({
      key: 'Browser',
      value: env.browserVersion ? `${env.browser} ${env.browserVersion}` : env.browser,
      mono: !!env.browserVersion,
    })
  }
  if (env.os) rows.push({ key: 'OS', value: env.os })
  if (env.viewportWidth && env.viewportHeight) {
    rows.push({ key: 'Viewport', value: `${env.viewportWidth}×${env.viewportHeight}` })
  }
  if (env.locale) rows.push({ key: 'Locale', value: env.locale })
  if (env.timezone) rows.push({ key: 'Timezone', value: env.timezone })
  return rows
}

/** `https://acme.co/app/billing?x=1` → `/app/billing`. Falls back to the raw
 *  string when the SDK sent something that isn't an absolute URL. */
function requestPath(url: string): string {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url
  }
}

function statusPillClass(status: number | null): string {
  if (status === null || status >= 500) return 'text-destructive bg-destructive/[.14]'
  if (status >= 400) return 'text-chart-3 bg-chart-3/[.14]'
  return 'text-muted-foreground bg-muted'
}

/** One console entry on the recent-events timeline shape: dot + body. The message
 *  is clamped to two lines and expands on click — a stack-ish console string is
 *  otherwise long enough to own the rail. */
function ConsoleErrorRow({ entry, first }: { entry: BugConsoleEntry; first: boolean }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="relative flex items-start gap-2.5 pb-3">
      <span
        className={cn(
          'mt-[3px] h-[10px] w-[10px] shrink-0 rounded-full',
          entry.level === 'error' ? 'bg-destructive' : 'bg-chart-3',
          !first && entry.level === 'error' && 'bg-destructive/70',
        )}
      />
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="min-w-0 flex-1 text-left"
      >
        <div
          className={cn(
            'break-words font-mono text-[11px]',
            entry.level === 'error' ? 'text-destructive' : 'text-chart-3',
            !expanded && 'line-clamp-2',
          )}
        >
          {entry.message}
        </div>
        {expanded && entry.source && (
          <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
            {entry.source}
          </div>
        )}
        {entry.timestamp && (
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {longRelative(entry.timestamp)}
          </div>
        )}
      </button>
    </div>
  )
}

function FailedRequestRow({ entry }: { entry: BugNetworkEntry }) {
  return (
    <div className="flex items-start gap-2 border-b border-border py-1.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11px] text-foreground" title={entry.url}>
          <span className="text-muted-foreground">{entry.method.toUpperCase()}</span>{' '}
          {requestPath(entry.url)}
        </div>
        {entry.error && (
          <div className="truncate text-[10px] text-muted-foreground" title={entry.error}>
            {entry.error}
          </div>
        )}
      </div>
      <span
        className={cn(
          'shrink-0 rounded-md px-[6px] py-px font-mono text-[9px] font-semibold',
          statusPillClass(entry.status),
        )}
      >
        {entry.status ?? 'failed'}
      </span>
    </div>
  )
}

function BugContextSection({ bugReport }: { bugReport: BugReport }) {
  const envRows = bugReport.environment ? buildEnvironmentRows(bugReport.environment) : []
  const consoleErrors = bugReport.consoleErrors ?? []
  const networkErrors = bugReport.networkErrors ?? []

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-destructive/20 bg-destructive/[.04] p-3">
      <div className="flex items-center gap-[7px]">
        <TriangleAlert className="h-3 w-3 shrink-0 text-destructive" />
        <span className={RAIL_HEADING}>Bug context</span>
        <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">
          {longRelative(bugReport.capturedAt)}
        </span>
      </div>

      <RailCollapsible title="Environment" defaultOpen>
        {envRows.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">No environment captured.</p>
        ) : (
          <KeyValueRows rows={envRows} />
        )}
      </RailCollapsible>

      <RailCollapsible title="Console errors" count={consoleErrors.length}>
        {consoleErrors.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">No console errors captured.</p>
        ) : (
          <div>
            {consoleErrors.map((e, i) => (
              <ConsoleErrorRow
                // biome-ignore lint/suspicious/noArrayIndexKey: the ring is positional
                key={`${e.timestamp}-${i}`}
                entry={e}
                first={i === 0}
              />
            ))}
          </div>
        )}
      </RailCollapsible>

      <RailCollapsible title="Failed requests" count={networkErrors.length}>
        {networkErrors.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">No failed requests captured.</p>
        ) : (
          <div className="flex flex-col">
            {networkErrors.map((e, i) => (
              <FailedRequestRow
                // biome-ignore lint/suspicious/noArrayIndexKey: the ring is positional
                key={`${e.timestamp}-${i}`}
                entry={e}
              />
            ))}
          </div>
        )}
      </RailCollapsible>
    </div>
  )
}

// ── Analytics pane ───────────────────────────────────────────────────────────

function AnalyticsPane({
  projectId,
  formId,
  range,
  interval,
  enabled,
}: {
  projectId: string
  formId: string
  range: { from: string; to: string }
  interval: 'hour' | 'day'
  enabled: boolean
}) {
  const opts = { enabled, placeholderData: keepPreviousData }
  const trendQuery = trpc.support.results.trend.useQuery(
    { projectId, formId, range, interval },
    opts,
  )
  const categoryQuery = trpc.support.results.volumeByCategory.useQuery(
    { projectId, formId, range },
    opts,
  )

  // Postgres-backed (ClickHouse `support_events` never backfills, so a
  // CH-backed by-type chart would bucket every pre-phase ticket as empty forever).
  const typeQuery = trpc.support.results.volumeByType.useQuery({ projectId, formId, range }, opts)

  const trend = trendQuery.data ?? []
  const categories = categoryQuery.data ?? []
  const maxCategory = Math.max(1, ...categories.map((c) => c.count))
  const types = typeQuery.data ?? []
  const maxType = Math.max(1, ...types.map((t) => t.count))

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="space-y-8">
        <section>
          <h2 className="mb-3 text-xs font-semibold text-foreground">Ticket volume</h2>
          {trendQuery.isPending ? (
            <SkeletonChart height={200} />
          ) : trendQuery.error ? (
            <ErrorBanner message={trendQuery.error.message} />
          ) : trend.length === 0 ? (
            <div className="rounded-xl border border-border bg-card py-12 text-center text-[11px] text-muted-foreground">
              No support activity in this range yet.
            </div>
          ) : (
            <TrendChart data={trend} />
          )}
        </section>

        <section>
          <h2 className="mb-3 text-xs font-semibold text-foreground">Volume by type</h2>
          {typeQuery.isPending ? (
            <SkeletonCard lines={4} />
          ) : typeQuery.error ? (
            <ErrorBanner message={typeQuery.error.message} />
          ) : types.length === 0 ? (
            <div className="rounded-xl border border-border bg-card py-10 text-center text-[11px] text-muted-foreground">
              No tickets in this range.
            </div>
          ) : (
            <div className="space-y-1.5 rounded-xl border border-border bg-card p-4">
              {types.map((t) => (
                <div key={t.value} className="flex items-center gap-3">
                  <div
                    className="w-28 shrink-0 truncate text-[11px] capitalize text-foreground"
                    title={t.value}
                  >
                    {t.value === 'bug'
                      ? 'Bugs'
                      : t.value === 'conversation'
                        ? 'Conversations'
                        : '—'}
                  </div>
                  <div className="relative h-5 flex-1 overflow-hidden rounded bg-muted/30">
                    <div
                      className={cn(
                        'h-full rounded',
                        t.value === 'bug' ? 'bg-destructive/70' : 'bg-primary/70',
                      )}
                      style={{ width: `${(t.count / maxType) * 100}%` }}
                    />
                  </div>
                  <div className="w-24 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                    {t.count} {t.count === 1 ? 'ticket' : 'tickets'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-xs font-semibold text-foreground">Volume by category</h2>
          {categoryQuery.isPending ? (
            <SkeletonCard lines={4} />
          ) : categoryQuery.error ? (
            <ErrorBanner message={categoryQuery.error.message} />
          ) : categories.length === 0 ? (
            <div className="rounded-xl border border-border bg-card py-10 text-center text-[11px] text-muted-foreground">
              No categorized tickets in this range.
            </div>
          ) : (
            <div className="space-y-1.5 rounded-xl border border-border bg-card p-4">
              {categories.map((c) => (
                <div key={c.value} className="flex items-center gap-3">
                  <div
                    className="w-28 shrink-0 truncate text-[11px] text-foreground"
                    title={c.value}
                  >
                    {c.value || '—'}
                  </div>
                  <div className="relative h-5 flex-1 overflow-hidden rounded bg-muted/30">
                    <div
                      className="h-full rounded bg-primary/70"
                      style={{ width: `${(c.count / maxCategory) * 100}%` }}
                    />
                  </div>
                  <div className="w-24 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                    {c.count} · {c.users} users
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function TrendChart({
  data,
}: {
  data: { bucket: string; opened: number; created: number; deflected: number }[]
}) {
  const max = Math.max(1, ...data.map((d) => Math.max(d.opened, d.created, d.deflected)))
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-4 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-muted-foreground/40" />
          Opened
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-primary" />
          Tickets
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-primary/40" />
          Deflected
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex h-[180px] min-w-[480px] items-end gap-2 border-b border-border pb-2">
          {data.map((d) => (
            <div key={d.bucket} className="flex h-full flex-1 flex-col items-center gap-1">
              <div className="flex h-full w-full items-end justify-center gap-0.5">
                <div
                  className="w-1/3 rounded-sm bg-muted-foreground/40"
                  style={{ height: `${(d.opened / max) * 100}%` }}
                  title={`Opened: ${d.opened}`}
                />
                <div
                  className="w-1/3 rounded-sm bg-primary"
                  style={{ height: `${(d.created / max) * 100}%` }}
                  title={`Tickets: ${d.created}`}
                />
                <div
                  className="w-1/3 rounded-sm bg-primary/40"
                  style={{ height: `${(d.deflected / max) * 100}%` }}
                  title={`Deflected: ${d.deflected}`}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="m-4 flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div>
        <div className="text-sm font-medium text-destructive">Failed to load</div>
        <div className="mt-1 text-[11px] text-muted-foreground">{message}</div>
      </div>
    </div>
  )
}
