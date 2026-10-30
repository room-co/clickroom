import { keepPreviousData } from '@tanstack/react-query'
import { format as formatDate } from 'date-fns'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Download,
  Gauge,
  ListFilter,
  RotateCcw,
  Search,
  Send,
  Webhook,
  X,
  XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { CopyButton } from '@/components/CopyButton'
import { DateRangeControl } from '@/components/DateRangeControl'
import { SecretField } from '@/components/SecretField'
import { type HealthTone, StatusDot } from '@/components/StatusDot'
import { SkeletonChart, SkeletonStatCard } from '@/components/skeletons'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { useUrlDateRange } from '@/hooks/useUrlDateRange'
import { trpc } from '@/lib/trpc'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'
import { type SupportWebhookRow, WebhookFormSheet } from './WebhookFormSheet'

/**
 * Frame `7a` — the webhook delivery history PAGE (follow-up).
 *
 * Supersedes `WebhookDeliveryHistorySheet` (frame `5b`): a debugging surface has
 * to be linkable. Everything that made the sheet — the stat cards, the delivery
 * table, the expanded request/response panes, the retry actions and the `5c`
 * state cards — carries over verbatim; what is new is the container, the volume
 * chart, the Attempt/Timestamp columns, the filter toolbar, and the fact that
 * **all filter, range and page state lives in the query string**:
 *
 *   ?status=failed&event=ticket.created&q=tkt_123&codeMin=500&codeMax=599
 *   &range=7d&from=2026-07-01&to=2026-07-08&cursors=<id>,<id>
 *
 * `cursors` is the pagination stack (one delivery id per page already stepped
 * past, comma-joined). Keeping the whole stack rather than a single cursor is
 * what makes `Previous` work on a link someone pasted to you — a lone cursor
 * can only go forward.
 *
 * Filter writes PUSH a history entry (the acceptance check is that the back
 * button steps through filter changes); only the date range replaces, because
 * `useUrlDateRange` is shared with eight other pages and owns that call.
 */

// ── URL param contract ──────────────────────────────────────────────────────
// Named here because the entry points (`5a` destination rows, the `6a` overflow
// menu) build these links.

const PARAM = {
  status: 'status',
  event: 'event',
  search: 'q',
  codeMin: 'codeMin',
  codeMax: 'codeMax',
  cursors: 'cursors',
  /** Owned by `useUrlDateRange`: `range`, `from`, `to`. */
  range: 'range',
} as const

const PAGE_SIZE = 25

/** Mirrors `supportWebhookDeliveryFilterSchema`. */
const STATUS_VALUES = ['all', 'delivered', 'failed', 'retrying'] as const
type DeliveryStatusFilter = (typeof STATUS_VALUES)[number]

/** Mirrors `supportWebhookDeliveryEventFilterSchema` (subscriptions + `ping`). */
const EVENT_VALUES = [
  'ticket.created',
  'ticket.replied',
  'ticket.updated',
  'ticket.resolved',
  'ticket.reopened',
  'ping',
] as const
type DeliveryEventFilter = (typeof EVENT_VALUES)[number]

/** The `Add filter` → response code submenu. `min > max` is refused by the router. */
const CODE_RANGES: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: '2xx — success', min: 200, max: 299 },
  { label: '3xx — redirect', min: 300, max: 399 },
  { label: '4xx — client error', min: 400, max: 499 },
  { label: '5xx — server error', min: 500, max: 599 },
]

/** The three segments `7a` draws. `delivered` is reachable only via `Add filter`. */
const SEGMENTS: ReadonlyArray<{ label: string; value: DeliveryStatusFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'Failed', value: 'failed' },
  { label: 'Retrying', value: 'retrying' },
]

/** `INGEST_WEBHOOK_RETENTION_DAYS` — copy only, and only until the payload says. */
const RETENTION_DAYS = 30

// ── Formatting helpers ──────────────────────────────────────────────────────
// tRPC runs with no superjson transformer here, so every `Date` the router
// returns arrives as an ISO string at runtime while the inferred type still says
// `Date`. Everything below accepts both rather than trusting either.

type Timestamp = string | Date | null | undefined

function toDate(value: Timestamp): Date | null {
  if (!value) return null
  const d = typeof value === 'string' ? new Date(value) : value
  return Number.isNaN(d.getTime()) ? null : d
}

/** `Jul 26, 14:31:08` — absolute, 24h, no year, no timezone suffix (frame `7a`). */
function formatAbsolute(value: Timestamp): string {
  const d = toDate(value)
  return d ? formatDate(d, 'MMM d, HH:mm:ss') : '—'
}

