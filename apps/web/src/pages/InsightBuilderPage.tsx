import { Check, ChevronsUpDown, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DateRange as DayRange } from 'react-day-picker'
import { useNavigate, useParams } from 'react-router'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { DateRangeControl, WindowRangeControl } from '@/components/DateRangeControl'
import InsightResultView, { type InsightResult } from '@/components/insights/InsightResultView'
import { PageHeader } from '@/components/PageHeader'
import { type PropertyFilter, PropertyFilterRow } from '@/components/PropertyFilterRow'
import { SegmentedToggle } from '@/components/SegmentedToggle'
import { SkeletonCard, SkeletonChart } from '@/components/skeletons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEventNames, useEventProperties } from '@/hooks/useTaxonomy'
import { track } from '@/lib/analytics'
import { formatNumber } from '@/lib/format'
import {
  type DateRange,
  type DateRangeSelection,
  defaultWindowRangeSelection,
  type RangeKey,
  resolveDateRange,
  resolveWindowRange,
} from '@/lib/range'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'

// ── Types mirrored from insights.schema.ts's discriminated InsightConfig ────
// (apps/api/src/trpc/routers/insights.schema.ts) — kept in sync by convention,
// not a shared import, same discipline SegmentBuilderPage/FunnelBuilderPage
// already follow for their own API-facing shapes.
type InsightType = 'trend' | 'funnel' | 'retention' | 'users' | 'breakdown'
type TrendInterval = 'hour' | 'day'
type UsersWindow = 'day' | 'week' | 'month'
type BreakdownDimension =
  | 'path'
  | 'referring_domain'
  | 'elements_chain_text'
  | 'elements_chain_href'
  | 'current_url'

const BREAKDOWN_DIMENSIONS: { value: BreakdownDimension; label: string }[] = [
  { value: 'path', label: 'Page path' },
  { value: 'referring_domain', label: 'Referring domain' },
  { value: 'current_url', label: 'Current URL' },
  { value: 'elements_chain_text', label: 'Clicked element text' },
  { value: 'elements_chain_href', label: 'Clicked element link' },
]

const INSIGHT_TYPES: { value: InsightType; label: string }[] = [
  { value: 'trend', label: 'Trend' },
  { value: 'funnel', label: 'Funnel' },
  { value: 'retention', label: 'Retention' },
  { value: 'users', label: 'Active users' },
  { value: 'breakdown', label: 'Breakdown' },
]

const FUNNEL_WINDOW_OPTIONS = [
  { value: 3600, label: '1h' },
  { value: 86400, label: '1d' },
  { value: 604800, label: '7d' },
] as const

interface FunnelStepUI {
  event: string
  alias?: string
  filters: PropertyFilter[]
}

function emptyFunnelStep(): FunnelStepUI {
  return { event: '', filters: [] }
}

interface TrendFields {
  type: 'trend'
  event: string
  interval: TrendInterval
  filters: PropertyFilter[]
}
interface UsersFields {
  type: 'users'
  window: UsersWindow
}
interface FunnelFields {
  type: 'funnel'
  steps: FunnelStepUI[]
  window: number
}
interface RetentionFields {
  type: 'retention'
  cohortWeeks: string
  host: string
}
interface BreakdownFields {
  type: 'breakdown'
  dimension: BreakdownDimension
  event: string
  limit: string
  filters: PropertyFilter[]
}
type Fields = TrendFields | UsersFields | FunnelFields | RetentionFields | BreakdownFields

function defaultFields(type: InsightType): Fields {
  switch (type) {
    case 'trend':
      return { type: 'trend', event: '', interval: 'day', filters: [] }
    case 'users':
      return { type: 'users', window: 'day' }
    case 'funnel':
      return { type: 'funnel', steps: [emptyFunnelStep(), emptyFunnelStep()], window: 86400 }
    case 'retention':
      return { type: 'retention', cohortWeeks: '', host: '' }
    case 'breakdown':
      return { type: 'breakdown', dimension: 'path', event: '', limit: '', filters: [] }
  }
}

