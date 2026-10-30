import { keepPreviousData } from '@tanstack/react-query'
import { Activity, ChevronRight, Clock, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { EventTypeBadge, StatusBadge } from '@/components/badges'
import { DateRangeControl } from '@/components/DateRangeControl'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonCard, SkeletonList } from '@/components/skeletons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useUrlDateRange } from '@/hooks/useUrlDateRange'
import { formatNumber, formatTimestamp } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { makeParamSetter, parseEnumParam, parseIntParam } from '@/lib/url-params'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 50
const ACTIVE_WINDOW_MS = 30 * 60 * 1000 // 30min — matches the SDK's session idle timeout.

type SortKey = 'last_seen' | 'events' | 'first_seen'
const SORT_KEYS: readonly SortKey[] = ['last_seen', 'events', 'first_seen']

type PersonTraits = {
  email?: string
  name?: string
  org_id?: string
  org_name?: string
}

// Real status derived from lastSeen recency (no mock — no persons/presence table).
function deriveStatus(lastSeen: string): 'active' | 'idle' {
  return Date.now() - new Date(lastSeen).getTime() < ACTIVE_WINDOW_MS ? 'active' : 'idle'
}

// Display name: real `traits.name`, else the distinct_id itself (never a fake persona).
function displayName(distinctId: string, traits: PersonTraits | undefined): string {
  return traits?.name || distinctId
}

export function UsersPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const setParam = useMemo(() => makeParamSetter(setSearchParams), [setSearchParams])
  const {
    selection: rangeSel,
    setSelection: setRangeSel,
    customRange,
    setCustomRange,
    range,
  } = useUrlDateRange({ defaultSelection: '30d' })
  // URL-backed filters (shareable). `search` is applied on Enter; `searchInput`
  // mirrors it locally so typing stays instant before the apply.
  const search = searchParams.get('q')?.trim() ?? ''
  const sort = parseEnumParam<SortKey>(searchParams.get('sort'), SORT_KEYS, 'last_seen')
  const page = parseIntParam(searchParams.get('page'), 1, { min: 1 })
  const [searchInput, setSearchInput] = useState(search)
  const setSort = (next: SortKey) => setParam('sort', next, 'last_seen')
  const setPage = (next: number) => setParam('page', next, 1)
  const enabled = !!projectId

  const users = trpc.events.users.useQuery(
    {
      projectId: projectId as string,
      range,
      page,
      search: search || undefined,
    },
    // Keep the loaded page rendered while a new page / range is fetched.
    { enabled, placeholderData: keepPreviousData },
  )

  function applySearch() {
    // Reset to page 1 and write both params in one URL update.
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        const q = searchInput.trim()
        if (q) params.set('q', q)
        else params.delete('q')
        params.delete('page')
        return params
      },
      { replace: true },
    )
  }

  const rows = users.data ?? []
  const hasNextPage = rows.length === PAGE_SIZE

  const visible = useMemo(() => {
    const sorted = [...rows]
    if (sort === 'events') sorted.sort((a, b) => b.eventCount - a.eventCount)
    else if (sort === 'first_seen')
      sorted.sort((a, b) => new Date(b.firstSeen).getTime() - new Date(a.firstSeen).getTime())
    // last_seen is already the server order.
    return sorted
  }, [rows, sort])

  if (!projectId) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <PageHeader
          title="Users"
          subtitle="Identified visitors, their activity, and recent events."
        />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Select a project to view users.
        </div>
      </div>
    )
  }

  const activeCount = rows.filter((r) => deriveStatus(r.lastSeen) === 'active').length

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Users"
        subtitle={`${formatNumber(rows.length)} identified · ${formatNumber(activeCount)} active`}
      >
        <DateRangeControl
          selection={rangeSel}
          onSelectionChange={setRangeSel}
          customRange={customRange}
          onCustomRangeChange={setCustomRange}
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="bg-muted/30 border border-border rounded text-xs px-2.5 py-1.5 text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
        >
          <option value="last_seen">Sort: Last seen</option>
          <option value="events">Sort: Most events</option>
          <option value="first_seen">Sort: First seen</option>
        </select>
      </PageHeader>

      {/* Filter bar */}
      <div className="px-5 py-2.5 border-b border-border flex items-center gap-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applySearch()
            }}
            placeholder="Search by user ID..."
            className="bg-muted/30 border border-border rounded text-xs pl-8 pr-3 py-1.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 w-72"
          />
        </div>

        <div className="ml-auto text-[10px] text-muted-foreground font-mono">
          {formatNumber(visible.length)} users
        </div>
      </div>

      {/* User list */}
      <div className="flex-1 overflow-auto">
        {users.isPending ? (
          <SkeletonList rows={10} avatar className="gap-5 px-5 py-4" />
        ) : users.error ? (
          <Alert variant="destructive" className="m-4 w-auto">
            <AlertTitle>Failed to load users</AlertTitle>
            <AlertDescription>{users.error.message}</AlertDescription>
          </Alert>
        ) : visible.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            No users found.
          </div>
        ) : (
          visible.map((user) => {
            const name = displayName(user.distinct_id, user.traits)
            const status = deriveStatus(user.lastSeen)
            return (
              <button
                type="button"
                key={user.distinct_id}
                onClick={() => navigate(`/users/${encodeURIComponent(user.distinct_id)}`)}
                className="w-full flex items-center gap-4 px-5 py-3.5 border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer group text-left"
              >
                <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-xs font-bold text-primary-foreground shrink-0">
                  {name[0]?.toUpperCase()}
                </div>

                <div className="w-52 shrink-0 min-w-0">
                  <div className="text-xs font-medium text-foreground group-hover:text-primary transition-colors truncate">
                    {name}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {user.traits?.email ?? '—'}
                  </div>
                </div>

                <div className="w-40 shrink-0 min-w-0">
                  <div className="text-[11px] text-foreground truncate">
                    {user.traits?.org_name ?? '—'}
                  </div>
                </div>

                <div className="w-20 shrink-0">
                  <StatusBadge status={status} />
                </div>

                <div className="flex items-center gap-5 shrink-0">
                  <div className="text-center w-16">
                    <div className="font-mono text-xs text-foreground tabular-nums">
                      {formatNumber(user.eventCount)}
                    </div>
                    <div className="text-[9px] text-muted-foreground">events</div>
                  </div>
                </div>

                <div className="ml-auto shrink-0 text-right">
                  <div className="text-[11px] text-muted-foreground">
                    {formatTimestamp(user.lastSeen)}
                  </div>
                </div>
              </button>
            )
          })
        )}
      </div>

      <div className="flex items-center justify-between px-5 py-2 border-t border-border shrink-0">
        <span className="text-[10px] text-muted-foreground font-mono">
          {formatNumber(visible.length)} users · Page {page}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1 || users.isLoading}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(page + 1)}
            disabled={!hasNextPage || users.isLoading}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Inline activity sparkline ─────────────────────────────────────────────────

