import { Check, ChevronsUpDown, Loader2, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { PageHeader } from '@/components/PageHeader'
import { SegmentedToggle } from '@/components/SegmentedToggle'
import { SkeletonCard } from '@/components/skeletons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useEventNames, useEventProperties, useTraitProperties } from '@/hooks/useTaxonomy'
import { track } from '@/lib/analytics'
import { formatNumber, formatTimestamp } from '@/lib/format'
import { resolveDateRange } from '@/lib/range'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'
import { TableEmpty, TableError, TableLoading } from '@/pages/data-management/states'

const MEMBERS_PAGE_SIZE = 50

// ── -aligned operator vocabulary ──────────────────────────────
// Mirrors segments.schema.ts's segmentOperatorSchema / FunnelBuilderPage's
// FUNNEL_OPERATORS — kept in sync by convention, not a shared import.
const SEGMENT_OPERATORS = ['exact', 'is_not', 'icontains', 'gt', 'lt', 'is_set'] as const
type SegmentOperator = (typeof SEGMENT_OPERATORS)[number]
const VALUELESS_OPERATORS: ReadonlySet<SegmentOperator> = new Set<SegmentOperator>(['is_set'])
const SEGMENT_OPERATOR_LABELS: Record<SegmentOperator, string> = {
  exact: 'equals',
  is_not: 'is not',
  icontains: 'contains',
  gt: 'greater than',
  lt: 'less than',
  is_set: 'is set',
}

type ConditionType = 'trait' | 'event_property' | 'behavioral'
const CONDITION_TYPE_LABELS: Record<ConditionType, string> = {
  trait: 'Trait',
  event_property: 'Event property',
  behavioral: 'Behavioral',
}

interface TraitConditionUI {
  type: 'trait'
  key: string
  operator: SegmentOperator
  value: string
}
interface EventPropertyConditionUI {
  type: 'event_property'
  key: string
  operator: SegmentOperator
  value: string
  event: string
}
interface BehavioralConditionUI {
  type: 'behavioral'
  event: string
  count: number
  days: number
}
type ConditionUI = TraitConditionUI | EventPropertyConditionUI | BehavioralConditionUI

/** Loose patch shape covering every condition variant's fields — merged into
 * whichever variant is currently active and re-cast, mirroring how
 * FunnelBuilderPage's FilterRow patches a single shared shape. */
interface ConditionPatch {
  key?: string
  operator?: SegmentOperator
  value?: string
  event?: string
  count?: number
  days?: number
}

// API-facing shapes (apps/api/src/trpc/routers/segments.schema.ts /
// packages/clickhouse's SegmentCondition) — value is `unknown` there but the
// builder only ever sends strings (backend coerces gt/lt to Number itself).
type ApiCondition =
  | { type: 'trait'; key: string; operator: SegmentOperator; value?: string }
  | {
      type: 'event_property'
      key: string
      operator: SegmentOperator
      value?: string
      event?: string
    }
  | { type: 'behavioral'; event: string; count: number; days: number }
interface ApiDefinition {
  version: 1
  root: { combinator: 'AND' | 'OR'; conditions: ApiCondition[] }
}

// Default 30-day range for the property-value autocomplete query — the builder
// itself has no date-range control, this just bounds the ClickHouse scan.
const AUTOCOMPLETE_RANGE = resolveDateRange('30d').range

function emptyCondition(type: ConditionType): ConditionUI {
  if (type === 'trait') return { type: 'trait', key: '', operator: 'exact', value: '' }
  if (type === 'event_property') {
    return { type: 'event_property', key: '', operator: 'exact', value: '', event: '' }
  }
  return { type: 'behavioral', event: '', count: 1, days: 30 }
}

function isConditionValid(c: ConditionUI): boolean {
  if (c.type === 'behavioral') return c.event.length > 0 && c.count > 0 && c.days > 0
  if (!c.key) return false
  return c.operator === 'is_set' || c.value.trim().length > 0
}

function toApiCondition(c: ConditionUI): ApiCondition {
  if (c.type === 'behavioral')
    return { type: 'behavioral', event: c.event, count: c.count, days: c.days }
  const includeValue = c.operator !== 'is_set'
  if (c.type === 'trait') {
    return {
      type: 'trait',
      key: c.key,
      operator: c.operator,
      ...(includeValue && { value: c.value }),
    }
  }
  return {
    type: 'event_property',
    key: c.key,
    operator: c.operator,
    ...(includeValue && { value: c.value }),
    ...(c.event && { event: c.event }),
  }
}

/** Best-effort mapping of a persisted server condition back into the UI shape.
 * Root groups only ever contain leaf conditions in v1 (nesting is deferred),
 * so any nested subgroup is dropped defensively rather than crashing the form. */
function fromApiCondition(node: unknown): ConditionUI | null {
  if (!node || typeof node !== 'object' || 'combinator' in node) return null
  const c = node as ApiCondition
  if (c.type === 'behavioral') {
    return { type: 'behavioral', event: c.event, count: c.count, days: c.days }
  }
  if (c.type === 'trait') {
    return { type: 'trait', key: c.key, operator: c.operator, value: String(c.value ?? '') }
  }
  if (c.type === 'event_property') {
    return {
      type: 'event_property',
      key: c.key,
      operator: c.operator,
      value: String(c.value ?? ''),
      event: c.event ?? '',
    }
  }
  return null
}

export function SegmentBuilderPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const { id } = useParams()
  const isEdit = !!id
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canManageProjects = can('projects:manage')

  const eventNames = useEventNames(projectId)

  const existing = trpc.segments.get.useQuery(
    { projectId: projectId as string, id: id as string },
    { enabled: !!projectId && isEdit },
  )

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [combinator, setCombinator] = useState<'AND' | 'OR'>('AND')
  const [conditions, setConditions] = useState<ConditionUI[]>([emptyCondition('trait')])
  const [error, setError] = useState('')
  const [hydrated, setHydrated] = useState(!isEdit)
  const [materializeResult, setMaterializeResult] = useState<{
    computedAt: string
    memberCount: number
  } | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: key on the segment id (not the whole existing.data object) to avoid re-triggering on refetches
  useEffect(() => {
    if (isEdit && existing.data && !hydrated) {
      const data = existing.data as unknown as {
        name: string
        description: string | null
        definition: ApiDefinition
      }
      setName(data.name)
      setDescription(data.description ?? '')
      const root = data.definition?.root
      if (root) {
        setCombinator(root.combinator)
        const loaded = (root.conditions ?? [])
          .map(fromApiCondition)
          .filter((c): c is ConditionUI => c !== null)
        setConditions(loaded.length > 0 ? loaded : [emptyCondition('trait')])
      }
      setHydrated(true)
    }
  }, [isEdit, existing.data?.id, hydrated])

  const latestSnapshot = trpc.segments.latestSnapshot.useQuery(
    { projectId: projectId as string, segmentId: id as string },
    { enabled: !!projectId && isEdit },
  )

  const create = trpc.segments.create.useMutation()
  const update = trpc.segments.update.useMutation()
  const materialize = trpc.segments.materialize.useMutation()
  const saving = create.isPending || update.isPending

  // Persisted snapshot (from the DB, seeded on mount) merged with any snapshot
  // materialized during this session — the latter always wins once present,
  // since it's guaranteed to be the newest.
  const snapshotDisplay =
    materializeResult ??
    (latestSnapshot.data
      ? {
          computedAt: latestSnapshot.data.computedAt as unknown as string,
          memberCount: latestSnapshot.data.memberCount,
        }
      : null)

  function updateConditionAt(index: number, patch: ConditionPatch) {
    setConditions((cs) => cs.map((c, i) => (i === index ? ({ ...c, ...patch } as ConditionUI) : c)))
  }
  function changeConditionType(index: number, type: ConditionType) {
    setConditions((cs) => cs.map((c, i) => (i === index ? emptyCondition(type) : c)))
  }
  function addCondition() {
    setConditions((cs) => [...cs, emptyCondition('trait')])
  }
  function removeCondition(index: number) {
    setConditions((cs) => cs.filter((_, i) => i !== index))
  }

  const validConditions = conditions.filter(isConditionValid)
  const canPreview = validConditions.length > 0

  // Debounced preview definition — mirrors FilterRow's 300ms value-autocomplete
  // debounce so the count query doesn't refire on every keystroke.
  const [debouncedDefinition, setDebouncedDefinition] = useState<ApiDefinition>({
    version: 1,
    root: { combinator, conditions: [] },
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional debounce — re-runs only when the serialized definition actually changes
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedDefinition({
        version: 1,
        root: { combinator, conditions: validConditions.map(toApiCondition) },
      })
    }, 300)
    return () => clearTimeout(t)
  }, [combinator, JSON.stringify(validConditions)])

  const preview = trpc.segments.previewCount.useQuery(
    { projectId: projectId as string, definition: debouncedDefinition },
    {
      enabled: !!projectId && debouncedDefinition.root.conditions.length > 0,
      placeholderData: (prev) => prev,
    },
  )
  const previewState = !canPreview
    ? 'idle'
    : preview.isPending
      ? 'loading'
      : preview.error
        ? 'error'
        : (preview.data?.count ?? 0) === 0
          ? 'empty'
          : 'ready'

  async function handleMaterialize() {
    if (!projectId || !id) return
    try {
      const snapshot = await materialize.mutateAsync({ projectId, id })
      setMaterializeResult({
        computedAt: snapshot.computedAt as unknown as string,
        memberCount: snapshot.memberCount,
      })
      track('segment_materialized', { segment_id: id, member_count: snapshot.memberCount })
      toast.success('Segment materialized')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to materialize segment.')
    }
  }

  async function handleSave() {
    if (!projectId || !canManageProjects) return
    if (!name.trim()) {
      setError('Segment name is required.')
      return
    }
    if (validConditions.length === 0) {
      setError('Add at least one condition with a value.')
      return
    }
    setError('')
    const definition: ApiDefinition = {
      version: 1,
      root: { combinator, conditions: validConditions.map(toApiCondition) },
    }
    try {
      if (isEdit && id) {
        await update.mutateAsync({
          projectId,
          id,
          patch: { name: name.trim(), description: description.trim() || null, definition },
        })
        // `segments.get` is cached per (projectId, id) — without busting it,
        // re-opening this same segment's edit page after a save serves the
        // pre-edit definition from cache until it happens to go stale on its
        // own, so a save-then-reopen looks like the edit was silently lost.
        await utils.segments.get.invalidate({ projectId, id })
      } else {
        const created = await create.mutateAsync({
          projectId,
          name: name.trim(),
          description: description.trim() || undefined,
          definition,
        })
        track('segment_created', {
          segment_id: created.id,
          condition_type: validConditions[0]?.type,
        })
      }
      await utils.segments.list.invalidate()
      navigate('/segments')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save segment.')
    }
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
        <PageHeader title="Edit segment" />
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
      <PageHeader title={isEdit ? 'Edit segment' : 'New segment'} subtitle={name || undefined}>
        <Button variant="outline" size="sm" onClick={() => navigate('/segments')}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving || !canManageProjects}>
          {isEdit ? 'Save changes' : 'Create segment'}
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-auto">
        <div className="p-4 md:p-6 space-y-5">
          {!canManageProjects && (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-amber-400">
              You don&apos;t have permission to edit segments. You can view this segment, but
              changes won&apos;t be saved.
            </div>
          )}

          <div>
            <label
              htmlFor="segment-name"
              className="block text-[11px] font-medium text-muted-foreground mb-1.5"
            >
              Segment name
            </label>
            <input
              id="segment-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Power users"
              className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
            />
          </div>

          <div>
            <label
              htmlFor="segment-description"
              className="block text-[11px] font-medium text-muted-foreground mb-1.5"
            >
              Description
            </label>
            <input
              id="segment-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                Conditions ({conditions.length})
              </span>
              <div className="flex items-center gap-3">
                <SegmentedToggle
                  options={
                    [
                      { label: 'AND', value: 'AND' },
                      { label: 'OR', value: 'OR' },
                    ] as const
                  }
                  value={combinator}
                  onChange={setCombinator}
                />
                <button
                  type="button"
                  onClick={addCondition}
                  className="text-[11px] text-primary hover:opacity-80 flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" />
                  Add condition
                </button>
              </div>
            </div>

            <div className="space-y-2">
              {conditions.map((condition, i) => (
                <ConditionRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: condition rows are positional
                  key={i}
                  combinatorLabel={i === 0 ? 'IF' : combinator}
                  condition={condition}
                  projectId={projectId}
                  eventOptions={eventNames.options}
                  canRemove={conditions.length > 1}
                  onTypeChange={(type) => changeConditionType(i, type)}
                  onChange={(patch) => updateConditionAt(i, patch)}
                  onRemove={() => removeCondition(i)}
                />
              ))}
            </div>
          </div>

          {error && <p className="text-[11px] text-red-400 font-medium">{error}</p>}

          <div>
            <span className="block text-[11px] font-medium text-muted-foreground mb-2">
              Preview
            </span>
            <SegmentPreview
              state={previewState}
              count={preview.data?.count ?? 0}
              scanDays={preview.data?.scanDays ?? 90}
              errorMessage={preview.error?.message}
            />
          </div>

          <div>
            <span className="block text-[11px] font-medium text-muted-foreground mb-2">
              Members
            </span>
            <SegmentMembersTable
              projectId={projectId}
              definition={debouncedDefinition}
              canPreview={canPreview}
            />
          </div>

          <div>
            <span className="block text-[11px] font-medium text-muted-foreground mb-2">
              Snapshot
            </span>
            {!isEdit ? (
              <p className="text-[11px] text-muted-foreground/70">
                Save this segment first to materialize a member snapshot.
              </p>
            ) : (
              <div className="bg-card border border-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="text-[11px] text-muted-foreground">
                  {snapshotDisplay ? (
                    <>
                      <span className="text-foreground font-medium">
                        {formatNumber(snapshotDisplay.memberCount)} members
                      </span>{' '}
                      as of {formatTimestamp(snapshotDisplay.computedAt)}
                    </>
                  ) : (
                    'No snapshot computed yet.'
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleMaterialize}
                  disabled={materialize.isPending || !canManageProjects}
                >
                  {materialize.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Materialize now
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function SegmentPreview({
  state,
  count,
  scanDays,
  errorMessage,
}: {
  state: 'idle' | 'loading' | 'error' | 'empty' | 'ready'
  count: number
  scanDays: number
  errorMessage?: string
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-5">
      {state === 'idle' ? (
        <div className="flex h-16 items-center justify-center text-sm text-muted-foreground">
          Add at least one condition with a value to preview.
        </div>
      ) : state === 'loading' ? (
        <Skeleton className="h-16 w-full" />
      ) : state === 'error' ? (
        <Alert variant="destructive">
          <AlertTitle>Failed to preview segment</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : state === 'empty' ? (
        <div className="flex h-16 items-center justify-center text-sm text-muted-foreground">
          No users match this segment (last {scanDays} days).
        </div>
      ) : (
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold text-foreground font-mono">
            ≈ {formatNumber(count)}
          </span>
          <span className="text-xs text-muted-foreground">users (last {scanDays} days)</span>
        </div>
      )}
    </div>
  )
}

/** Paginated table of matching `person_id`s for the segment currently being
 * built — reuses the same debounced definition as the preview count above it
 * (one debounce, two queries) and resets to page 1 whenever that definition
 * changes so a stale page never silently shows wrong-context rows. */
function SegmentMembersTable({
  projectId,
  definition,
  canPreview,
}: {
  projectId: string
  definition: ApiDefinition
  canPreview: boolean
}) {
  const navigate = useNavigate()
  const [page, setPage] = useState(1)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the serialized definition actually changes
  useEffect(() => {
    setPage(1)
  }, [JSON.stringify(definition)])

  const members = trpc.segments.previewMembers.useQuery(
    { projectId, definition, page, pageSize: MEMBERS_PAGE_SIZE },
    { enabled: canPreview, placeholderData: (prev) => prev },
  )

  const rows = members.data?.members ?? []
  const hasNextPage = rows.length === MEMBERS_PAGE_SIZE

  if (!canPreview) {
    return (
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <TableEmpty message="Add at least one condition with a value to preview members." />
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {members.isPending ? (
        <TableLoading />
      ) : members.error ? (
        <TableError message={members.error.message} />
      ) : rows.length === 0 ? (
        <TableEmpty message="No users match this segment." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((personId) => (
                <TableRow
                  key={personId}
                  className="cursor-pointer"
                  onClick={() => navigate(`/users/${encodeURIComponent(personId)}`)}
                >
                  <TableCell className="font-mono text-xs">{personId}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center justify-between px-4 py-2 border-t border-border">
        <span className="text-[10px] text-muted-foreground font-mono">Page {page}</span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1 || members.isLoading}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p + 1)}
            disabled={!hasNextPage || members.isLoading}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

function ConditionRow({
  combinatorLabel,
  condition,
  projectId,
  eventOptions,
  canRemove,
  onTypeChange,
  onChange,
  onRemove,
}: {
  combinatorLabel: string
  condition: ConditionUI
  projectId: string
  eventOptions: { value: string; label: string }[]
  canRemove: boolean
  onTypeChange: (type: ConditionType) => void
  onChange: (patch: ConditionPatch) => void
  onRemove: () => void
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-3">
      <span className="w-7 shrink-0 pt-1.5 font-mono text-[10px] font-medium text-amber-400">
        {combinatorLabel}
      </span>
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <Select value={condition.type} onValueChange={(v) => onTypeChange(v as ConditionType)}>
          <SelectTrigger className="h-7 w-[130px] text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(CONDITION_TYPE_LABELS) as ConditionType[]).map((t) => (
              <SelectItem key={t} value={t} className="text-xs">
                {CONDITION_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {condition.type === 'trait' && (
          <TraitFields projectId={projectId} condition={condition} onChange={onChange} />
        )}
        {condition.type === 'event_property' && (
          <EventPropertyFields
            projectId={projectId}
            condition={condition}
            eventOptions={eventOptions}
            onChange={onChange}
          />
        )}
        {condition.type === 'behavioral' && (
          <BehavioralFields condition={condition} eventOptions={eventOptions} onChange={onChange} />
        )}
      </div>
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="mt-1.5 shrink-0 text-muted-foreground/40 transition-colors hover:text-red-400"
          aria-label="Remove condition"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

function OperatorSelect({
  operator,
  onChange,
}: {
  operator: SegmentOperator
  onChange: (operator: SegmentOperator) => void
}) {
  return (
    <Select value={operator} onValueChange={(v) => onChange(v as SegmentOperator)}>
      <SelectTrigger className="h-7 w-[130px] text-[11px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SEGMENT_OPERATORS.map((op) => (
          <SelectItem key={op} value={op} className="text-xs">
            {SEGMENT_OPERATOR_LABELS[op]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Trait (person `$set` property) condition fields. No event scope; the value
 * input autocompletes off `events.traitValues` ($identify $set values), the
 * trait-condition counterpart to EventPropertyFields' propertyValues. */
function TraitFields({
  projectId,
  condition,
  onChange,
}: {
  projectId: string
  condition: TraitConditionUI
  onChange: (patch: ConditionPatch) => void
}) {
  const traits = useTraitProperties(projectId)
  const valueless = VALUELESS_OPERATORS.has(condition.operator)
  const [debouncedKey, setDebouncedKey] = useState(condition.key)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(condition.key), 300)
    return () => clearTimeout(t)
  }, [condition.key])

  const traitValues = trpc.events.traitValues.useQuery(
    { projectId, key: debouncedKey, range: AUTOCOMPLETE_RANGE },
    { enabled: !!projectId && !!debouncedKey && !valueless },
  )
  const datalistId = `segment-trait-values-${condition.key || 'k'}`

  return (
    <>
      {traits.options.length > 0 ? (
        <Select value={condition.key || undefined} onValueChange={(v) => onChange({ key: v })}>
          <SelectTrigger className="h-7 w-32 text-[11px]">
            <SelectValue placeholder="trait" />
          </SelectTrigger>
          <SelectContent>
            {traits.options.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <input
          value={condition.key}
          onChange={(e) => onChange({ key: e.target.value })}
          placeholder="trait"
          className="w-32 rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
      )}
      <OperatorSelect
        operator={condition.operator}
        onChange={(operator) => onChange({ operator })}
      />
      {!valueless && (
        <>
          <input
            value={condition.value}
            onChange={(e) => onChange({ value: e.target.value })}
            placeholder="value"
            list={datalistId}
            className="w-32 rounded bg-primary/10 px-2 py-1 font-mono text-xs text-primary placeholder:text-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          <datalist id={datalistId}>
            {(traitValues.data ?? []).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </>
      )}
    </>
  )
}

/** Event-property condition fields: an optional event scope, then the
 * existing FilterRow shape (property/operator/value with datalist
 * autocomplete once an event is picked). */
function EventPropertyFields({
  projectId,
  condition,
  eventOptions,
  onChange,
}: {
  projectId: string
  condition: EventPropertyConditionUI
  eventOptions: { value: string; label: string }[]
  onChange: (patch: ConditionPatch) => void
}) {
  const properties = useEventProperties(projectId, condition.event || undefined)
  const valueless = VALUELESS_OPERATORS.has(condition.operator)
  const [debouncedKey, setDebouncedKey] = useState(condition.key)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(condition.key), 300)
    return () => clearTimeout(t)
  }, [condition.key])

  const propertyValues = trpc.events.propertyValues.useQuery(
    { projectId, event: condition.event, key: debouncedKey, range: AUTOCOMPLETE_RANGE },
    { enabled: !!projectId && !!condition.event && !!debouncedKey && !valueless },
  )
  const datalistId = `segment-event-property-values-${condition.event || 'any'}-${condition.key || 'k'}`

  return (
    <>
      <div className="w-40">
        <EventCombobox
          value={condition.event}
          options={eventOptions}
          onChange={(event) => onChange({ event })}
          placeholder="any event"
        />
      </div>
      {properties.options.length > 0 ? (
        <Select value={condition.key || undefined} onValueChange={(v) => onChange({ key: v })}>
          <SelectTrigger className="h-7 w-32 text-[11px]">
            <SelectValue placeholder="property" />
          </SelectTrigger>
          <SelectContent>
            {properties.options.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <input
          value={condition.key}
          onChange={(e) => onChange({ key: e.target.value })}
          placeholder="property"
          className="w-32 rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
      )}
      <OperatorSelect
        operator={condition.operator}
        onChange={(operator) => onChange({ operator })}
      />
      {!valueless && (
        <>
          <input
            value={condition.value}
            onChange={(e) => onChange({ value: e.target.value })}
            placeholder="value"
            list={datalistId}
            className="w-32 rounded bg-primary/10 px-2 py-1 font-mono text-xs text-primary placeholder:text-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          <datalist id={datalistId}>
            {(propertyValues.data ?? []).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </>
      )}
    </>
  )
}

/** Behavioral condition fields: event picker + "performed ≥N times in last D
 * days" numeric inputs — a distinct row shape from the trait/event_property
 * FilterRow layout since it has no operator/value pair. */
function BehavioralFields({
  condition,
  eventOptions,
  onChange,
}: {
  condition: BehavioralConditionUI
  eventOptions: { value: string; label: string }[]
  onChange: (patch: ConditionPatch) => void
}) {
  return (
    <>
      <div className="w-40">
        <EventCombobox
          value={condition.event}
          options={eventOptions}
          onChange={(event) => onChange({ event })}
          placeholder="Select event"
        />
      </div>
      <span className="text-[11px] text-muted-foreground">≥</span>
      <input
        type="number"
        min={1}
        value={condition.count}
        onChange={(e) => onChange({ count: Math.max(1, Number(e.target.value) || 1) })}
        className="w-16 rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
      />
      <span className="text-[11px] text-muted-foreground">times in last</span>
      <input
        type="number"
        min={1}
        max={365}
        value={condition.days}
        onChange={(e) =>
          onChange({ days: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })
        }
        className="w-16 rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
      />
      <span className="text-[11px] text-muted-foreground">days</span>
    </>
  )
}

/** Small searchable single-value combobox for event pickers (Command+Popover
 * pattern, mirrors FunnelBuilderPage.tsx's local EventCombobox). */
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

export default SegmentBuilderPage