// API-facing config shape — a loosened mirror of InsightConfigInput
// (insights.schema.ts) built client-side from `Fields` + the shared date range.
// `rangeKey` is only meaningful for the generic (non-`users`) types: when
// present the server recomputes `range` relative to "now" at query time
// instead of using the stored absolute snapshot — see insights.router.ts's
// `resolveConfigRange`. `users` configs deliberately never carry a
// `rangeKey` (a windowed DAU/WAU/MAU series uses its own window-scoped
// preset ladder, resolved client-side into an absolute `range` — see
// `resolveWindowRange`).
type ApiConfig =
  | {
      type: 'trend'
      event: string
      interval: TrendInterval
      range: DateRange
      rangeKey?: RangeKey
      filters?: PropertyFilter[]
    }
  | { type: 'users'; window: UsersWindow; range: DateRange }
  | {
      type: 'funnel'
      steps: { event: string; alias?: string; filters: PropertyFilter[] }[]
      window: number
      range: DateRange
      rangeKey?: RangeKey
    }
  | {
      type: 'retention'
      range: DateRange
      rangeKey?: RangeKey
      cohortWeeks?: number
      host?: string
    }
  | {
      type: 'breakdown'
      dimension: BreakdownDimension
      event: string
      range: DateRange
      rangeKey?: RangeKey
      limit?: number
      filters?: PropertyFilter[]
    }

/** Builds the API-facing config from the current type-specific fields + shared
 * range, or returns null if a type's required fields aren't filled in yet
 * (used both to gate Save and to gate the debounced auto-persist in edit mode).
 * `rangeSel` persists as `rangeKey` when it's a preset (not `'custom'`) —
 * ignored for `users`, whose range comes from the window-scoped control. */
function buildConfig(
  fields: Fields,
  range: DateRange,
  rangeSel: DateRangeSelection,
): ApiConfig | null {
  const rangeKey = rangeSel === 'custom' ? undefined : rangeSel
  switch (fields.type) {
    case 'trend': {
      if (!fields.event) return null
      const filters = fields.filters.filter((f) => f.key.length > 0)
      return {
        type: 'trend',
        event: fields.event,
        interval: fields.interval,
        range,
        ...(rangeKey && { rangeKey }),
        ...(filters.length > 0 && { filters }),
      }
    }
    case 'users':
      return { type: 'users', window: fields.window, range }
    case 'funnel': {
      const steps = fields.steps
        .filter((s) => s.event.length > 0)
        .map((s) => ({
          event: s.event,
          alias: s.alias?.trim() || undefined,
          filters: s.filters.filter((f) => f.key.length > 0),
        }))
      if (steps.length < 2) return null
      return { type: 'funnel', steps, window: fields.window, range, ...(rangeKey && { rangeKey }) }
    }
    case 'retention': {
      const cohortWeeks = fields.cohortWeeks.trim() ? Number(fields.cohortWeeks) : undefined
      const host = fields.host.trim() || undefined
      return {
        type: 'retention',
        range,
        ...(rangeKey && { rangeKey }),
        ...(cohortWeeks !== undefined && !Number.isNaN(cohortWeeks) && { cohortWeeks }),
        ...(host && { host }),
      }
    }
    case 'breakdown': {
      if (!fields.event) return null
      const limit = fields.limit.trim() ? Number(fields.limit) : undefined
      const filters = fields.filters.filter((f) => f.key.length > 0)
      return {
        type: 'breakdown',
        dimension: fields.dimension,
        event: fields.event,
        range,
        ...(rangeKey && { rangeKey }),
        ...(limit !== undefined && !Number.isNaN(limit) && { limit }),
        ...(filters.length > 0 && { filters }),
      }
    }
  }
}

/** Best-effort mapping from a persisted server config back into builder state
 * (fields + range selection) — mirrors SegmentBuilderPage's fromApiCondition.
 * `rangeKey`, when present on the stored config, takes precedence over the
 * absolute `range` snapshot when the caller re-hydrates range-selection
 * state (fixes reopening a saved insight always freezing to `'custom'`). */
