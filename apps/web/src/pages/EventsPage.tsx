import { keepPreviousData } from '@tanstack/react-query'
import { Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { EventTypeBadge, SchemaInvalidBadge } from '@/components/badges'
import { DateRangeControl } from '@/components/DateRangeControl'
import { EventTypePicker } from '@/components/EventTypePicker'
import { PageHeader } from '@/components/PageHeader'
import type { SegmentedOption } from '@/components/SegmentedToggle'
import { SkeletonTable } from '@/components/skeletons'
import { Input } from '@/components/ui/input'
import { useEventNames } from '@/hooks/useTaxonomy'
import { useUrlDateRange } from '@/hooks/useUrlDateRange'
import { formatTimestamp } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { makeParamSetter, parseIntParam, parseStringParam } from '@/lib/url-params'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'

const ALL_EVENTS = '__all__'
const PAGE_SIZE = 50

const COLUMNS = ['Time', 'Type', 'User', 'Page', 'Schema'] as const

export function EventsPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const { can } = useAuth()
  const canManageProjects = can('projects:manage')
  const [searchParams, setSearchParams] = useSearchParams()
  const setParam = useMemo(() => makeParamSetter(setSearchParams), [setSearchParams])
  const {
    selection: rangeSel,
    setSelection: setRangeSel,
    customRange,
    setCustomRange,
    range,
  } = useUrlDateRange({ defaultSelection: '7d' })
  const [refreshMs, setRefreshMs] = useState(5000)
  // URL-backed filters (shareable). Search keeps a local input mirror so typing
  // stays instant; the debounced value is what lands in the URL and query key.
  const search = parseStringParam(searchParams.get('q'), '')
  const eventType = searchParams.get('event') || ALL_EVENTS
  const page = parseIntParam(searchParams.get('page'), 1, { min: 1 })
  const [searchInput, setSearchInput] = useState(search)
  const setEventType = (next: string) => setParam('event', next, ALL_EVENTS)
  const setPage = (next: number) => setParam('page', next, 1)
  const enabled = !!projectId
  // react-query wants `false` (not 0) to disable polling.
  const refetchInterval = refreshMs > 0 ? refreshMs : (false as const)

  // Taxonomy-powered event-type picker — replaces topEvents.
  const eventNames = useEventNames(projectId)

  const typeOptions = useMemo<ReadonlyArray<SegmentedOption<string>>>(
    () => [
      { label: 'all', value: ALL_EVENTS },
      ...eventNames.options.map((o) => ({ label: o.label, value: o.value })),
    ],
    [eventNames.options],
  )

  // Debounce the free-text search into the URL (and thus the query key). Only
  // write when the debounced value actually differs from what's in the URL, so
  // seeding the input from a shared `?q=` link doesn't rewrite the URL on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setParam/search read intentionally, effect keyed on input
  useEffect(() => {
    const t = setTimeout(() => {
      const trimmed = searchInput.trim()
      if (trimmed !== search) setParam('q', trimmed, '')
    }, 300)
    return () => clearTimeout(t)
  }, [searchInput])

  // Any filter change resets pagination to the first page — but NOT on the
  // initial mount, so a shared `?page=3` link lands on page 3.
  const firstFilterRun = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset page when filters change
  useEffect(() => {
    if (firstFilterRun.current) {
      firstFilterRun.current = false
      return
    }
    setPage(1)
  }, [range.from, range.to, search, eventType])

  const list = trpc.events.list.useQuery(
    {
      projectId: projectId as string,
      range,
      event: eventType === ALL_EVENTS ? undefined : eventType,
      search: search || undefined,
      page,
      pageSize: PAGE_SIZE,
    },
    // Keep the loaded page rendered while a new page / range is fetched — paginating
    // must not collapse the table back to a skeleton.
    { enabled, refetchInterval, placeholderData: keepPreviousData },
  )

  const rows = list.data ?? []
  const hasNextPage = rows.length === PAGE_SIZE

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No project selected.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Events" subtitle="Real-time event stream">
        {canManageProjects && (
          <button
            type="button"
            onClick={() => navigate('/data-management?tab=schema&create=1')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs font-medium hover:opacity-90 transition-opacity"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Event
          </button>
        )}
      </PageHeader>

      <div className="px-5 py-2.5 border-b border-border flex flex-wrap items-center gap-3 shrink-0">
        <div className="relative max-w-xs shrink-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Filter by event, user, or URL..."
            className="h-auto pl-8 pr-3 py-1.5 text-xs w-64 bg-muted/30"
          />
        </div>
        <EventTypePicker options={typeOptions} value={eventType} onChange={setEventType} />
        <div className="ml-auto">
          <DateRangeControl
            selection={rangeSel}
            onSelectionChange={setRangeSel}
            customRange={customRange}
            onCustomRangeChange={setCustomRange}
            refresh={{ value: refreshMs, onChange: setRefreshMs }}
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {list.isPending ? (
          <SkeletonTable rows={12} cols={COLUMNS.length} />
        ) : list.error ? (
          <div className="m-4 rounded border border-red-500/30 bg-red-500/10 p-4 text-xs text-red-400">
            <p className="font-medium">Failed to load events</p>
            <p className="mt-1 text-red-400/80">{list.error.message}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
            {search || eventType !== ALL_EVENTS
              ? 'No events match your filters.'
              : 'No events in this range.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-background z-10">
                <tr className="border-b border-border">
                  {COLUMNS.map((h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-2.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.uuid}
                    onClick={() => navigate(`/events/${row.uuid}`)}
                    className="border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-2.5 font-mono text-muted-foreground whitespace-nowrap tabular-nums">
                      {formatTimestamp(row.timestamp)}
                    </td>
                    <td className="px-4 py-2.5">
                      <EventTypeBadge type={row.event} />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-muted-foreground">
                      {row.distinct_id}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground max-w-full sm:max-w-[420px] truncate">
                      {row.current_url || '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      {row.schema_valid === 0 ? (
                        <SchemaInvalidBadge />
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="px-5 py-2 border-t border-border flex items-center justify-between text-[10px] text-muted-foreground font-mono shrink-0">
        <span>
          {rows.length} events · Page {page}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1 || list.isLoading}
            className="px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Prev
          </button>
          <button
            type="button"
            onClick={() => setPage(page + 1)}
            disabled={!hasNextPage || list.isLoading}
            className="px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  )
}