function formatLatency(ms: number | null | undefined): string {
  if (ms == null) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

/** "4m 12s" — the countdown beside "Attempt 3 of 5 failed". */
function formatCountdown(target: Timestamp): string | null {
  const d = toDate(target)
  if (!d) return null
  const ms = d.getTime() - Date.now()
  if (ms <= 0) return null
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

/** `{ 'content-type': 'application/json' }` → `content-type: application/json`. */
function headerLines(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`)
}

/**
 * `https://hooks.slack.com/services/T04…/B07…/xR2` — host in full, path segments
 * cut to their first few characters. Recovered verbatim from the superseded `5b`
 * sheet: webhook URLs routinely carry the shared secret in the path (Slack,
 * Teams, Discord), so the header must not render one verbatim over a shoulder.
 */
function maskEndpointUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length === 0) return `${parsed.origin}${parsed.pathname}`
    const masked = segments.map((s) => (s.length > 4 ? `${s.slice(0, 3)}…` : s))
    return `${parsed.origin}/${masked.join('/')}`
  } catch {
    return url
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// ── Delivery row status ─────────────────────────────────────────────────────

type DeliveryRowStatus = { label: string; tone: HealthTone }

/**
 * `'retrying'` is a DERIVED view, never a stored status (hard constraint 1): the
 * worker's claim predicate is `status='pending'`, so a third stored value would
 * silently stop every retry. A pending row with attempts behind it is a retry.
 */
function deliveryRowStatus(delivery: { status: string; attempts: number }): DeliveryRowStatus {
  if (delivery.status === 'delivered') return { label: 'Delivered', tone: 'healthy' }
  if (delivery.status === 'failed') return { label: 'Failed', tone: 'failing' }
  if (delivery.attempts > 0) return { label: 'Retrying', tone: 'degraded' }
  return { label: 'Pending', tone: 'idle' }
}

/** `7a`: amber while retrying, red once exhausted, muted on anything delivered. */
function attemptClass(tone: HealthTone): string {
  if (tone === 'degraded') return 'text-amber-400'
  if (tone === 'failing') return 'text-red-400'
  return 'text-muted-foreground'
}

// ── Payload types ───────────────────────────────────────────────────────────
// The router's inferred payload is deep enough to trip TS2589 through
// `@tanstack/react-query` (a Prisma include tree behind a tRPC hook). The shapes
// are small and fixed, so they are named once here and the query data is read
// through them — the same workaround the `5b` sheet needed for its pages array.

type DeliveryAttempt = {
  id: string
  attempt: number
  latencyMs: number
  responseCode: number | null
  outcome: string
  errorMessage: string | null
  requestHeaders: unknown
  requestBody: string | null
  responseHeaders: unknown
  responseBody: string | null
  bodyTruncated: boolean
  bodiesPurgedAt: Date | string | null
}

type Delivery = {
  id: string
  event: string
  status: string
  attempts: number
  payload: unknown
  createdAt: Date | string
  nextAttemptAt: Date | string | null
  lastError: string | null
  lastStatusCode: number | null
  isTest: boolean
  ticket: { number: number; subject: string | null } | null
  attempts_: DeliveryAttempt[]
}

type DeliveryPage = {
  items: Delivery[]
  total: number
  nextCursor: string | null
  counts: { all: number; delivered: number; failed: number; retrying: number }
  maxAttempts: number
  search: { term: string; purgedDeliveries: number; retentionDays: number } | null
}

type VolumeBucket = { hourStart: Date | string; delivered: number; failed: number }

// ── Page ────────────────────────────────────────────────────────────────────

export function WebhookDeliveriesPage() {
  const { webhookId = '' } = useParams<{ webhookId: string }>()
  const projectId = useProjectId()
  const utils = trpc.useUtils()
  const [searchParams, setSearchParams] = useSearchParams()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [exporting, setExporting] = useState(false)

  // `24h` matches the chart's fixed 24 buckets and the "Delivered (24h)" tile.
  const { selection, setSelection, customRange, setCustomRange, range } = useUrlDateRange({
    defaultSelection: '24h',
    presetOptions: ['24h', '7d', '14d', '30d'],
  })

  const filters = readFilters(searchParams)
  const cursors = readCursors(searchParams)
  const cursor = cursors.at(-1) ?? null

  /**
   * Filter writes PUSH (back steps through them) and always reset pagination —
   * a cursor from the previous filter set points at a row that may no longer be
   * in the result.
   */
  const applyFilters = (mutate: (params: URLSearchParams) => void) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      mutate(params)
      params.delete(PARAM.cursors)
      return params
    })
    setExpandedId(null)
  }

  const setCursors = (next: string[]) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next.length === 0) params.delete(PARAM.cursors)
      else params.set(PARAM.cursors, next.join(','))
      return params
    })
    setExpandedId(null)
  }

  const enabled = !!projectId && !!webhookId
  const pid = projectId as string

  // The filter half of the query input, shared verbatim with `exportCsv` so the
  // export is the ACTIVE VIEW rather than the page on screen.
  const filterInput = useMemo(
    () => ({
      projectId: pid,
      webhookId,
      status: filters.status,
      ...(filters.event && { event: filters.event }),
      ...(filters.search && { search: filters.search }),
      ...(filters.codeMin != null && { responseCodeMin: filters.codeMin }),
      ...(filters.codeMax != null && { responseCodeMax: filters.codeMax }),
      from: range.from,
      to: range.to,
    }),
    [
      pid,
      webhookId,
      filters.status,
      filters.event,
      filters.search,
      filters.codeMin,
      filters.codeMax,
      range.from,
      range.to,
    ],
  )

  const webhooksQuery = trpc.support.webhooks.list.useQuery({ projectId: pid }, { enabled })
  const healthQuery = trpc.support.webhooks.health.useQuery({ projectId: pid }, { enabled })
  const statsQuery = trpc.support.webhooks.stats.useQuery(
    { projectId: pid, webhookId, from: range.from, to: range.to },
    { enabled, placeholderData: keepPreviousData },
  )
  const volumeQuery = trpc.support.webhooks.volume.useQuery(
    { projectId: pid, webhookId, from: range.from, to: range.to },
    { enabled, placeholderData: keepPreviousData },
  )
  const deliveriesQuery = trpc.support.webhooks.deliveries.useQuery(
    { ...filterInput, cursor, limit: PAGE_SIZE },
    { enabled, placeholderData: keepPreviousData },
  )

  const webhook = webhooksQuery.data?.find((w) => w.id === webhookId) as
    | SupportWebhookRow
    | undefined
  const rollup = healthQuery.data?.find((h) => h.webhookId === webhookId)
  const tone: HealthTone = (rollup?.health ?? 'idle') as HealthTone
  const stats = statsQuery.data
  const page = deliveriesQuery.data as DeliveryPage | undefined
  const buckets = (volumeQuery.data ?? []) as VolumeBucket[]
  const deliveries = page?.items ?? []
  const counts = page?.counts
  const maxAttempts = page?.maxAttempts ?? 5

  const invalidate = async () => {
    await Promise.all([
      utils.support.webhooks.deliveries.invalidate({ projectId: pid, webhookId }),
      utils.support.webhooks.volume.invalidate({ projectId: pid, webhookId }),
      utils.support.webhooks.stats.invalidate({ projectId: pid, webhookId }),
      utils.support.webhooks.health.invalidate({ projectId: pid }),
      utils.support.webhooks.list.invalidate({ projectId: pid }),
    ])
  }

  const retry = trpc.support.webhooks.retry.useMutation({
    onSuccess: async () => {
      toast.success('Delivery requeued — it goes out on the next sweep.')
      await invalidate()
    },
    onError: (error) => toast.error(error.message),
  })

  const retryAllFailed = trpc.support.webhooks.retryAllFailed.useMutation({
    onSuccess: async (result) => {
      // The cap is surfaced only when it actually bites — otherwise the toast
      // reads like a limitation on a job that finished.
      toast.success(
        result.capped
          ? `Requeued ${result.requeued} deliveries — the ${result.cap} per-run cap was hit, run it again for the rest.`
          : result.requeued === 0
            ? 'No failed deliveries in this window.'
            : `Requeued ${result.requeued} failed ${result.requeued === 1 ? 'delivery' : 'deliveries'}.`,
      )
      await invalidate()
    },
    onError: (error) => toast.error(error.message),
  })

  const reEnable = trpc.support.webhooks.reEnableAndReplay.useMutation({
    onSuccess: async (result) => {
      toast.success(
        `Endpoint re-enabled — replaying ${result.replayed} queued ${result.replayed === 1 ? 'delivery' : 'deliveries'} in order.`,
      )
      await invalidate()
    },
    onError: (error) => toast.error(error.message),
  })

  const sendTest = trpc.support.webhooks.sendTest.useMutation({
    onSuccess: async (result) => {
      if (result.status === 'delivered') toast.success(`${result.code} in ${result.latencyMs}ms`)
      else toast.error(result.error ?? 'The endpoint did not accept the test payload.')
      await invalidate()
    },
    onError: (error) => toast.error(error.message),
  })

  async function handleExport() {
    setExporting(true)
    try {
      const result = await utils.support.webhooks.exportCsv.fetch(filterInput)
      downloadCsv(result.filename, result.csv)
      if (result.capped) {
        toast.warning(
          `Exported the newest ${result.cap} rows — the export cap was hit. Narrow the date range or add a filter for the rest.`,
        )
      } else {
        toast.success(`Exported ${result.rowCount} ${result.rowCount === 1 ? 'row' : 'rows'}.`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No project selected.
      </div>
    )
  }

  const from = cursors.length * PAGE_SIZE + 1
  const to = from + deliveries.length - 1
  const total = page?.total ?? 0

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Breadcrumb className="px-4 pt-4 md:px-6">
        <BreadcrumbList className="text-[11.5px]">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/settings">Settings</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/settings/webhooks">Webhooks</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Delivery history</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Header. DELIBERATE DEPARTURE FROM FRAME `7a`: the canvas draws the
          endpoint URL in full, but webhook URLs routinely carry the shared
          secret in the path (Slack, Teams and Discord all do), and this page is
          linkable — it gets pasted into tickets and screen-shared while someone
          debugs. So the URL is masked by default with an explicit reveal + copy
          (`SecretField`), which is the posture the superseded `5b` sheet had via
          `maskEndpointUrl`. Restoring it here keeps the page from being a
          secret-leak regression on the overlay it replaced. */}
      <div className="flex shrink-0 flex-col gap-3 border-b border-border px-4 py-3 md:flex-row md:items-start md:justify-between md:px-6">
        <div className="flex min-w-0 gap-2.5">
          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/5">
            <Webhook className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[15px] font-semibold tracking-tight text-foreground">
                {webhooksQuery.isPending ? (
                  <Skeleton className="h-4 w-48" />
                ) : (
                  (webhook?.name ?? 'Webhook')
                )}
              </h1>
              <StatusDot tone={tone} />
            </div>
            {webhook ? (
              <SecretField
                className="mt-1 min-w-0"
                value={webhook.url}
                masked={maskEndpointUrl(webhook.url)}
                copyValue={webhook.url}
                label="endpoint URL"
                valueClassName="truncate text-[11px]"
              />
            ) : (
              <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">—</div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-[12px]"
            disabled={!webhook || sendTest.isPending}
            onClick={() => sendTest.mutate({ projectId: pid, id: webhookId })}
          >
            <Send className="h-3.5 w-3.5" />
            {sendTest.isPending ? 'Sending…' : 'Send test'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-[12px]"
            disabled={!webhook}
            onClick={() => setEditing(true)}
          >
            Edit webhook
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 text-[12px] font-semibold"
            disabled={retryAllFailed.isPending}
            onClick={() =>
              retryAllFailed.mutate({
                projectId: pid,
                webhookId,
                from: range.from,
                to: range.to,
              })
            }
          >
            <RotateCcw className={cn('h-3.5 w-3.5', retryAllFailed.isPending && 'animate-spin')} />
            Retry all failed
          </Button>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-auto p-4 md:p-6">
        {/* Stat row + volume chart */}
        <div className="flex flex-col gap-3 xl:flex-row xl:items-stretch">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:w-[620px] xl:shrink-0 xl:grid-cols-4">
            {statsQuery.isPending || !stats ? (
              <>
                <SkeletonStatCard icon={CheckCircle2} label="Delivered (24h)" />
                <SkeletonStatCard icon={XCircle} label="Failed" />
                <SkeletonStatCard icon={Gauge} label="Success rate" />
                <SkeletonStatCard icon={Clock} label="p95 latency" />
              </>
            ) : (
              <>
                <StatTile
                  icon={CheckCircle2}
                  label="Delivered (24h)"
                  value={stats.delivered24h.toLocaleString()}
                />
                <StatTile
                  icon={XCircle}
                  label="Failed"
                  value={stats.failed.toLocaleString()}
                  valueClassName={stats.failed > 0 ? 'text-red-400' : undefined}
                />
                <StatTile
                  icon={Gauge}
                  label="Success rate"
                  value={formatPercent(stats.successRate)}
                  valueClassName="text-teal-400"
                />
                <StatTile
                  icon={Clock}
                  label="p95 latency"
                  value={formatLatency(stats.p95LatencyMs)}
                />
              </>
            )}
          </div>
          <VolumeChart buckets={buckets} loading={volumeQuery.isPending} />
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <SegmentCounts
            value={filters.status}
            counts={counts}
            onChange={(next) =>
              applyFilters((params) => {
                if (next === 'all') params.delete(PARAM.status)
                else params.set(PARAM.status, next)
              })
            }
          />

          {filters.status === 'delivered' && (
            <FilterChip
              label="status: delivered"
              onRemove={() => applyFilters((params) => params.delete(PARAM.status))}
            />
          )}
          {filters.event && (
            <FilterChip
              label={`event: ${filters.event}`}
              onRemove={() => applyFilters((params) => params.delete(PARAM.event))}
            />
          )}
          {(filters.codeMin != null || filters.codeMax != null) && (
            <FilterChip
              label={`response: ${filters.codeMin ?? 100}–${filters.codeMax ?? 599}`}
              onRemove={() =>
                applyFilters((params) => {
                  params.delete(PARAM.codeMin)
                  params.delete(PARAM.codeMax)
                })
              }
            />
          )}

          <AddFilterMenu
            onEvent={(event) => applyFilters((params) => params.set(PARAM.event, event))}
            onStatus={(status) =>
              applyFilters((params) => {
                if (status === 'all') params.delete(PARAM.status)
                else params.set(PARAM.status, status)
              })
            }
            onCodeRange={(min, max) =>
              applyFilters((params) => {
                params.set(PARAM.codeMin, String(min))
                params.set(PARAM.codeMax, String(max))
              })
            }
          />

          <SearchField
            value={filters.search}
            onCommit={(next) =>
              applyFilters((params) => {
                if (next) params.set(PARAM.search, next)
                else params.delete(PARAM.search)
              })
            }
          />

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <DateRangeControl
              selection={selection}
              onSelectionChange={setSelection}
              customRange={customRange}
              onCustomRangeChange={setCustomRange}
              presetOptions={['24h', '7d', '14d', '30d']}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-[11.5px]"
              disabled={exporting || !enabled}
              onClick={handleExport}
            >
              <Download className="h-3 w-3" />
              {exporting ? 'Exporting…' : 'Export CSV'}
            </Button>
          </div>
        </div>

        {/* A body search cannot match a delivery whose body the retention job
            already nulled — saying so beats reporting "no results". */}
        {page?.search && page.search.purgedDeliveries > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {page.search.purgedDeliveries} older{' '}
            {page.search.purgedDeliveries === 1 ? 'delivery' : 'deliveries'} in this range had
            {page.search.purgedDeliveries === 1 ? ' its' : ' their'} bodies purged after{' '}
            {page.search.retentionDays} days and cannot match a body search.
          </p>
        )}

        {/* `5c` state cards */}
        <StateCards
          webhook={webhook}
          rollup={rollup}
          tone={tone}
          onReEnable={() => reEnable.mutate({ projectId: pid, id: webhookId })}
          reEnablePending={reEnable.isPending}
          onSendTest={() => sendTest.mutate({ projectId: pid, id: webhookId })}
          sendTestPending={sendTest.isPending}
          onViewFailed={() => applyFilters((params) => params.set(PARAM.status, 'failed'))}
        />

        {/* Table */}
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <div className="hidden gap-3.5 border-b border-border px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground lg:grid lg:grid-cols-[100px_150px_1fr_74px_78px_70px_150px_24px]">
            <span>Status</span>
            <span>Event</span>
            <span>Ticket</span>
            <span>Response</span>
            <span>Latency</span>
            <span>Attempt</span>
            <span>Timestamp</span>
            <span />
          </div>

          {deliveriesQuery.isPending ? (
            <DeliveryRowsSkeleton />
          ) : deliveries.length === 0 ? (
            <div className="px-4 py-12 text-center text-xs text-muted-foreground">
              No deliveries match these filters.
            </div>
          ) : (
            deliveries.map((delivery) => (
              <DeliveryRow
                key={delivery.id}
                delivery={delivery}
                maxAttempts={maxAttempts}
                expanded={expandedId === delivery.id}
                onToggle={() =>
                  setExpandedId((current) => (current === delivery.id ? null : delivery.id))
                }
                onRetry={() => retry.mutate({ projectId: pid, webhookId, deliveryId: delivery.id })}
                retryPending={retry.isPending}
              />
            ))
          )}

          <div className="flex items-center gap-3 px-4 py-3">
            <span className="text-[11.5px] text-muted-foreground">
              {deliveriesQuery.isPending
                ? 'Loading deliveries…'
                : deliveries.length === 0
                  ? `Showing 0 of ${total}`
                  : `Showing ${from}–${to} of ${total}`}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-[11.5px]"
                disabled={cursors.length === 0 || deliveriesQuery.isFetching}
                onClick={() => setCursors(cursors.slice(0, -1))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-[11.5px]"
                disabled={!page?.nextCursor || deliveriesQuery.isFetching}
                onClick={() => page?.nextCursor && setCursors([...cursors, page.nextCursor])}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      </div>

      {webhook && (
        <WebhookFormSheet
          projectId={pid}
          webhook={webhook}
          open={editing}
          onOpenChange={setEditing}
          // Edit mode never mints a secret — only `create` does, and this sheet
          // is only ever opened here with a saved row.
          onSecretRevealed={() => {}}
        />
      )}
    </div>
  )
}

// ── URL readers ─────────────────────────────────────────────────────────────

type Filters = {
  status: DeliveryStatusFilter
  event: DeliveryEventFilter | null
  search: string
  codeMin: number | null
  codeMax: number | null
}

function readFilters(params: URLSearchParams): Filters {
  const rawStatus = params.get(PARAM.status)
  const rawEvent = params.get(PARAM.event)
  return {
    status: (STATUS_VALUES as readonly string[]).includes(rawStatus ?? '')
      ? (rawStatus as DeliveryStatusFilter)
      : 'all',
    event: (EVENT_VALUES as readonly string[]).includes(rawEvent ?? '')
      ? (rawEvent as DeliveryEventFilter)
      : null,
    // The router refuses an empty/over-long term, so it is clamped here rather
    // than sent and rejected.
    search: (params.get(PARAM.search) ?? '').trim().slice(0, 200),
    codeMin: readCode(params.get(PARAM.codeMin)),
    codeMax: readCode(params.get(PARAM.codeMax)),
  }
}

function readCode(raw: string | null): number | null {
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  return Number.isNaN(n) || n < 100 || n > 599 ? null : n
}

function readCursors(params: URLSearchParams): string[] {
  const raw = params.get(PARAM.cursors)
  return raw ? raw.split(',').filter(Boolean) : []
}

function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

// ── Toolbar pieces ──────────────────────────────────────────────────────────

/**
 * The `7a` segmented control. `SegmentedToggle` is the app's shared segmented
 * control but takes a flat `label` string; the counts here are a second,
 * dimmed span inside each segment, so this renders the same chrome with the
 * count as its own element. Counts are dimmed uniformly (the canvas dims only
 * `All`'s — normalised, flagged to the designer).
 */
function SegmentCounts({
  value,
  counts,
  onChange,
}: {
  value: DeliveryStatusFilter
  counts: { all: number; failed: number; retrying: number } | undefined
  onChange: (value: DeliveryStatusFilter) => void
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5">
      {SEGMENTS.map((segment) => {
        const count = counts?.[segment.value as 'all' | 'failed' | 'retrying']
        const active = value === segment.value
        return (
          <button
            key={segment.value}
            type="button"
            onClick={() => onChange(segment.value)}
            className={cn(
              'rounded px-3 py-1 text-[11.5px] font-medium transition-colors',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {segment.label}
            {count != null && (
              <span className={cn('ml-1.5 font-mono', !active && 'opacity-60')}>{count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2.5 py-1.5 font-mono text-[11.5px] text-foreground">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}

function AddFilterMenu({
  onEvent,
  onStatus,
  onCodeRange,
}: {
  onEvent: (event: DeliveryEventFilter) => void
  onStatus: (status: DeliveryStatusFilter) => void
  onCodeRange: (min: number, max: number) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 text-[11.5px]">
          <ListFilter className="h-3 w-3" />
          Add filter
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel className="text-[11px]">Add filter</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-[11.5px]">Event type</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {EVENT_VALUES.map((event) => (
              <DropdownMenuItem
                key={event}
                className="font-mono text-[11.5px]"
                onSelect={() => onEvent(event)}
              >
                {event}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-[11.5px]">Status</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {STATUS_VALUES.map((status) => (
              <DropdownMenuItem
                key={status}
                className="text-[11.5px] capitalize"
                onSelect={() => onStatus(status)}
              >
                {status}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-[11.5px]">Response code</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {CODE_RANGES.map((codeRange) => (
              <DropdownMenuItem
                key={codeRange.label}
                className="text-[11.5px]"
                onSelect={() => onCodeRange(codeRange.min, codeRange.max)}
              >
                {codeRange.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Debounced into the URL: typing writes a history entry per keystroke otherwise,
 * and every write is also a refetch.
 */
function SearchField({ value, onCommit }: { value: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState(value)

  // Re-sync when the URL changes underneath (back button, chip removal).
  useEffect(() => setDraft(value), [value])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `onCommit` is rebuilt every render
  useEffect(() => {
    const next = draft.trim().slice(0, 200)
    if (next === value) return
    const timer = setTimeout(() => onCommit(next), 400)
    return () => clearTimeout(timer)
  }, [draft, value])

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 sm:min-w-[230px] sm:flex-none">
      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <input
        type="search"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Search ticket id or response body…"
        className="w-full bg-transparent text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}

// ── Volume chart ────────────────────────────────────────────────────────────

/** The tallest stack fills this share of the plot box (frame `7a`). */
const CHART_PEAK_SHARE = 0.86
/** `min-height:56px` in the frame; 72 leaves the peak bar the same visual mass. */
const CHART_PLOT_HEIGHT = 72

/**
 * 24 stacked hourly bars, delivered teal below and failed red above. Plain divs
 * on purpose — `components/ui/chart.tsx` (recharts) is the app's charting
 * dependency and it is a heavier tool than a fixed-bucket bar strip needs, and
 * the design specifies exact per-segment radii recharts would fight.
 */
function VolumeChart({ buckets, loading }: { buckets: VolumeBucket[]; loading: boolean }) {
  const peak = Math.max(1, ...buckets.map((b) => b.delivered + b.failed))
  const ticks = hourTicks(buckets)

  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-border bg-card p-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10.5px] font-medium text-muted-foreground">
          Deliveries · last 24 hours
        </span>
        <div className="flex items-center gap-2.5 text-[9.5px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="h-[7px] w-[7px] rounded-[2px] bg-teal-400" />
            Delivered
          </span>
          <span className="flex items-center gap-1">
            <span className="h-[7px] w-[7px] rounded-[2px] bg-red-500" />
            Failed
          </span>
        </div>
      </div>

      {loading ? (
        <SkeletonChart height={72} bars={24} className="mt-3" />
      ) : (
        <>
          {/* Segment heights are px, not %: the plot box is only as tall as
              `CHART_PLOT_HEIGHT` and a percentage inside an auto-height flex
              column resolves inconsistently across browsers. */}
          <div
            className="mt-3 flex flex-1 items-end gap-[3px]"
            style={{ height: CHART_PLOT_HEIGHT }}
          >
            {buckets.map((bucket) => {
              const scale = (CHART_PLOT_HEIGHT * CHART_PEAK_SHARE) / peak
              const label = `${formatAbsolute(bucket.hourStart)} · ${bucket.delivered} delivered · ${bucket.failed} failed`
              return (
                <div
                  key={String(bucket.hourStart)}
                  title={label}
                  className="flex h-full flex-1 flex-col justify-end gap-px"
                >
                  {bucket.failed > 0 && (
                    <div
                      className="rounded-t-[2px] bg-red-500"
                      style={{ height: bucket.failed * scale }}
                    />
                  )}
                  <div
                    // The stack's top is always rounded; the delivered segment
                    // squares off when a red cap sits on it.
                    className={cn(
                      'bg-teal-400',
                      bucket.failed > 0 ? 'rounded-none' : 'rounded-t-[2px]',
                    )}
                    style={{ height: bucket.delivered * scale }}
                  />
                </div>
              )
            })}
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[9.5px] text-muted-foreground/70">
            {ticks.map((tick) => (
              <span key={tick}>{tick}</span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** First / middle / last bucket, with ` yest.` on any hour before the last one's day. */
function hourTicks(buckets: VolumeBucket[]): string[] {
  if (buckets.length === 0) return []
  const last = toDate(buckets.at(-1)?.hourStart)
  const label = (bucket: VolumeBucket | undefined): string => {
    const d = toDate(bucket?.hourStart)
    if (!d) return ''
    const sameDay = !last || d.toDateString() === last.toDateString()
    return `${formatDate(d, 'HH:mm')}${sameDay ? '' : ' yest.'}`
  }
  return [
    label(buckets[0]),
    label(buckets[Math.floor(buckets.length / 2)]),
    label(buckets.at(-1)),
  ].filter(Boolean)
}

// ── Stat tile ───────────────────────────────────────────────────────────────
// Same chrome as `components/StatCard.tsx` (and therefore as `SkeletonStatCard`,
// which stands in while the query is pending) with one addition the generic card
// has no notion of: `7a` tints the VALUE — Failed red, Success rate teal.

function StatTile({
  icon: Icon,
  label,
  value,
  valueClassName,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  valueClassName?: string
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <div className="flex h-6 w-6 items-center justify-center rounded bg-primary/10">
          <Icon className="h-3.5 w-3.5 text-primary" />
        </div>
      </div>
      <div
        className={cn(
          'font-mono text-2xl font-semibold tracking-tight text-foreground',
          valueClassName,
        )}
      >
        {value}
      </div>
    </div>
  )
}

// ── `5c` state cards ────────────────────────────────────────────────────────

const STATE_TONES = {
  bad: 'border-red-500/30 bg-red-500/5',
  warn: 'border-amber-500/25 bg-amber-500/5',
  idle: 'border-border bg-muted/20',
} as const

function StateCard({
  tone,
  icon: Icon,
  title,
  body,
  actionLabel,
  onAction,
  actionPending,
}: {
  tone: keyof typeof STATE_TONES
  icon: React.ComponentType<{ className?: string }>
  title: string
  body: string
  actionLabel: string
  onAction: () => void
  actionPending?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl border p-4 md:flex-row md:items-start md:gap-3',
        STATE_TONES[tone],
      )}
    >
      <Icon
        className={cn(
          'h-4 w-4 shrink-0 md:mt-0.5',
          tone === 'bad'
            ? 'text-red-400'
            : tone === 'warn'
              ? 'text-amber-400'
              : 'text-muted-foreground',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-foreground">{title}</div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{body}</p>
      </div>
      <Button
        type="button"
        size="sm"
        variant={tone === 'bad' ? 'destructive' : 'outline'}
        onClick={onAction}
        disabled={actionPending}
        className="h-7 shrink-0 self-start text-[11px]"
      >
        {actionPending ? 'Working…' : actionLabel}
      </Button>
    </div>
  )
}

type HealthRollup =
  | { considered: number; failures: number; p95LatencyMs: number | null }
  | undefined

function StateCards({
  webhook,
  rollup,
  tone,
  onReEnable,
  reEnablePending,
  onSendTest,
  sendTestPending,
  onViewFailed,
}: {
  webhook: SupportWebhookRow | undefined
  rollup: HealthRollup
  tone: HealthTone
  onReEnable: () => void
  reEnablePending: boolean
  onSendTest: () => void
  sendTestPending: boolean
  onViewFailed: () => void
}) {
  if (!webhook) return null

  const autoDisabled = !!webhook.autoDisabledAt
  const neverDelivered = (rollup?.considered ?? 0) === 0

  // `failing` without an auto-disable gets no card of its own: the only `5c`
  // amber copy is the degraded one ("retries are still succeeding"), which is
  // untrue of a failing endpoint. The header `StatusDot` carries that state.
  if (!autoDisabled && !neverDelivered && tone !== 'degraded') return null

  return (
    <div className="flex flex-col gap-3">
      {autoDisabled && (
        <StateCard
          tone="bad"
          icon={AlertTriangle}
          title="Auto-disabled after repeated failures"
          // The "nothing is lost" sentence is load-bearing and TRUE today: the
          // sweep's claim predicate filters on `w."active"`, so deactivating a
          // webhook stops the worker picking rows up — it does not drop them.
          body={`${hostOf(webhook.url)} returned 5xx on ${webhook.consecutiveFailures ?? 20} consecutive attempts and was paused. Tickets are still created and queued — nothing is lost. Re-enable once the endpoint is healthy and we replay the backlog.`}
          actionLabel="Re-enable & replay"
          onAction={onReEnable}
          actionPending={reEnablePending}
        />
      )}

      {!autoDisabled && tone === 'degraded' && (
        <StateCard
          tone="warn"
          icon={Clock}
          title={`Degraded — ${rollup?.failures ?? 0} of the last ${rollup?.considered ?? 20} deliveries failed`}
          body={`Retries are still succeeding, so tickets are arriving late rather than not at all. p95 latency has climbed to ${formatLatency(rollup?.p95LatencyMs ?? null)}.`}
          actionLabel="View failed"
          onAction={onViewFailed}
        />
      )}

      {!autoDisabled && neverDelivered && (
        <StateCard
          tone="idle"
          icon={Webhook}
          title="No deliveries yet"
          body="This destination has never received a ticket. Send a test payload to confirm it is wired up before you go live."
          actionLabel="Send test"
          onAction={onSendTest}
          actionPending={sendTestPending}
        />
      )}
    </div>
  )
}

// ── Rows ────────────────────────────────────────────────────────────────────

/** Mirrors `DeliveryRow`'s real grid — same column count and row height. */
function DeliveryRowsSkeleton() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 9 }).map((_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
          key={i}
          className="grid grid-cols-[auto_1fr_auto] items-center gap-3.5 border-b border-border px-4 py-[11px] lg:grid-cols-[100px_150px_1fr_74px_78px_70px_150px_24px]"
        >
          <Skeleton className="h-4 w-[70px]" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="hidden h-3 w-4/5 lg:block" />
          <Skeleton className="hidden h-3 w-8 lg:block" />
          <Skeleton className="hidden h-3 w-10 lg:block" />
          <Skeleton className="hidden h-3 w-10 lg:block" />
          <Skeleton className="hidden h-3 w-24 lg:block" />
          <Skeleton className="h-3 w-3" />
        </div>
      ))}
    </div>
  )
}

function DeliveryRow({
  delivery,
  maxAttempts,
  expanded,
  onToggle,
  onRetry,
  retryPending,
}: {
  delivery: Delivery
  maxAttempts: number
  expanded: boolean
  onToggle: () => void
  onRetry: () => void
  retryPending: boolean
}) {
  // Attempts arrive `attempt: 'desc'` from the router, so `[0]` is the newest.
  const latest = delivery.attempts_[0]
  const status = deliveryRowStatus(delivery)
  const code = latest?.responseCode ?? delivery.lastStatusCode
  // `—` (no response at all) is coloured like a ≥400 code: a connect/timeout
  // failure is not a neutral outcome.
  const codeBad = code == null || code >= 400
  const attempt = latest?.attempt ?? delivery.attempts

  return (
    <div
      className={cn(
        'border-b border-border last:border-b-0',
        // Only retrying rows are tinted — a screen full of failures would
        // otherwise be a wall of red, and the status chip already carries it.
        status.tone === 'degraded' && 'bg-amber-500/[0.05]',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-3.5 px-4 py-[11px] text-left transition-colors hover:bg-muted/20 lg:grid-cols-[100px_150px_1fr_74px_78px_70px_150px_24px]"
      >
        <StatusDot tone={status.tone} label={status.label} className="justify-self-start" />

        <span className="hidden truncate font-mono text-[11.5px] text-muted-foreground lg:block">
          {delivery.event}
        </span>

        <div className="flex min-w-0 flex-col lg:flex-row lg:items-center lg:gap-2">
          <span className="truncate font-mono text-[11.5px] text-muted-foreground lg:hidden">
            {delivery.event}
          </span>
          <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
            {delivery.ticket ? `#${delivery.ticket.number}` : delivery.isTest ? 'test' : '—'}
          </span>
          <span className="truncate text-xs text-foreground">
            {delivery.ticket?.subject ?? (delivery.isTest ? 'Test payload' : '')}
          </span>
          {/* Compact meta line — the columns hidden below `lg`. */}
          <span className="mt-1 flex items-center gap-2 font-mono text-[10px] text-muted-foreground lg:hidden">
            <span className={cn(codeBad ? 'text-red-400' : 'text-teal-400')}>{code ?? '—'}</span>
            <span>·</span>
            <span>{formatLatency(latest?.latencyMs)}</span>
            <span>·</span>
            <span className={attemptClass(status.tone)}>
              {attempt} of {maxAttempts}
            </span>
            <span>·</span>
            <span>{formatAbsolute(delivery.createdAt)}</span>
          </span>
        </div>

        <span
          className={cn(
            'hidden font-mono text-[11.5px] lg:block',
            codeBad ? 'text-red-400' : 'text-teal-400',
          )}
        >
          {code ?? '—'}
        </span>
        <span className="hidden font-mono text-[11.5px] text-muted-foreground lg:block">
          {formatLatency(latest?.latencyMs)}
        </span>
        <span className={cn('hidden font-mono text-[11.5px] lg:block', attemptClass(status.tone))}>
          {attempt} of {maxAttempts}
        </span>
        <span className="hidden font-mono text-[11px] text-muted-foreground lg:block">
          {formatAbsolute(delivery.createdAt)}
        </span>

        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {expanded && (
        <ExpandedDelivery
          delivery={delivery}
          maxAttempts={maxAttempts}
          onRetry={onRetry}
          retryPending={retryPending}
        />
      )}
    </div>
  )
}

function ExpandedDelivery({
  delivery,
  maxAttempts,
  onRetry,
  retryPending,
}: {
  delivery: Delivery
  maxAttempts: number
  onRetry: () => void
  retryPending: boolean
}) {
  const latest = delivery.attempts_[0]
  const failed = delivery.status === 'failed' || (latest?.outcome ?? 'delivered') !== 'delivered'
  const countdown = delivery.status === 'pending' ? formatCountdown(delivery.nextAttemptAt) : null
  const purged = !!latest?.bodiesPurgedAt
  const code = latest?.responseCode ?? delivery.lastStatusCode

  const requestText = purged
    ? null
    : [...headerLines(latest?.requestHeaders), '', latest?.requestBody ?? ''].join('\n').trim()
  const responseText = purged
    ? null
    : [...headerLines(latest?.responseHeaders), '', latest?.responseBody ?? ''].join('\n').trim() ||
      (latest?.errorMessage ?? delivery.lastError ?? 'No response body.')

  return (
    <div className={cn('px-4 pb-4 pt-3', failed && 'bg-red-500/[0.03]')}>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-2.5">
        {failed && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" />}
        <span className="text-xs font-semibold text-foreground">
          Attempt {latest?.attempt ?? delivery.attempts} of {maxAttempts}{' '}
          {failed ? 'failed' : 'delivered'}
        </span>
        {countdown && (
          <span className="text-[11px] text-muted-foreground">· next retry in {countdown}</span>
        )}
        <span className="flex items-center gap-2 sm:ml-auto">
          <CopyButton
            variant="outline"
            label="Copy payload"
            value={JSON.stringify(delivery.payload, null, 2)}
            className="h-7 text-[11px]"
          />
          <Button
            type="button"
            size="sm"
            onClick={onRetry}
            disabled={retryPending}
            className="h-7 text-[11px]"
          >
            Retry now
          </Button>
        </span>
      </div>

      {/* Panes stack below `md` rather than sitting side by side — a 50%-width
          mono pane at 375px is unreadable. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Pane title="Request" tone="neutral">
          {purged ? <PurgedNote /> : <PaneBody text={requestText ?? ''} />}
        </Pane>
        <Pane
          title={`Response${code != null ? ` · ${code}` : ''}`}
          tone={failed ? 'bad' : 'neutral'}
        >
          {purged ? (
            <PurgedNote />
          ) : (
            <PaneBody text={responseText ?? ''} tone={failed ? 'bad' : 'neutral'} />
          )}
        </Pane>
      </div>

      {latest?.bodyTruncated && (
        <p className="mt-2 text-[10px] text-muted-foreground">Body truncated at 64KB.</p>
      )}
    </div>
  )
}

function Pane({
  title,
  tone,
  children,
}: {
  title: string
  tone: 'neutral' | 'bad'
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'min-w-0 overflow-hidden rounded-lg border',
        tone === 'bad' ? 'border-red-500/25 bg-red-500/[0.04]' : 'border-border bg-[#0F0F19]',
      )}
    >
      <div
        className={cn(
          'border-b px-3 py-2 text-[10px] font-semibold uppercase tracking-wider',
          tone === 'bad' ? 'border-red-500/20 text-red-400' : 'border-border text-muted-foreground',
        )}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

function PaneBody({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'bad' }) {
  return (
    <pre
      className={cn(
        'max-h-64 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-relaxed',
        tone === 'bad' ? 'text-red-200/80' : 'text-foreground/80',
      )}
    >
      {text || '—'}
    </pre>
  )
}

/** Retention nulls the four body/header columns after 30 days and
 *  stamps `bodiesPurgedAt`; latency, response code and status survive, so an
 *  empty pane here would read as "we never captured this". */
function PurgedNote() {
  return (
    <p className="p-3 text-[11px] text-muted-foreground">
      Payload purged after {RETENTION_DAYS} days
    </p>
  )
}