function hydrateFromConfig(
  config: unknown,
): { type: InsightType; fields: Fields; range: DateRange; rangeKey?: RangeKey } | null {
  if (!config || typeof config !== 'object' || !('type' in config)) return null
  const c = config as Record<string, unknown>
  const range = c.range as DateRange
  const rangeKey = typeof c.rangeKey === 'string' ? (c.rangeKey as RangeKey) : undefined
  switch (c.type) {
    case 'trend':
      return {
        type: 'trend',
        fields: {
          type: 'trend',
          event: String(c.event ?? ''),
          interval: (c.interval as TrendInterval) ?? 'day',
          filters: Array.isArray(c.filters) ? (c.filters as PropertyFilter[]) : [],
        },
        range,
        rangeKey,
      }
    case 'users':
      return {
        type: 'users',
        fields: { type: 'users', window: (c.window as UsersWindow) ?? 'day' },
        range,
      }
    case 'funnel': {
      const steps = Array.isArray(c.steps)
        ? (c.steps as { event: string; alias?: string; filters?: PropertyFilter[] }[]).map((s) => ({
            event: s.event,
            alias: s.alias,
            filters: Array.isArray(s.filters) ? s.filters : [],
          }))
        : [emptyFunnelStep(), emptyFunnelStep()]
      return {
        type: 'funnel',
        fields: {
          type: 'funnel',
          steps: steps.length > 0 ? steps : [emptyFunnelStep(), emptyFunnelStep()],
          window: typeof c.window === 'number' ? c.window : 86400,
        },
        range,
        rangeKey,
      }
    }
    case 'retention':
      return {
        type: 'retention',
        fields: {
          type: 'retention',
          cohortWeeks: c.cohortWeeks != null ? String(c.cohortWeeks) : '',
          host: typeof c.host === 'string' ? c.host : '',
        },
        range,
        rangeKey,
      }
    case 'breakdown':
      return {
        type: 'breakdown',
        fields: {
          type: 'breakdown',
          dimension: (c.dimension as BreakdownDimension) ?? 'path',
          event: String(c.event ?? ''),
          limit: c.limit != null ? String(c.limit) : '',
          filters: Array.isArray(c.filters) ? (c.filters as PropertyFilter[]) : [],
        },
        range,
        rangeKey,
      }
    default:
      return null
  }
}

