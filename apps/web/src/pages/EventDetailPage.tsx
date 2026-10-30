import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { EventTypeBadge } from '@/components/badges'
import { SkeletonCard, SkeletonList, SkeletonText } from '@/components/skeletons'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate, formatTime, formatTimestamp } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'

type SchemaViolation = {
  kind: 'missing_required' | 'type_mismatch' | string
  property: string
  expected?: string
  actual_json_type?: string
}

/** Parse the raw `schema_errors` JSON array; never throws. */
function parseSchemaErrors(raw: string | undefined): SchemaViolation[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as SchemaViolation[]) : []
  } catch {
    return []
  }
}

function violationMessage(v: SchemaViolation): string {
  if (v.kind === 'missing_required') return `Missing required property: ${v.property}`
  if (v.kind === 'type_mismatch') {
    return `Property "${v.property}" expected ${v.expected ?? 'a different type'}, got ${v.actual_json_type ?? 'unknown'}`
  }
  return `${v.property}: ${v.kind}`
}

/** Parse the raw `properties` JSON blob; never throws. */
function parseProps(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  return String(v)
}

function propType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

const propTypeStyles: Record<string, string> = {
  string: 'bg-slate-500/15 text-slate-300 border-slate-500/25',
  number: 'bg-violet-500/15 text-violet-400 border-violet-500/25',
  boolean: 'bg-teal-500/15 text-teal-400 border-teal-500/25',
  null: 'bg-red-500/15 text-red-400 border-red-500/25',
  object: 'bg-sky-500/15 text-sky-400 border-sky-500/25',
  array: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
}

/** Small type chip shown next to a property value (e.g. "string", "number"). */
function PropTypeBadge({ value }: { value: unknown }) {
  const type = propType(value)
  return (
    <span
      className={cn(
        'text-[9px] font-mono px-1.5 py-0.5 rounded border font-medium uppercase tracking-wide inline-block shrink-0',
        propTypeStyles[type],
      )}
    >
      {type}
    </span>
  )
}

/** Render a property value with type-aware color (matches the Figma reference). */
function PropValue({ value }: { value: unknown }) {
  return (
    <span
      className={cn(
        'font-mono text-[11px] break-all',
        typeof value === 'boolean'
          ? value
            ? 'text-teal-400'
            : 'text-red-400'
          : typeof value === 'number'
            ? 'text-violet-400'
            : 'text-foreground',
      )}
    >
      {typeof value === 'string' ? value : JSON.stringify(value)}
    </span>
  )
}

/** One `[key, value]` row shared by both the custom and native properties lists. */
function PropertyRow({ entry: [k, v], isLast }: { entry: [string, unknown]; isLast: boolean }) {
  return (
    <div
      className={cn('flex items-start gap-4 px-4 py-2.5', !isLast && 'border-b border-border/50')}
    >
      <span className="font-mono text-[11px] text-muted-foreground w-44 shrink-0 pt-px break-all">
        {k}
      </span>
      <PropTypeBadge value={v} />
      <PropValue value={v} />
    </div>
  )
}