function Sparkline({ values, color = '#2DD4BF' }: { values: number[]; color?: string }) {
  if (values.length === 0) return <div className="w-14 h-6 bg-muted/20 rounded" />
  const max = Math.max(...values, 1)
  const h = 24
  const w = 56
  const barW = Math.max(1, Math.floor(w / values.length) - 1)
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {values.map((v, i) => {
        const bh = Math.max(2, Math.round((v / max) * h))
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: positional bars
            key={i}
            x={i * (barW + 1)}
            y={h - bh}
            width={barW}
            height={bh}
            rx="1"
            fill={color}
            fillOpacity={i === values.length - 1 ? 0.9 : 0.35}
          />
        )
      })}
    </svg>
  )
}

// ── Full-page user detail ─────────────────────────────────────────────────────

// Derive a coarse timeline category from an event name, for the timeline dot color.
function eventCategory(event: string): 'pageview' | 'click' | 'custom' {
  const e = event.toLowerCase()
  if (e.includes('pageview')) return 'pageview'
  if (e.includes('click') || e.includes('autocapture')) return 'click'
  return 'custom'
}

/**
 * Route: `/users/:distinctId`. Self-contained (mirrors `EventDetailPage`'s
 * convention — `useProjectId`/`useParams`/`useNavigate` directly, no props
 * from a parent list page) so the URL alone is bookmarkable/shareable and
 * survives a refresh.
 */