export function InsightBuilderPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const { id } = useParams()
  const isEdit = !!id
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canManageProjects = can('projects:manage')

  const eventNames = useEventNames(projectId)

  const existing = trpc.insights.get.useQuery(
    { projectId: projectId as string, id: id as string },
    { enabled: !!projectId && isEdit },
  )

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [type, setType] = useState<InsightType>('trend')
  const [fields, setFields] = useState<Fields>(defaultFields('trend'))
  const [rangeSel, setRangeSel] = useState<DateRangeSelection>('30d')
  const [customRange, setCustomRange] = useState<DayRange | undefined>(undefined)
  // Window-scoped range selection for `users` (DAU/WAU/MAU) insights — the
  // generic 24h/7d/14d/30d ladder above isn't meaningful for a windowed
  // series, so this tracks a separate preset key from `windowRangeOptions`.
  const [usersRangeSel, setUsersRangeSel] = useState<string>(() =>
    defaultWindowRangeSelection('day'),
  )
  const [error, setError] = useState('')
  const [hydrated, setHydrated] = useState(!isEdit)

  // biome-ignore lint/correctness/useExhaustiveDependencies: key on the insight id (not the whole existing.data object) to avoid re-triggering on refetches
  useEffect(() => {
    if (isEdit && existing.data && !hydrated) {
      const data = existing.data as unknown as {
        name: string
        description: string | null
        tags: string[]
        config: unknown
      }
      setName(data.name)
      setDescription(data.description ?? '')
      setTags(data.tags ?? [])
      const loaded = hydrateFromConfig(data.config)
      if (loaded) {
        setType(loaded.type)
        setFields(loaded.fields)
        if (loaded.type === 'users') {
          setUsersRangeSel(defaultWindowRangeSelection((loaded.fields as UsersFields).window))
        } else if (loaded.rangeKey) {
          setRangeSel(loaded.rangeKey)
        } else if (loaded.range?.from && loaded.range?.to) {
          setRangeSel('custom')
          setCustomRange({ from: new Date(loaded.range.from), to: new Date(loaded.range.to) })
        }
      }
      setHydrated(true)
    }
  }, [isEdit, existing.data?.id, hydrated])

  function changeType(next: InsightType) {
    setType(next)
    const next_ = defaultFields(next)
    setFields(next_)
    if (next_.type === 'users') setUsersRangeSel(defaultWindowRangeSelection(next_.window))
  }

  // Re-scope the window-range preset whenever the `users` insight's bucket
  // window changes (day/week/month) — a preset picked for DAU wouldn't be
  // valid for MAU (`windowRangeOptions` differs per window).
  const usersWindow = fields.type === 'users' ? fields.window : undefined
  useEffect(() => {
    if (usersWindow) setUsersRangeSel(defaultWindowRangeSelection(usersWindow))
  }, [usersWindow])

  const create = trpc.insights.create.useMutation()
  const update = trpc.insights.update.useMutation()
  const saving = create.isPending || update.isPending

  const isUsersType = fields.type === 'users'
  const range = isUsersType
    ? resolveWindowRange(fields.window, usersRangeSel)
    : resolveDateRange(rangeSel, customRange).range

  // Debounced config — mirrors SegmentBuilderPage's 300ms debounce so a saved
  // insight isn't re-persisted on every keystroke.
  const [debouncedConfig, setDebouncedConfig] = useState<ApiConfig | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional debounce — re-runs only when the serialized fields/range actually change
  useEffect(() => {
    const t = setTimeout(() => setDebouncedConfig(buildConfig(fields, range, rangeSel)), 400)
    return () => clearTimeout(t)
  }, [JSON.stringify(fields), rangeSel, JSON.stringify(customRange), usersRangeSel])

  // Live preview: computed directly from the in-progress (unsaved) config via
  // `previewResults` — mirrors FunnelBuilderPage's `events.funnel` query, which
  // also takes an inline config rather than a saved record's id. Works in both
  // create and edit mode, and needs no auto-save side effect.
  const results = trpc.insights.previewResults.useQuery(
    { projectId: projectId as string, config: debouncedConfig as NonNullable<ApiConfig> },
    {
      enabled: !!projectId && !!debouncedConfig && hydrated,
      placeholderData: (prev) => prev,
    },
  )

  async function handleSave() {
    if (!projectId || !canManageProjects) return
    if (!name.trim()) {
      setError('Insight name is required.')
      return
    }
    const config = buildConfig(fields, range, rangeSel)
    if (!config) {
      setError('Complete the required fields for this insight type.')
      return
    }
    setError('')
    try {
      if (isEdit && id) {
        await update.mutateAsync({
          projectId,
          id,
          patch: {
            name: name.trim(),
            description: description.trim() || null,
            tags,
            config: config,
          },
        })
        await utils.insights.get.invalidate({ projectId, id })
        await utils.insights.list.invalidate()
        navigate(`/insights/${id}`)
      } else {
        const created = await create.mutateAsync({
          projectId,
          name: name.trim(),
          description: description.trim() || undefined,
          tags,
          config: config,
        })
        track('insight_created', { insight_type: config.type })
        await utils.insights.list.invalidate()
        navigate(`/insights/${(created as unknown as { id: string }).id}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save insight.')
    }
  }

  function addTag() {
    const t = tagInput.trim()
    if (t && !tags.includes(t)) setTags((ts) => [...ts, t])
    setTagInput('')
  }
  function removeTag(t: string) {
    setTags((ts) => ts.filter((x) => x !== t))
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No project selected.
      </div>
    )
  }

  if (isEdit && existing.isPending) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <PageHeader title="Edit insight" />
        <div className="flex-1 overflow-auto">
          <div className="p-4 md:p-6 space-y-5">
            <SkeletonCard lines={2} />
            <SkeletonCard lines={5} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title={isEdit ? 'Edit insight' : 'New insight'} subtitle={name || undefined}>
        <Button variant="outline" size="sm" onClick={() => navigate('/insights')}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving || !canManageProjects}>
          {isEdit ? 'Save changes' : 'Create insight'}
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-auto">
        <div className="p-4 md:p-6 space-y-5">
          {!canManageProjects && (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-amber-400">
              You don&apos;t have permission to edit insights. You can view this insight, but
              changes won&apos;t be saved.
            </div>
          )}

          {/* ── Two-pane layout: config | preview. Stacks to a single column
              below md per CLAUDE.md's responsiveness rules. ── */}
          <div className="flex flex-col md:flex-row gap-5">
            {/* Config pane */}
            <div className="flex-1 min-w-0 space-y-5">
              <div>
                <label
                  htmlFor="insight-name"
                  className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                >
                  Insight name
                </label>
                <input
                  id="insight-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Weekly active users"
                  className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
                />
              </div>

              <div>
                <label
                  htmlFor="insight-description"
                  className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                >
                  Description
                </label>
                <input
                  id="insight-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional"
                  className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
                />
              </div>

              <div>
                <span className="block text-[11px] font-medium text-muted-foreground mb-1.5">
                  Tags
                </span>
                <div className="flex flex-wrap items-center gap-1.5 mb-2">
                  {tags.map((t) => (
                    <Badge key={t} variant="secondary" className="gap-1 text-[10px]">
                      {t}
                      <button type="button" onClick={() => removeTag(t)} aria-label={`Remove ${t}`}>
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </Badge>
                  ))}
                </div>
                <input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault()
                      addTag()
                    }
                  }}
                  onBlur={addTag}
                  placeholder="Add a tag and press Enter"
                  className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
                />
              </div>

              <div>
                <span className="block text-[11px] font-medium text-muted-foreground mb-2">
                  Type
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {INSIGHT_TYPES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => changeType(t.value)}
                      className={cn(
                        'rounded-md border px-3 py-2 text-xs font-medium transition-colors text-left',
                        type === t.value
                          ? 'border-primary/40 bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:text-foreground hover:border-border/80',
                      )}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="block text-[11px] font-medium text-muted-foreground mb-2">
                  Date range
                </span>
                {fields.type === 'users' ? (
                  <WindowRangeControl
                    window={fields.window}
                    selection={usersRangeSel}
                    onSelectionChange={setUsersRangeSel}
                  />
                ) : (
                  <DateRangeControl
                    selection={rangeSel}
                    onSelectionChange={setRangeSel}
                    customRange={customRange}
                    onCustomRangeChange={setCustomRange}
                  />
                )}
              </div>

              <TypeConfigFields
                fields={fields}
                setFields={setFields}
                eventOptions={eventNames.options}
                projectId={projectId}
              />

              {error && <p className="text-[11px] text-red-400 font-medium">{error}</p>}
            </div>

            {/* Preview pane */}
            <div className="flex-1 min-w-0">
              <span className="block text-[11px] font-medium text-muted-foreground mb-2">
                Preview
              </span>
              <InsightPreview hasConfig={!!debouncedConfig} results={results} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function TypeConfigFields({
  fields,
  setFields,
  eventOptions,
  projectId,
}: {
  fields: Fields
  setFields: (f: Fields) => void
  eventOptions: { value: string; label: string }[]
  projectId: string
}) {
  if (fields.type === 'trend') {
    return (
      <div className="space-y-3">
        <div>
          <span className="block text-[11px] font-medium text-muted-foreground mb-1.5">Event</span>
          <EventCombobox
            value={fields.event}
            options={eventOptions}
            onChange={(event) => setFields({ ...fields, event })}
            placeholder="Select event"
          />
        </div>
        <div>
          <span className="block text-[11px] font-medium text-muted-foreground mb-2">Interval</span>
          <SegmentedToggle
            options={
              [
                { label: 'Hourly', value: 'hour' },
                { label: 'Daily', value: 'day' },
              ] as const
            }
            value={fields.interval}
            onChange={(interval) => setFields({ ...fields, interval })}
          />
        </div>
        <FilterSection
          projectId={projectId}
          event={fields.event}
          filters={fields.filters}
          onChange={(filters) => setFields({ ...fields, filters })}
        />
      </div>
    )
  }

  if (fields.type === 'users') {
    return (
      <div>
        <span className="block text-[11px] font-medium text-muted-foreground mb-2">Window</span>
        <SegmentedToggle
          options={
            [
              { label: 'Day (DAU)', value: 'day' },
              { label: 'Week (WAU)', value: 'week' },
              { label: 'Month (MAU)', value: 'month' },
            ] as const
          }
          value={fields.window}
          onChange={(window) => setFields({ ...fields, window })}
        />
      </div>
    )
  }

  if (fields.type === 'funnel') {
    function updateStep(i: number, patch: Partial<FunnelStepUI>) {
      if (fields.type !== 'funnel') return
      setFields({
        ...fields,
        steps: fields.steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
      })
    }
    function addStep() {
      if (fields.type !== 'funnel' || fields.steps.length >= 8) return
      setFields({ ...fields, steps: [...fields.steps, emptyFunnelStep()] })
    }
    function removeStep(i: number) {
      if (fields.type !== 'funnel') return
      setFields({ ...fields, steps: fields.steps.filter((_, idx) => idx !== i) })
    }

    return (
      <div className="space-y-3">
        <div>
          <span className="block text-[11px] font-medium text-muted-foreground mb-2">
            Conversion window
          </span>
          <SegmentedToggle
            options={FUNNEL_WINDOW_OPTIONS}
            value={fields.window}
            onChange={(window) => setFields({ ...fields, window })}
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-muted-foreground">
              Steps ({fields.steps.length})
            </span>
            <button
              type="button"
              onClick={addStep}
              disabled={fields.steps.length >= 8}
              className="text-[11px] text-primary hover:opacity-80 flex items-center gap-1 disabled:opacity-40"
            >
              <Plus className="w-3 h-3" />
              Add step
            </button>
          </div>
          <div className="space-y-2">
            {fields.steps.map((step, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional
                key={i}
                className="rounded-lg border border-border bg-card p-2.5 space-y-2"
              >
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-primary/15 flex items-center justify-center text-[9px] font-bold text-primary shrink-0">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <EventCombobox
                      value={step.event}
                      options={eventOptions}
                      onChange={(event) => updateStep(i, { event })}
                      placeholder="Select event"
                    />
                  </div>
                  {fields.steps.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removeStep(i)}
                      className="text-muted-foreground/40 hover:text-red-400 transition-colors shrink-0"
                      aria-label="Remove step"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="pl-7">
                  <FilterSection
                    projectId={projectId}
                    event={step.event}
                    filters={step.filters}
                    onChange={(filters) => updateStep(i, { filters })}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (fields.type === 'retention') {
    return (
      <div className="space-y-3">
        <div>
          <label
            htmlFor="retention-cohort-weeks"
            className="block text-[11px] font-medium text-muted-foreground mb-1.5"
          >
            Cohort weeks (optional)
          </label>
          <input
            id="retention-cohort-weeks"
            type="number"
            min={1}
            max={52}
            value={fields.cohortWeeks}
            onChange={(e) => setFields({ ...fields, cohortWeeks: e.target.value })}
            placeholder="8"
            className="w-32 bg-muted/30 border border-border rounded-md text-xs px-3 py-2 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
          />
        </div>
        <div>
          <label
            htmlFor="retention-host"
            className="block text-[11px] font-medium text-muted-foreground mb-1.5"
          >
            Host filter (optional)
          </label>
          <input
            id="retention-host"
            value={fields.host}
            onChange={(e) => setFields({ ...fields, host: e.target.value })}
            placeholder="e.g. app.example.com"
            className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
          />
        </div>
      </div>
    )
  }

  // breakdown
  return (
    <div className="space-y-3">
      <div>
        <span className="block text-[11px] font-medium text-muted-foreground mb-1.5">
          Dimension
        </span>
        <Select
          value={fields.dimension}
          onValueChange={(v) => setFields({ ...fields, dimension: v as BreakdownDimension })}
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BREAKDOWN_DIMENSIONS.map((d) => (
              <SelectItem key={d.value} value={d.value} className="text-xs">
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <span className="block text-[11px] font-medium text-muted-foreground mb-1.5">Event</span>
        <EventCombobox
          value={fields.event}
          options={eventOptions}
          onChange={(event) => setFields({ ...fields, event })}
          placeholder="Select event"
        />
      </div>
      <div>
        <label
          htmlFor="breakdown-limit"
          className="block text-[11px] font-medium text-muted-foreground mb-1.5"
        >
          Row limit (optional)
        </label>
        <input
          id="breakdown-limit"
          type="number"
          min={1}
          max={100}
          value={fields.limit}
          onChange={(e) => setFields({ ...fields, limit: e.target.value })}
          placeholder="20"
          className="w-32 bg-muted/30 border border-border rounded-md text-xs px-3 py-2 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
        />
      </div>
      <FilterSection
        projectId={projectId}
        event={fields.event}
        filters={fields.filters}
        onChange={(filters) => setFields({ ...fields, filters })}
      />
    </div>
  )
}

/** Optional event-property filter list, scoped to a single event — shared UX
 * with FunnelBuilderPage's per-step filters via the common PropertyFilterRow.
 * Used for trend/breakdown's single event and (per-step) funnel steps. */
function FilterSection({
  projectId,
  event,
  filters,
  onChange,
}: {
  projectId: string
  event: string
  filters: PropertyFilter[]
  onChange: (filters: PropertyFilter[]) => void
}) {
  const properties = useEventProperties(projectId, event || undefined)

  function addFilter() {
    onChange([...filters, { key: '', operator: 'exact', value: '' }])
  }
  function updateFilter(index: number, patch: Partial<PropertyFilter>) {
    onChange(filters.map((f, i) => (i === index ? { ...f, ...patch } : f)))
  }
  function removeFilter(index: number) {
    onChange(filters.filter((_, i) => i !== index))
  }

  return (
    <div>
      {filters.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {filters.map((filter, fi) => (
            <PropertyFilterRow
              // biome-ignore lint/suspicious/noArrayIndexKey: filter rows are positional
              key={fi}
              index={fi}
              filter={filter}
              projectId={projectId}
              event={event}
              propertyOptions={properties.options}
              onChange={(patch) => updateFilter(fi, patch)}
              onRemove={() => removeFilter(fi)}
              datalistIdPrefix="insight-filter-values"
            />
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={addFilter}
        disabled={!event}
        className="text-[11px] text-primary hover:opacity-80 flex items-center gap-1 disabled:opacity-40"
      >
        <Plus className="w-3 h-3" />
        Add condition
      </button>
    </div>
  )
}

type InsightResultsData =
  | { type: 'trend'; series: { bucket: string; value: number }[] }
  | { type: 'users'; window: UsersWindow; series: { bucket: string; value: number }[] }
  | {
      type: 'funnel'
      steps: { step: number; label: string; alias?: string; count: number; conversionPct: number }[]
      medianMs: number
    }
  | { type: 'retention'; cohorts: { cohortWeek: string; size: number; retention: number[] }[] }
  | { type: 'breakdown'; rows: { value: string; count: number }[] }

/** Live preview pane, computed from the in-progress config via
 * `insights.previewResults` — updates as the user edits, before any save. */
function InsightPreview({
  hasConfig,
  results,
}: {
  hasConfig: boolean
  results: {
    data?: unknown
    isLoading: boolean
    error?: { message: string } | null
  }
}) {
  if (!hasConfig) {
    return (
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex h-32 items-center justify-center text-center text-sm text-muted-foreground px-4">
          Complete the required fields for this insight type to see a live preview.
        </div>
      </div>
    )
  }

  if (results.isLoading && !results.data) {
    return (
      <div className="bg-card border border-border rounded-xl p-5">
        <SkeletonChart height={160} />
      </div>
    )
  }

  if (results.error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Failed to compute preview</AlertTitle>
        <AlertDescription>{results.error.message}</AlertDescription>
      </Alert>
    )
  }

  const data = results.data as InsightResultsData | undefined
  if (!data) {
    return (
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
          No results yet.
        </div>
      </div>
    )
  }

  if (data.type === 'trend') {
    return (
      <div className="bg-card border border-border rounded-xl p-5">
        {data.series.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            No events in this range.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={data.series} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="insightTrendGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#2DD4BF" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#2DD4BF" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis
                dataKey="bucket"
                tick={{ fontSize: 10, fill: '#6B6B8A' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: string) =>
                  new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                }
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#6B6B8A' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => formatNumber(v)}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload as { bucket: string; value: number }
                  return (
                    <div className="bg-popover border border-border rounded-lg px-3 py-2 shadow-xl text-xs">
                      <div className="text-muted-foreground">
                        {new Date(d.bucket).toLocaleString()}
                      </div>
                      <div className="font-mono text-foreground font-semibold">
                        {formatNumber(d.value)}
                      </div>
                    </div>
                  )
                }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="#2DD4BF"
                strokeWidth={2}
                fill="url(#insightTrendGrad)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    )
  }

  if (data.type === 'users') {
    return <InsightResultView result={data as InsightResult} />
  }

  if (data.type === 'funnel') {
    const entered = data.steps[0]?.count ?? 0
    const chartData = data.steps.map((s) => ({
      name: s.alias || s.label,
      users: s.count,
      rest: Math.max(0, entered - s.count),
      pct: s.conversionPct,
    }))
    return (
      <div className="space-y-3">
        <div className="bg-card border border-border rounded-xl p-5">
          {data.steps.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              No funnel data for this range.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(120, chartData.length * 48)}>
              <BarChart
                layout="vertical"
                data={chartData}
                margin={{ top: 0, right: 48, left: 0, bottom: 0 }}
                barSize={28}
              >
                <XAxis type="number" domain={[0, entered]} hide />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={130}
                  tick={{ fontSize: 11, fill: '#E2E2EE' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    const d = payload[0].payload as (typeof chartData)[number]
                    return (
                      <div className="bg-popover border border-border rounded-lg px-3 py-2 shadow-xl text-xs space-y-0.5">
                        <div className="font-medium text-foreground">{d.name}</div>
                        <div className="font-mono text-muted-foreground">
                          {formatNumber(d.users)} users
                        </div>
                        <div className="font-mono text-primary">{d.pct}%</div>
                      </div>
                    )
                  }}
                />
                <Bar dataKey="users" stackId="a" radius={[3, 0, 0, 3]}>
                  {chartData.map((d, i) => (
                    <Cell key={d.name} fill="#2DD4BF" fillOpacity={1 - i * 0.12} />
                  ))}
                </Bar>
                <Bar
                  dataKey="rest"
                  stackId="a"
                  fill="rgba(255,255,255,0.05)"
                  radius={[0, 3, 3, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground">
          Median time to convert: {Math.round(data.medianMs / 1000)}s
        </div>
      </div>
    )
  }

  if (data.type === 'retention') {
    return (
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        {data.cohorts.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            No cohorts in this range.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/10">
                  <th className="text-left px-4 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Cohort
                  </th>
                  <th className="text-left px-4 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Size
                  </th>
                  {data.cohorts[0]?.retention.map((_, i) => (
                    <th
                      // biome-ignore lint/suspicious/noArrayIndexKey: week-offset columns are positional
                      key={i}
                      className="text-left px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider"
                    >
                      W{i}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.cohorts.map((c) => (
                  <tr key={c.cohortWeek} className="border-b border-border/50">
                    <td className="px-4 py-2 font-mono text-foreground">{c.cohortWeek}</td>
                    <td className="px-4 py-2 font-mono text-muted-foreground">
                      {formatNumber(c.size)}
                    </td>
                    {c.retention.map((r, i) => (
                      <td
                        // biome-ignore lint/suspicious/noArrayIndexKey: week-offset cells are positional
                        key={i}
                        className="px-3 py-2 font-mono"
                        style={{ color: `rgba(45, 212, 191, ${Math.max(0.25, r)})` }}
                      >
                        {Math.round(r * 100)}%
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  // breakdown
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {data.rows.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
          No data for this range.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/10">
                <th className="text-left px-4 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Value
                </th>
                <th className="text-left px-4 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Count
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.value} className="border-b border-border/50">
                  <td className="px-4 py-2 text-foreground truncate max-w-[240px]">{r.value}</td>
                  <td className="px-4 py-2 font-mono text-muted-foreground">
                    {formatNumber(r.count)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Small searchable single-value combobox for event pickers (Command+Popover
 * pattern, mirrors SegmentBuilderPage/FunnelBuilderPage's local EventCombobox). */
function EventCombobox({
  value,
  options,
  onChange,
  placeholder,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  const label = options.find((o) => o.value === value)?.label ?? value

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="w-full flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-foreground hover:bg-muted/40 transition-colors"
        >
          <span className={cn('truncate', !value && 'text-muted-foreground/60')}>
            {value ? label : placeholder}
          </span>
          <ChevronsUpDown className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Search events..." />
          <CommandList>
            <CommandEmpty>No matching events.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-3.5 w-3.5',
                      value === o.value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  {o.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export default InsightBuilderPage