export function EventDetailPage() {
  const projectId = useProjectId()
  const { uuid = '' } = useParams()
  const navigate = useNavigate()
  const [propsCopied, setPropsCopied] = useState(false)

  const enabled = !!projectId && !!uuid
  const eventQ = trpc.events.getById.useQuery({ projectId: projectId as string, uuid }, { enabled })
  const event = eventQ.data ?? null
  const distinctId = event?.distinct_id ?? ''

  const summaryQ = trpc.events.userSummary.useQuery(
    { projectId: projectId as string, distinctId },
    { enabled: enabled && !!distinctId },
  )

  // The SDK tags every event with `$session_id`. When present, show the true
  // session timeline; otherwise fall back to this user's recent events.
  const sessionId = str(parseProps(event?.properties).$session_id)
  const sessionQ = trpc.events.sessionEvents.useQuery(
    { projectId: projectId as string, sessionId: sessionId ?? '', limit: 200 },
    { enabled: enabled && !!sessionId },
  )
  const userDetailQ = trpc.events.userDetail.useQuery(
    { projectId: projectId as string, distinctId, limit: 50 },
    { enabled: enabled && !!distinctId && !sessionId },
  )
  const timelineQ = sessionId ? sessionQ : userDetailQ
  const flagsQ = trpc.events.userFlags.useQuery(
    { projectId: projectId as string, distinctId, at: event?.timestamp ?? '' },
    { enabled: enabled && !!distinctId && !!event?.timestamp },
  )

  const properties = useMemo(() => parseProps(event?.properties), [event?.properties])
  // Custom (user/business-defined) properties are whatever the caller actually tracked and
  // are what schema enforcement validates — they're the primary, default-visible group.
  // Native `$`-prefixed keys are SDK/system-injected metadata — secondary, collapsed by default.
  const customProps = useMemo(
    () => Object.entries(properties).filter(([k]) => !k.startsWith('$')),
    [properties],
  )
  const nativeProps = useMemo(
    () => Object.entries(properties).filter(([k]) => k.startsWith('$')),
    [properties],
  )
  const [nativePropsOpen, setNativePropsOpen] = useState(false)
  const schemaViolations = useMemo(
    () => parseSchemaErrors(event?.schema_errors),
    [event?.schema_errors],
  )

  // Device / context lives inside the properties blob (SDK writes PostHog-style
  // `$` keys). Only surface fields that actually exist; the rest render "—".
  const device = useMemo(() => {
    const p = properties
    const screen =
      p.$screen_width && p.$screen_height ? `${p.$screen_width} × ${p.$screen_height}` : null
    const viewport =
      p.$viewport_width && p.$viewport_height
        ? `${p.$viewport_width} × ${p.$viewport_height}`
        : null
    const lib = p.$lib ? `${str(p.$lib)}${p.$lib_version ? ` ${str(p.$lib_version)}` : ''}` : null
    const browser = p.$browser
      ? `${str(p.$browser)}${p.$browser_version ? ` ${str(p.$browser_version)}` : ''}`
      : null
    return [
      ['Browser', browser],
      ['OS', str(p.$os)],
      ['Device', str(p.$device_type)],
      ['Language', str(p.$lang)],
      ['Screen', screen],
      ['Viewport', viewport],
      ['Referrer', str(p.$referrer) ?? '(direct)'],
      ['Host', str(p.$host)],
      ['SDK', lib],
      ['IP', str(p.$ip)],
    ] as [string, string | null][]
  }, [properties])

  const copyProps = () => {
    navigator.clipboard.writeText(JSON.stringify(properties, null, 2))
    setPropsCopied(true)
    setTimeout(() => setPropsCopied(false), 2000)
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No project selected.
      </div>
    )
  }

  // Mirrors the real layout below — header block, then the 1fr/300px two-column body —
  // so nothing jumps when the event lands.
  if (eventQ.isPending) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="px-8 pt-6 pb-5 shrink-0 border-b border-border flex flex-col gap-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-6 w-2/3 max-w-md" />
          <Skeleton className="h-3 w-1/2 max-w-sm" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_300px] gap-0 flex-1 divide-y divide-border md:divide-y-0 md:divide-x">
          <div className="px-8 py-6 space-y-6">
            <SkeletonCard lines={6} />
            <SkeletonList rows={4} />
            <SkeletonCard lines={5} />
          </div>
          <div className="px-5 py-6 space-y-5">
            <SkeletonCard lines={4} />
            <SkeletonCard lines={3} />
          </div>
        </div>
      </div>
    )
  }

  if (eventQ.error) {
    return (
      <div className="m-8 rounded border border-red-500/30 bg-red-500/10 p-4 text-xs text-red-400">
        <p className="font-medium">Failed to load event</p>
        <p className="mt-1 text-red-400/80">{eventQ.error.message}</p>
      </div>
    )
  }

  if (!event) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-muted-foreground">
        <p>Event not found.</p>
        <Link to="/events" className="text-primary hover:opacity-80 transition-opacity">
          Back to Events
        </Link>
      </div>
    )
  }

  const elementLabel = event.elements_chain_text || event.current_url || event.event
  const summary = summaryQ.data
  const timeline = timelineQ.data ?? []
  const flags = flagsQ.data ?? []

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Header */}
      <div className="px-8 pt-6 pb-0 shrink-0">
        <button
          type="button"
          onClick={() => navigate('/events')}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors mb-4 group"
        >
          <ChevronRight className="w-3 h-3 rotate-180 transition-transform group-hover:-translate-x-0.5" />
          Events
        </button>

        <div className="flex items-start justify-between gap-6 mb-5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5">
              <EventTypeBadge type={event.event} />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-foreground font-mono leading-tight break-all">
                {elementLabel}
              </h1>
              <div className="flex flex-wrap items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
                {event.current_url && (
                  <span className="truncate max-w-full sm:max-w-[320px]">{event.current_url}</span>
                )}
                {event.current_url && <span>·</span>}
                <span className="font-mono">{event.uuid}</span>
                <span>·</span>
                <span className="font-mono">{formatTimestamp(event.timestamp)}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] font-medium px-2 py-1 bg-muted/50 text-muted-foreground rounded font-mono">
              {distinctId}
            </span>
          </div>
        </div>

        <div className="border-b border-border -mx-8" />
      </div>

      {/* Body — two-column */}
      <div className="flex-1 overflow-auto">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_300px] gap-0 h-full divide-y divide-border md:divide-y-0 md:divide-x">
          {/* Left — main detail */}
          <div className="overflow-auto px-8 py-6 space-y-6">
            {/* Schema validation */}
            {event.schema_valid === 0 && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <h3 className="text-xs font-semibold text-amber-300">
                      Schema violation{schemaViolations.length !== 1 ? 's' : ''}
                    </h3>
                    <ul className="mt-1.5 space-y-1">
                      {schemaViolations.length === 0 ? (
                        <li className="text-[11px] text-amber-300/80">
                          This event failed schema validation.
                        </li>
                      ) : (
                        schemaViolations.map((v, i) => (
                          <li
                            // biome-ignore lint/suspicious/noArrayIndexKey: violations are unordered, position-stable within one render
                            key={i}
                            className="text-[11px] text-amber-300/80"
                          >
                            {violationMessage(v)}
                          </li>
                        ))
                      )}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* Properties */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-foreground">Properties</h3>
                <button
                  type="button"
                  onClick={copyProps}
                  className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  {propsCopied ? (
                    <Check className="w-3 h-3 text-teal-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  {propsCopied ? 'Copied' : 'Copy JSON'}
                </button>
              </div>
              <div className="bg-card border border-border rounded-lg overflow-hidden">
                {customProps.length === 0 ? (
                  <div className="px-4 py-3 text-[11px] text-muted-foreground">
                    No custom properties.
                  </div>
                ) : (
                  customProps.map((entry, i) => (
                    <PropertyRow
                      key={entry[0]}
                      entry={entry}
                      isLast={i === customProps.length - 1}
                    />
                  ))
                )}
              </div>

              {nativeProps.length > 0 && (
                <Collapsible
                  open={nativePropsOpen}
                  onOpenChange={setNativePropsOpen}
                  className="mt-3"
                >
                  <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors">
                    <ChevronDown
                      className={cn(
                        'w-3 h-3 transition-transform',
                        nativePropsOpen ? 'rotate-0' : '-rotate-90',
                      )}
                    />
                    Native / SDK properties ({nativeProps.length})
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-2">
                    <div className="bg-card/60 border border-border/70 rounded-lg overflow-hidden">
                      {nativeProps.map((entry, i) => (
                        <PropertyRow
                          key={entry[0]}
                          entry={entry}
                          isLast={i === nativeProps.length - 1}
                        />
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </div>

            {/* Session timeline (falls back to recent activity when untagged) */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-foreground">
                  {sessionId ? 'Session timeline' : 'Recent activity'}
                </h3>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {sessionId ?? distinctId}
                </span>
              </div>
              {timelineQ.isPending ? (
                <SkeletonList rows={4} avatar className="px-3 py-2.5" />
              ) : timeline.length === 0 ? (
                <div className="bg-card border border-border rounded-lg px-4 py-3 text-[11px] text-muted-foreground">
                  No other activity for this user.
                </div>
              ) : (
                <div className="relative">
                  <div className="absolute left-[15px] top-3 bottom-3 w-px bg-border" />
                  <div className="space-y-1">
                    {timeline.map((se, i) => {
                      const current = se.uuid === event.uuid
                      return (
                        <div
                          key={se.uuid}
                          className={cn(
                            'flex items-start gap-3 relative rounded-lg px-3 py-2.5 transition-colors',
                            current ? 'bg-primary/8 border border-primary/20' : 'hover:bg-muted/20',
                          )}
                        >
                          <div
                            className={cn(
                              'w-[30px] h-[30px] rounded-full border flex items-center justify-center shrink-0 z-10 text-[8px] font-mono',
                              current
                                ? 'bg-primary border-primary text-primary-foreground font-bold'
                                : 'bg-card border-border text-muted-foreground',
                            )}
                          >
                            {i + 1}
                          </div>
                          <div className="flex-1 pt-0.5 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <EventTypeBadge type={se.event} />
                              {current && (
                                <span className="text-[9px] text-primary font-medium">
                                  ← this event
                                </span>
                              )}
                            </div>
                            <div className="font-mono text-[11px] text-foreground truncate">
                              {se.elements_chain_text || se.current_url || se.event}
                            </div>
                            {se.elements_chain_text && se.current_url && (
                              <div className="text-[10px] text-muted-foreground truncate">
                                {se.current_url}
                              </div>
                            )}
                          </div>
                          <div className="font-mono text-[10px] text-muted-foreground shrink-0 pt-0.5">
                            {formatTime(se.timestamp)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Device & context */}
            <div>
              <h3 className="text-xs font-semibold text-foreground mb-3">Device & context</h3>
              <div className="bg-card border border-border rounded-lg overflow-hidden">
                {device.map(([k, v], i, arr) => (
                  <div
                    key={k}
                    className={cn(
                      'flex items-center gap-4 px-4 py-2.5',
                      i < arr.length - 1 && 'border-b border-border/50',
                    )}
                  >
                    <span className="text-[11px] text-muted-foreground w-28 shrink-0">{k}</span>
                    <span className="font-mono text-[11px] text-foreground break-all">
                      {v ?? <span className="text-muted-foreground/40">—</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right sidebar */}
          <div className="overflow-auto px-5 py-6 space-y-5">
            {/* User card */}
            <div>
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                User
              </h3>
              <div className="bg-card border border-border rounded-lg p-4">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-[11px] font-bold text-primary-foreground shrink-0">
                    {(distinctId[0] ?? '?').toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="font-mono text-xs font-medium text-foreground truncate">
                      {distinctId}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {str(properties.$email) ?? 'anonymous'}
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  {[
                    {
                      l: 'First seen',
                      v: summary?.firstSeen ? formatDate(summary.firstSeen) : '—',
                    },
                    { l: 'Last seen', v: summary?.lastSeen ? formatDate(summary.lastSeen) : '—' },
                    {
                      l: 'Total events',
                      v: summary ? summary.totalEvents.toLocaleString() : '—',
                    },
                    {
                      l: 'Sessions',
                      v: summary ? summary.totalSessions.toLocaleString() : '—',
                    },
                  ].map(({ l, v }) => (
                    <div key={l} className="flex items-center justify-between">
                      <span className="text-[10px] text-muted-foreground">{l}</span>
                      {summaryQ.isPending ? (
                        <Skeleton className="h-4 w-16" />
                      ) : (
                        <span className="text-[11px] text-foreground font-mono">{v}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Feature flags seen */}
            <div>
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Flags at event time
              </h3>
              <div className="bg-card border border-border rounded-lg overflow-hidden divide-y divide-border">
                {flagsQ.isPending ? (
                  <SkeletonText lines={3} className="px-3 py-2.5" />
                ) : flags.length === 0 ? (
                  <div className="px-3 py-2.5 text-[10px] text-muted-foreground">
                    No flag exposures for this user.
                  </div>
                ) : (
                  flags.map((f) => {
                    const on = f.response === 'true'
                    return (
                      <div key={f.key} className="flex items-center gap-2.5 px-3 py-2.5">
                        <div
                          className={cn(
                            'relative w-6 h-3.5 rounded-full shrink-0 overflow-hidden',
                            on ? 'bg-primary' : 'bg-muted',
                          )}
                        >
                          <span
                            className={cn(
                              'absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-transform',
                              on ? 'translate-x-2.5' : 'translate-x-0',
                            )}
                          />
                        </div>
                        <span className="font-mono text-[10px] text-foreground flex-1 truncate">
                          {f.key}
                        </span>
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
                  })
                )}
              </div>
            </div>

            {/* Raw JSON */}
            <div>
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Raw event
              </h3>
              <div className="bg-card border border-border rounded-lg overflow-hidden">
                <pre className="px-4 py-3.5 text-[10px] font-mono text-muted-foreground leading-relaxed overflow-auto max-h-64">
                  {JSON.stringify(
                    {
                      uuid: event.uuid,
                      event: event.event,
                      distinct_id: event.distinct_id,
                      current_url: event.current_url,
                      timestamp: event.timestamp,
                      elements_chain_text: event.elements_chain_text,
                      properties,
                    },
                    null,
                    2,
                  )}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