export function UserDetailPage() {
  const projectId = useProjectId()
  const { distinctId = '' } = useParams()
  const navigate = useNavigate()
  const enabled = !!projectId && !!distinctId
  const summary = trpc.events.userSummary.useQuery(
    { projectId: projectId as string, distinctId },
    { enabled },
  )
  const activity = trpc.events.userActivity.useQuery(
    { projectId: projectId as string, distinctId },
    { enabled },
  )
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canManageProjects = can('projects:manage')
  const [purgeOpen, setPurgeOpen] = useState(false)
  const purge = trpc.events.purgeUser.useMutation()

  function onBack() {
    navigate('/users')
  }

  async function confirmPurge() {
    if (!projectId) return
    try {
      await purge.mutateAsync({ projectId, distinctId })
      toast.success('User data purged')
      setPurgeOpen(false)
      await utils.events.users.invalidate()
      onBack()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to purge user data')
    }
  }

  const traits = summary.data?.traits
  const name = displayName(distinctId, traits)
  const status = summary.data?.lastSeen ? deriveStatus(summary.data.lastSeen) : 'idle'
  const sparkValues = (activity.data ?? []).map((d) => d.count)

  const stats = [
    { label: 'Total events', value: formatNumber(summary.data?.totalEvents ?? 0) },
    { label: 'Sessions', value: formatNumber(summary.data?.totalSessions ?? 0) },
    {
      label: 'First seen',
      value: summary.data?.firstSeen ? formatTimestamp(summary.data.firstSeen) : '—',
    },
    {
      label: 'Last seen',
      value: summary.data?.lastSeen ? formatTimestamp(summary.data.lastSeen) : '—',
    },
  ]

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a project to view this user.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Header */}
      <div className="px-8 pt-6 pb-0 shrink-0">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors mb-4 group"
        >
          <ChevronRight className="w-3 h-3 rotate-180 group-hover:-translate-x-0.5 transition-transform" />
          Users
        </button>
        <div className="flex items-start gap-5 mb-5">
          <div className="w-12 h-12 rounded-full bg-primary flex items-center justify-center text-sm font-bold text-primary-foreground shrink-0">
            {name[0]?.toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-semibold text-foreground">{name}</h1>
              <StatusBadge status={status} />
            </div>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              <span className="text-xs text-muted-foreground">{traits?.email ?? '—'}</span>
              {traits?.org_name && (
                <span className="text-xs text-muted-foreground">· {traits.org_name}</span>
              )}
              <span className="font-mono text-[10px] text-muted-foreground/60">{distinctId}</span>
            </div>
            <div className="flex items-center gap-4 mt-2">
              {stats.map(({ label, value }) => (
                <div key={label} className="text-center">
                  <div className="font-mono text-xs font-semibold text-foreground">{value}</div>
                  <div className="text-[10px] text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="shrink-0 flex flex-col items-end gap-3">
            <div>
              <div className="font-mono text-[10px] text-muted-foreground mb-1 text-right">
                7-day activity
              </div>
              {activity.isPending ? (
                <Skeleton className="w-14 h-6" />
              ) : (
                <Sparkline values={sparkValues} />
              )}
            </div>
            {canManageProjects && (
              <AlertDialog open={purgeOpen} onOpenChange={setPurgeOpen}>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-400 hover:text-red-400"
                  onClick={() => setPurgeOpen(true)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete user data
                </Button>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this user's data?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Permanently deletes all events and feature-flag activity for{' '}
                      <span className="font-mono">{distinctId}</span> in this project. This cannot
                      be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={purge.isPending}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={(e) => {
                        e.preventDefault()
                        confirmPurge()
                      }}
                      disabled={purge.isPending}
                      className="bg-red-500 text-white hover:bg-red-600"
                    >
                      {purge.isPending ? 'Deleting…' : 'Delete data'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="timeline" className="flex-1 flex flex-col min-h-0">
        <div className="px-8 border-b border-border shrink-0">
          <TabsList className="bg-transparent h-auto p-0 gap-0">
            {(['timeline', 'sessions', 'properties', 'flags'] as const).map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                className="px-4 py-2.5 text-xs font-medium capitalize rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
              >
                {t}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <div className="flex-1 overflow-auto">
          <TabsContent value="timeline" className="m-0">
            <TimelineTab projectId={projectId} distinctId={distinctId} />
          </TabsContent>
          <TabsContent value="sessions" className="m-0">
            <SessionsTab projectId={projectId} distinctId={distinctId} />
          </TabsContent>
          <TabsContent value="properties" className="m-0">
            <PropertiesTab distinctId={distinctId} summary={summary.data} />
          </TabsContent>
          <TabsContent value="flags" className="m-0">
            <FlagsTab projectId={projectId} distinctId={distinctId} at={summary.data?.lastSeen} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}

// ── Timeline tab ──────────────────────────────────────────────────────────────

function TimelineTab({ projectId, distinctId }: { projectId: string; distinctId: string }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const detail = trpc.events.userDetail.useQuery(
    { projectId, distinctId, limit: 100 },
    { enabled: true },
  )

  if (detail.isPending) {
    return <SkeletonList rows={8} avatar className="px-8 py-5 max-w-3xl" />
  }
  if (detail.error) {
    return (
      <Alert variant="destructive" className="m-8 w-auto">
        <AlertTitle>Failed to load activity</AlertTitle>
        <AlertDescription>{detail.error.message}</AlertDescription>
      </Alert>
    )
  }
  const events = detail.data ?? []
  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center py-16 text-center">
        <Activity className="w-8 h-8 text-muted-foreground/20 mb-2" />
        <div className="text-xs text-muted-foreground">No events recorded yet</div>
      </div>
    )
  }

  return (
    <div className="px-8 py-5 max-w-3xl">
      <div className="relative">
        <div className="absolute left-[15px] top-3 bottom-0 w-px bg-border" />
        <div className="space-y-1">
          {events.map((ev, i) => {
            const isOpen = expanded === ev.uuid
            const date = formatTimestamp(ev.timestamp)
            const prevDate = i > 0 ? formatTimestamp(events[i - 1].timestamp) : null
            const showDate = i === 0 || date !== prevDate
            const category = eventCategory(ev.event)
            const props = parseProps(ev.properties)
            const label = ev.elements_chain_text || ev.current_url || ev.event
            return (
              <div key={ev.uuid}>
                {showDate && (
                  <div className="flex items-center gap-3 py-2 ml-9">
                    <span className="text-[10px] font-medium text-muted-foreground">{date}</span>
                    <div className="flex-1 h-px bg-border/50" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : ev.uuid)}
                  className={cn(
                    'w-full flex gap-3 group cursor-pointer rounded-lg transition-colors text-left',
                    isOpen ? 'bg-muted/20' : 'hover:bg-muted/10',
                  )}
                >
                  <div className="w-8 h-8 rounded-full border border-border bg-card flex items-center justify-center shrink-0 z-10 mt-1">
                    <div
                      className={cn(
                        'w-2 h-2 rounded-full',
                        category === 'click'
                          ? 'bg-teal-400'
                          : category === 'pageview'
                            ? 'bg-violet-400'
                            : 'bg-amber-400',
                      )}
                    />
                  </div>
                  <div className="flex-1 py-2 pr-3 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <EventTypeBadge type={ev.event} />
                      <span className="font-mono text-[11px] text-foreground truncate flex-1">
                        {label}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                        {formatTimestamp(ev.timestamp)}
                      </span>
                      <ChevronRight
                        className={cn(
                          'w-3 h-3 text-muted-foreground/40 shrink-0 transition-transform',
                          isOpen && 'rotate-90',
                        )}
                      />
                    </div>
                    {ev.current_url && (
                      <div className="text-[10px] text-muted-foreground truncate">
                        {ev.current_url}
                      </div>
                    )}
                    {isOpen && props.length > 0 && (
                      <div className="mt-2.5 bg-background border border-border rounded-lg overflow-hidden">
                        {props.map(([k, v], pi) => (
                          <div
                            key={k}
                            className={cn(
                              'flex items-center gap-4 px-3 py-2',
                              pi < props.length - 1 && 'border-b border-border/50',
                            )}
                          >
                            <span className="font-mono text-[10px] text-muted-foreground w-36 shrink-0">
                              {k}
                            </span>
                            <span className={cn('font-mono text-[10px] break-all', valueClass(v))}>
                              {JSON.stringify(v)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Sessions tab ──────────────────────────────────────────────────────────────

function SessionsTab({ projectId, distinctId }: { projectId: string; distinctId: string }) {
  const sessions = trpc.events.userSessions.useQuery(
    { projectId, distinctId, limit: 50 },
    { enabled: true },
  )

  if (sessions.isPending) {
    return (
      <div className="px-8 py-5 max-w-3xl space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
          <SkeletonCard key={i} lines={2} />
        ))}
      </div>
    )
  }
  if (sessions.error) {
    return (
      <Alert variant="destructive" className="m-8 w-auto">
        <AlertTitle>Failed to load sessions</AlertTitle>
        <AlertDescription>{sessions.error.message}</AlertDescription>
      </Alert>
    )
  }
  const list = sessions.data ?? []
  if (list.length === 0) {
    return (
      <div className="flex flex-col items-center py-16 text-center">
        <Clock className="w-8 h-8 text-muted-foreground/20 mb-2" />
        <div className="text-xs text-muted-foreground">No sessions recorded</div>
      </div>
    )
  }

  return (
    <div className="px-8 py-5 max-w-3xl space-y-2">
      {list.map((s) => (
        <div
          key={s.sessionId}
          className="bg-card border border-border rounded-lg px-4 py-4 hover:border-border/80 transition-colors"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-2">
                <span className="font-mono text-[10px] text-muted-foreground truncate max-w-full sm:max-w-[160px]">
                  {s.sessionId}
                </span>
                <span className="text-[10px] text-muted-foreground">·</span>
                <span className="text-[10px] text-muted-foreground">
                  {formatTimestamp(s.startedAt)}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                <span className="font-mono text-foreground font-medium truncate">
                  {s.entryUrl || '—'}
                </span>
                <ChevronRight className="w-3 h-3 text-muted-foreground/40 shrink-0" />
                <span className="font-mono text-foreground font-medium truncate">
                  {s.exitUrl || '—'}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-5 shrink-0 text-center">
              {[
                { label: 'Duration', value: formatDurationSec(s.durationSec) },
                { label: 'Pages', value: s.pages },
                { label: 'Events', value: s.events },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div className="font-mono text-sm font-semibold text-foreground">{value}</div>
                  <div className="text-[10px] text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Properties tab ────────────────────────────────────────────────────────────

function PropertiesTab({
  distinctId,
  summary,
}: {
  distinctId: string
  summary: { firstSeen: string | null; lastSeen: string | null; traits?: PersonTraits } | undefined
}) {
  const traitEntries = Object.entries(summary?.traits ?? {})
  const entries: [string, string][] = [...traitEntries, ['distinct_id', distinctId]]

  return (
    <div className="px-8 py-5 max-w-2xl">
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
            Identify traits
            {traitEntries.length === 0 ? ' · none recorded yet' : ''}
            {summary?.lastSeen ? ` · last seen ${formatTimestamp(summary.lastSeen)}` : ''}
          </div>
        </div>
        {entries.map(([k, v], i) => (
          <div
            key={k}
            className={cn(
              'flex items-center gap-4 px-4 py-3',
              i < entries.length - 1 && 'border-b border-border/50',
            )}
          >
            <span className="font-mono text-[11px] text-muted-foreground w-40 shrink-0">{k}</span>
            <span className={cn('font-mono text-[11px]', valueClass(v))}>{JSON.stringify(v)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Flags tab ─────────────────────────────────────────────────────────────────

function FlagsTab({
  projectId,
  distinctId,
  at,
}: {
  projectId: string
  distinctId: string
  at: string | null | undefined
}) {
  const flags = trpc.events.userFlags.useQuery(
    { projectId, distinctId, at: at ?? new Date().toISOString() },
    { enabled: true },
  )

  const list = flags.data ?? []

  return (
    <div className="px-8 py-5 max-w-xl space-y-3">
      <p className="text-[11px] text-muted-foreground">
        Feature flag values recorded at last evaluation for this user.
      </p>
      {flags.isPending ? (
        <SkeletonList rows={4} className="bg-card border border-border rounded-lg px-4 py-3" />
      ) : list.length === 0 ? (
        <div className="bg-card border border-border rounded-lg px-4 py-8 text-center text-xs text-muted-foreground">
          No flag evaluations recorded
        </div>
      ) : (
        <div className="bg-card border border-border rounded-lg overflow-hidden divide-y divide-border">
          {list.map((f) => {
            const on = f.response === 'true'
            return (
              <div key={f.key} className="flex items-center gap-3 px-4 py-3">
                <div
                  className={cn(
                    'relative w-8 h-4 rounded-full shrink-0',
                    on ? 'bg-primary' : 'bg-muted',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform',
                      on ? 'translate-x-4' : 'translate-x-0',
                    )}
                  />
                </div>
                <span className="font-mono text-[11px] text-foreground flex-1">{f.key}</span>
                <span
                  className={cn(
                    'font-mono text-[10px] font-medium',
                    on ? 'text-teal-400' : 'text-muted-foreground/50',
                  )}
                >
                  {f.response}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Parse a ClickHouse `properties` JSON string into entries; empty on failure. */
function parseProps(raw: string): [string, unknown][] {
  try {
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? Object.entries(obj) : []
  } catch {
    return []
  }
}

function valueClass(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'text-teal-400' : 'text-red-400'
  if (typeof v === 'number') return 'text-violet-400'
  return 'text-foreground'
}

function formatDurationSec(sec: number): string {
  if (sec <= 0) return '0s'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}
