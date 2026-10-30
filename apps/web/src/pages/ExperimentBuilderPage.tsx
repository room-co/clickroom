import { Check, ChevronsUpDown, Plus, Rocket, RotateCcw, Square, TrendingUp, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { PageHeader } from '@/components/PageHeader'
import { SegmentedToggle } from '@/components/SegmentedToggle'
import { SkeletonCard } from '@/components/skeletons'
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
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'
import { defaultEnvKey, type FlagEnv, useEnvironments } from './flags/types'

type ExperimentStatus = 'draft' | 'running' | 'complete' | 'archived'

// Same operator vocabulary as FunnelBuilderPage/SegmentBuilderPage
// (funnelStepSchema / experimentFunnelStepConditionSchema) — kept in sync by
// convention, not a shared import.
const METRIC_OPERATORS = ['exact', 'is_not', 'icontains', 'gt', 'lt', 'is_set'] as const
type MetricOperator = (typeof METRIC_OPERATORS)[number]
const VALUELESS_OPERATORS: ReadonlySet<MetricOperator> = new Set<MetricOperator>(['is_set'])
const METRIC_OPERATOR_LABELS: Record<MetricOperator, string> = {
  exact: 'equals',
  is_not: 'is not',
  icontains: 'contains',
  gt: 'greater than',
  lt: 'less than',
  is_set: 'is set',
}

const WINDOW_OPTIONS = [
  { value: 3600, label: '1h' },
  { value: 86400, label: '1d' },
  { value: 604800, label: '7d' },
] as const

const METRIC_TYPE_LABELS = {
  funnel: 'Funnel',
  mean: 'Mean',
  ratio: 'Ratio',
  retention: 'Retention',
} as const
type MetricType = keyof typeof METRIC_TYPE_LABELS

// ── UI-local metric shapes (mirrors experiments.schema.ts's ExperimentMetric
// discriminated union — apps/web has no dependency on @clickroom/clickhouse
// or apps/api's zod schema, same posture as FunnelBuilderPage's local types) ─

interface MetricStepCondition {
  key: string
  operator: MetricOperator
  value: string
}
interface MetricFunnelStep {
  event: string
  properties: MetricStepCondition[]
}
interface FunnelMetricUI {
  type: 'funnel'
  steps: MetricFunnelStep[]
  window: number
}
interface MeanMetricUI {
  type: 'mean'
  event: string
  property: string
}
interface RatioMetricUI {
  type: 'ratio'
  numeratorEvent: string
  denominatorEvent: string
}
interface RetentionMetricUI {
  type: 'retention'
  returnEvent: string
  days: number
}
type MetricUI = FunnelMetricUI | MeanMetricUI | RatioMetricUI | RetentionMetricUI

interface VariantUI {
  key: string
  rolloutPercentage: number
}

// Server-facing shapes (experiments.schema.ts's experimentMetricSchema) —
// value is a plain string here since the builder only ever sends strings
// (mirrors SegmentBuilderPage's ApiCondition posture).
type ApiMetricStepCondition = { key: string; operator: MetricOperator; value?: string }
type ApiMetric =
  | {
      type: 'funnel'
      steps: { event: string; properties?: ApiMetricStepCondition[] }[]
      window: number
    }
  | { type: 'mean'; event: string; property: string }
  | { type: 'ratio'; numeratorEvent: string; denominatorEvent: string }
  | { type: 'retention'; returnEvent: string; days: number }

const VARIANT_COLORS = ['bg-primary', 'bg-purple-400', 'bg-teal-400', 'bg-amber-400', 'bg-pink-400']

function emptyVariants(): VariantUI[] {
  return [
    { key: 'control', rolloutPercentage: 50 },
    { key: 'test', rolloutPercentage: 50 },
  ]
}

function emptyMetric(type: MetricType): MetricUI {
  if (type === 'funnel') {
    return {
      type: 'funnel',
      steps: [
        { event: '', properties: [] },
        { event: '', properties: [] },
      ],
      window: 86400,
    }
  }
  if (type === 'mean') return { type: 'mean', event: '', property: '' }
  if (type === 'ratio') return { type: 'ratio', numeratorEvent: '', denominatorEvent: '' }
  return { type: 'retention', returnEvent: '', days: 7 }
}

function isMetricValid(m: MetricUI): boolean {
  if (m.type === 'funnel') return m.steps.filter((s) => s.event.length > 0).length >= 2
  if (m.type === 'mean') return m.event.length > 0 && m.property.length > 0
  if (m.type === 'ratio') return m.numeratorEvent.length > 0 && m.denominatorEvent.length > 0
  return m.returnEvent.length > 0 && m.days > 0
}

function toApiMetric(m: MetricUI): ApiMetric {
  if (m.type === 'funnel') {
    return {
      type: 'funnel',
      steps: m.steps
        .filter((s) => s.event.length > 0)
        .map((s) => ({
          event: s.event,
          properties: s.properties
            .filter((p) => p.key.length > 0)
            .map((p) =>
              p.operator === 'is_set'
                ? { key: p.key, operator: p.operator }
                : { key: p.key, operator: p.operator, value: p.value },
            ),
        })),
      window: m.window,
    }
  }
  if (m.type === 'mean') return { type: 'mean', event: m.event, property: m.property }
  if (m.type === 'ratio') {
    return { type: 'ratio', numeratorEvent: m.numeratorEvent, denominatorEvent: m.denominatorEvent }
  }
  return { type: 'retention', returnEvent: m.returnEvent, days: m.days }
}

/** Best-effort mapping of a persisted server metric back into the UI shape —
 * defensive against unexpected fields, mirrors SegmentBuilderPage's
 * fromApiCondition. */
function fromApiMetric(node: unknown): MetricUI {
  const m = node as ApiMetric
  if (m?.type === 'funnel') {
    return {
      type: 'funnel',
      steps: (m.steps ?? []).map((s) => ({
        event: s.event,
        properties: (s.properties ?? []).map((p) => ({
          key: p.key,
          operator: p.operator,
          value: String(p.value ?? ''),
        })),
      })),
      window: m.window ?? 86400,
    }
  }
  if (m?.type === 'mean') return { type: 'mean', event: m.event, property: m.property }
  if (m?.type === 'ratio') {
    return { type: 'ratio', numeratorEvent: m.numeratorEvent, denominatorEvent: m.denominatorEvent }
  }
  if (m?.type === 'retention')
    return { type: 'retention', returnEvent: m.returnEvent, days: m.days }
  return emptyMetric('funnel')
}

export function ExperimentBuilderPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const { id } = useParams()
  const isEdit = !!id
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canManageProjects = can('projects:manage')

  const eventNames = useEventNames(projectId)

  const existing = trpc.experiments.get.useQuery(
    { projectId: projectId as string, id: id as string },
    { enabled: !!projectId && isEdit },
  )

  const [name, setName] = useState('')
  const [hypothesis, setHypothesis] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<ExperimentStatus>('draft')
  const [variants, setVariants] = useState<VariantUI[]>(emptyVariants())
  const [primaryMetric, setPrimaryMetric] = useState<MetricUI>(emptyMetric('funnel'))
  const [secondaryMetrics, setSecondaryMetrics] = useState<MetricUI[]>([])
  const [error, setError] = useState('')
  const [hydrated, setHydrated] = useState(!isEdit)

  const environmentsQuery = useEnvironments(projectId)
  const environments = useMemo(() => environmentsQuery.data ?? [], [environmentsQuery.data])
  const [env, setEnv] = useState<FlagEnv>('')

  // No env picked yet (e.g. environments haven't resolved on first render) —
  // fall back to the project's default env once they load, same pattern as
  // NewFlagDialog.
  useEffect(() => {
    if (!env) {
      const fallback = defaultEnvKey(environments)
      if (fallback) setEnv(fallback)
    }
  }, [env, environments])

  // biome-ignore lint/correctness/useExhaustiveDependencies: key on the experiment id (not the whole existing.data object) to avoid re-triggering on refetches
  useEffect(() => {
    if (isEdit && existing.data && !hydrated) {
      const data = existing.data as unknown as {
        name: string
        hypothesis: string | null
        description: string | null
        status: ExperimentStatus
        variants: VariantUI[]
        primaryMetric: unknown
        secondaryMetrics: unknown[]
      }
      setName(data.name)
      setHypothesis(data.hypothesis ?? '')
      setDescription(data.description ?? '')
      setStatus(data.status)
      setVariants(data.variants?.length > 0 ? data.variants : emptyVariants())
      setPrimaryMetric(fromApiMetric(data.primaryMetric))
      setSecondaryMetrics((data.secondaryMetrics ?? []).map(fromApiMetric))
      setHydrated(true)
    }
  }, [isEdit, existing.data?.id, hydrated])

  const create = trpc.experiments.create.useMutation()
  const update = trpc.experiments.update.useMutation()
  const launch = trpc.experiments.launch.useMutation()
  const stop = trpc.experiments.stop.useMutation()
  const saving = create.isPending || update.isPending

  const variantsLocked = isEdit && status !== 'draft'

  function addVariant() {
    setVariants((vs) => [...vs, { key: '', rolloutPercentage: 0 }])
  }
  function updateVariant(index: number, patch: Partial<VariantUI>) {
    setVariants((vs) => vs.map((v, i) => (i === index ? { ...v, ...patch } : v)))
  }
  function removeVariant(index: number) {
    setVariants((vs) => vs.filter((_, i) => i !== index))
  }

  function addSecondaryMetric() {
    setSecondaryMetrics((ms) => [...ms, emptyMetric('funnel')])
  }
  function updateSecondaryMetric(index: number, metric: MetricUI) {
    setSecondaryMetrics((ms) => ms.map((m, i) => (i === index ? metric : m)))
  }
  function removeSecondaryMetric(index: number) {
    setSecondaryMetrics((ms) => ms.filter((_, i) => i !== index))
  }

  const validVariants = variants.filter((v) => v.key.trim().length > 0)

  async function handleSave() {
    if (!projectId || !canManageProjects) return
    if (!name.trim()) {
      setError('Experiment name is required.')
      return
    }
    if (validVariants.length < 2) {
      setError('Add at least 2 variants with a key.')
      return
    }
    if (!isMetricValid(primaryMetric)) {
      setError('The primary metric is incomplete.')
      return
    }
    const invalidSecondary = secondaryMetrics.find((m) => !isMetricValid(m))
    if (invalidSecondary) {
      setError('One of the secondary metrics is incomplete.')
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
            hypothesis: hypothesis.trim() || null,
            ...(!variantsLocked && {
              variants: validVariants.map((v) => ({
                key: v.key.trim(),
                rolloutPercentage: v.rolloutPercentage,
              })),
            }),
            primaryMetric: toApiMetric(primaryMetric),
            secondaryMetrics: secondaryMetrics.map(toApiMetric),
          },
        })
        await utils.experiments.get.invalidate({ projectId, id })
      } else {
        const created = await create.mutateAsync({
          projectId,
          name: name.trim(),
          description: description.trim() || undefined,
          hypothesis: hypothesis.trim() || undefined,
          variants: validVariants.map((v) => ({
            key: v.key.trim(),
            rolloutPercentage: v.rolloutPercentage,
          })),
          primaryMetric: toApiMetric(primaryMetric),
          secondaryMetrics: secondaryMetrics.map(toApiMetric),
          env: env || undefined,
        })
        track('experiment_created', {
          experiment_id: created.id,
          metric_type: primaryMetric.type,
        })
      }
      await utils.experiments.list.invalidate()
      navigate('/experiments')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save experiment.')
    }
  }

  async function handleLaunch() {
    if (!projectId || !id) return
    try {
      const result = await launch.mutateAsync({ projectId, id })
      setStatus(result.status as ExperimentStatus)
      track('experiment_launched', { experiment_id: id })
      await utils.experiments.get.invalidate({ projectId, id })
      await utils.experiments.list.invalidate()
      toast.success('Experiment launched')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to launch experiment.')
    }
  }

  async function handleStop() {
    if (!projectId || !id) return
    try {
      const result = await stop.mutateAsync({ projectId, id })
      setStatus(result.status as ExperimentStatus)
      track('experiment_stopped', { experiment_id: id })
      await utils.experiments.get.invalidate({ projectId, id })
      await utils.experiments.list.invalidate()
      toast.success('Experiment stopped')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to stop experiment.')
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
        <PageHeader title="Edit experiment" />
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
      <PageHeader
        title={isEdit ? 'Edit experiment' : 'New experiment'}
        subtitle={name || undefined}
      >
        {isEdit && (
          <Badge variant="outline" className="capitalize">
            {status}
          </Badge>
        )}
        {isEdit && canManageProjects && status === 'draft' && (
          <Button variant="outline" size="sm" onClick={handleLaunch} disabled={launch.isPending}>
            <Rocket className="w-3.5 h-3.5" />
            Launch
          </Button>
        )}
        {isEdit && canManageProjects && status === 'running' && (
          <Button variant="outline" size="sm" onClick={handleStop} disabled={stop.isPending}>
            <Square className="w-3.5 h-3.5" />
            Stop
          </Button>
        )}
        {isEdit && canManageProjects && status === 'complete' && (
          <Button
            variant="secondary"
            size="sm"
            onClick={handleLaunch}
            disabled={launch.isPending}
            title="Restarts data collection; clears the previous end date."
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Restart
          </Button>
        )}
        {isEdit && (status === 'running' || status === 'complete') && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/experiments/${id}/results`)}
          >
            <TrendingUp className="w-3.5 h-3.5" />
            View results
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => navigate('/experiments')}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving || !canManageProjects}>
          {isEdit ? 'Save changes' : 'Create experiment'}
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-auto">
        <div className="p-4 md:p-6 space-y-5">
          {!canManageProjects && (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-amber-400">
              You don&apos;t have permission to edit experiments. You can view this experiment, but
              changes won&apos;t be saved.
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="experiment-name"
                className="block text-[11px] font-medium text-muted-foreground mb-1.5"
              >
                Experiment name
              </label>
              <input
                id="experiment-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. New onboarding flow"
                className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
              />
            </div>
            <div>
              <label
                htmlFor="experiment-hypothesis"
                className="block text-[11px] font-medium text-muted-foreground mb-1.5"
              >
                Hypothesis
              </label>
              <input
                id="experiment-hypothesis"
                value={hypothesis}
                onChange={(e) => setHypothesis(e.target.value)}
                placeholder="Optional — what do you expect to happen?"
                className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
              />
            </div>
          </div>

          {!isEdit && (
            <div>
              <div className="block text-[11px] font-medium text-muted-foreground mb-1.5">
                Environment
              </div>
              <Select value={env} onValueChange={(v) => setEnv(v as FlagEnv)}>
                <SelectTrigger className="h-9 w-full sm:w-64 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {environments.map((e) => (
                    <SelectItem key={e.key} value={e.key} className="text-xs">
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1.5 text-[11px] text-muted-foreground/70">
                Validate in a non-production environment before launching broadly.
              </p>
            </div>
          )}

          <div>
            <label
              htmlFor="experiment-description"
              className="block text-[11px] font-medium text-muted-foreground mb-1.5"
            >
              Description
            </label>
            <input
              id="experiment-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                Variants ({variants.length})
              </span>
              {!variantsLocked && (
                <button
                  type="button"
                  onClick={addVariant}
                  className="text-[11px] text-primary hover:opacity-80 flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" />
                  Add variant
                </button>
              )}
            </div>

            {variantsLocked && (
              <p className="mb-2 text-[11px] text-muted-foreground/70">
                Variants can only be edited while the experiment is in draft.
              </p>
            )}

            <VariantTrafficBar variants={variants} />

            <div className="mt-3 space-y-2">
              {variants.map((variant, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: variant rows are positional
                  key={i}
                  className="flex items-center gap-2 rounded-lg border border-border bg-card p-3"
                >
                  <span
                    className={cn(
                      'h-2.5 w-2.5 shrink-0 rounded-full',
                      VARIANT_COLORS[i % VARIANT_COLORS.length],
                    )}
                  />
                  <input
                    value={variant.key}
                    onChange={(e) => updateVariant(i, { key: e.target.value })}
                    placeholder="variant key"
                    disabled={variantsLocked}
                    className="flex-1 min-w-0 rounded bg-muted/50 px-2 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
                  />
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={variant.rolloutPercentage}
                    onChange={(e) =>
                      updateVariant(i, {
                        rolloutPercentage: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                      })
                    }
                    disabled={variantsLocked}
                    className="w-20 shrink-0 rounded bg-primary/10 px-2 py-1.5 font-mono text-xs text-primary focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
                  />
                  <span className="shrink-0 text-[11px] text-muted-foreground">%</span>
                  {!variantsLocked && variants.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removeVariant(i)}
                      className="shrink-0 text-muted-foreground/40 transition-colors hover:text-red-400"
                      aria-label="Remove variant"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {error && <p className="text-[11px] text-red-400 font-medium">{error}</p>}

          <div>
            <span className="block text-[11px] font-medium text-muted-foreground mb-2">
              Primary metric
            </span>
            <MetricEditor
              projectId={projectId}
              metric={primaryMetric}
              eventOptions={eventNames.options}
              disabled={!canManageProjects}
              onChange={setPrimaryMetric}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                Secondary metrics ({secondaryMetrics.length})
              </span>
              <button
                type="button"
                onClick={addSecondaryMetric}
                className="text-[11px] text-primary hover:opacity-80 flex items-center gap-1"
              >
                <Plus className="w-3 h-3" />
                Add secondary metric
              </button>
            </div>

            <div className="space-y-3">
              {secondaryMetrics.map((metric, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: secondary metrics are positional
                  key={i}
                  className="relative"
                >
                  <MetricEditor
                    projectId={projectId}
                    metric={metric}
                    eventOptions={eventNames.options}
                    disabled={!canManageProjects}
                    onChange={(m) => updateSecondaryMetric(i, m)}
                  />
                  {canManageProjects && (
                    <button
                      type="button"
                      onClick={() => removeSecondaryMetric(i)}
                      className="absolute top-3 right-3 text-muted-foreground/40 transition-colors hover:text-red-400"
                      aria-label="Remove secondary metric"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {secondaryMetrics.length === 0 && (
                <p className="text-[11px] text-muted-foreground/70">No secondary metrics.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Horizontal, segmented traffic-split bar (PostHog-style) — each variant
 * gets a segment proportional to its rollout percentage relative to the
 * current total (falls back to an even split across variants if the total
 * is 0, e.g. right after "add variant"). */
function VariantTrafficBar({ variants }: { variants: VariantUI[] }) {
  const total = variants.reduce((sum, v) => sum + v.rolloutPercentage, 0)
  const segments = variants.map((v, i) => ({
    key: v.key || `variant-${i}`,
    width: total > 0 ? (v.rolloutPercentage / total) * 100 : 100 / Math.max(variants.length, 1),
    color: VARIANT_COLORS[i % VARIANT_COLORS.length],
    pct: v.rolloutPercentage,
  }))

  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full border border-border bg-muted/30">
        {segments.map((s, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional, same order as variants
            key={i}
            className={cn(
              'h-full transition-all',
              s.color,
              i > 0 && 'border-l border-background/40',
            )}
            style={{ width: `${s.width}%` }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {segments.map((s, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: legend entries mirror the segments above
            key={i}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', s.color)} />
            {s.key} — {s.pct}%
          </span>
        ))}
      </div>
      {total !== 100 && (
        <p className="mt-1 text-[10px] text-amber-400/80">Rollout percentages total {total}%.</p>
      )}
    </div>
  )
}

function MetricEditor({
  projectId,
  metric,
  eventOptions,
  disabled,
  onChange,
}: {
  projectId: string
  metric: MetricUI
  eventOptions: { value: string; label: string }[]
  disabled: boolean
  onChange: (metric: MetricUI) => void
}) {
  function changeType(type: MetricType) {
    onChange(emptyMetric(type))
  }

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <Select value={metric.type} onValueChange={(v) => changeType(v as MetricType)}>
        <SelectTrigger className="h-7 w-[140px] text-[11px]" disabled={disabled}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(METRIC_TYPE_LABELS) as MetricType[]).map((t) => (
            <SelectItem key={t} value={t} className="text-xs">
              {METRIC_TYPE_LABELS[t]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {metric.type === 'funnel' && (
        <FunnelMetricFields
          projectId={projectId}
          metric={metric}
          eventOptions={eventOptions}
          disabled={disabled}
          onChange={onChange}
        />
      )}
      {metric.type === 'mean' && (
        <MeanMetricFields
          metric={metric}
          eventOptions={eventOptions}
          disabled={disabled}
          onChange={onChange}
        />
      )}
      {metric.type === 'ratio' && (
        <RatioMetricFields
          metric={metric}
          eventOptions={eventOptions}
          disabled={disabled}
          onChange={onChange}
        />
      )}
      {metric.type === 'retention' && (
        <RetentionMetricFields
          metric={metric}
          eventOptions={eventOptions}
          disabled={disabled}
          onChange={onChange}
        />
      )}
    </div>
  )
}

function FunnelMetricFields({
  projectId,
  metric,
  eventOptions,
  disabled,
  onChange,
}: {
  projectId: string
  metric: FunnelMetricUI
  eventOptions: { value: string; label: string }[]
  disabled: boolean
  onChange: (metric: MetricUI) => void
}) {
  function updateStep(index: number, patch: Partial<MetricFunnelStep>) {
    onChange({
      ...metric,
      steps: metric.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    })
  }
  function addStep() {
    if (metric.steps.length < 8) {
      onChange({ ...metric, steps: [...metric.steps, { event: '', properties: [] }] })
    }
  }
  function removeStep(index: number) {
    onChange({ ...metric, steps: metric.steps.filter((_, i) => i !== index) })
  }
  function addFilter(stepIndex: number) {
    updateStep(stepIndex, {
      properties: [
        ...metric.steps[stepIndex].properties,
        { key: '', operator: 'exact', value: '' },
      ],
    })
  }
  function updateFilter(
    stepIndex: number,
    filterIndex: number,
    patch: Partial<MetricStepCondition>,
  ) {
    updateStep(stepIndex, {
      properties: metric.steps[stepIndex].properties.map((f, j) =>
        j === filterIndex ? { ...f, ...patch } : f,
      ),
    })
  }
  function removeFilter(stepIndex: number, filterIndex: number) {
    updateStep(stepIndex, {
      properties: metric.steps[stepIndex].properties.filter((_, j) => j !== filterIndex),
    })
  }

  return (
    <div className="space-y-3">
      <div>
        <span className="block text-[10px] font-medium text-muted-foreground mb-1.5">
          Conversion window
        </span>
        <SegmentedToggle
          options={WINDOW_OPTIONS}
          value={metric.window}
          onChange={(window) => onChange({ ...metric, window })}
        />
      </div>

      <div className="space-y-2">
        {metric.steps.map((step, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: funnel steps are positional
            key={i}
            className="rounded-lg border border-border bg-background/40 p-3"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="w-5 h-5 rounded-full bg-primary/15 flex items-center justify-center text-[9px] font-bold text-primary shrink-0">
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <EventCombobox
                  value={step.event}
                  options={eventOptions}
                  disabled={disabled}
                  onChange={(event) => updateStep(i, { event })}
                  placeholder="Select event"
                />
              </div>
              {metric.steps.length > 2 && !disabled && (
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

            {step.properties.length > 0 && (
              <div className="space-y-1.5 mb-2 pl-7">
                {step.properties.map((filter, fi) => (
                  <MetricFilterRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: filter rows are positional
                    key={fi}
                    filter={filter}
                    projectId={projectId}
                    event={step.event}
                    disabled={disabled}
                    onChange={(patch) => updateFilter(i, fi, patch)}
                    onRemove={() => removeFilter(i, fi)}
                  />
                ))}
              </div>
            )}

            {!disabled && (
              <div className="pl-7">
                <button
                  type="button"
                  onClick={() => addFilter(i)}
                  disabled={!step.event}
                  className="text-[11px] text-primary hover:opacity-80 flex items-center gap-1 disabled:opacity-40"
                >
                  <Plus className="w-3 h-3" />
                  Add condition
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {!disabled && (
        <button
          type="button"
          onClick={addStep}
          disabled={metric.steps.length >= 8}
          className="text-[11px] text-primary hover:opacity-80 flex items-center gap-1 disabled:opacity-40"
        >
          <Plus className="w-3 h-3" />
          Add step
        </button>
      )}
    </div>
  )
}

function MetricFilterRow({
  filter,
  projectId,
  event,
  disabled,
  onChange,
  onRemove,
}: {
  filter: MetricStepCondition
  projectId: string
  event: string
  disabled: boolean
  onChange: (patch: Partial<MetricStepCondition>) => void
  onRemove: () => void
}) {
  const properties = useEventProperties(projectId, event || undefined)
  const valueless = VALUELESS_OPERATORS.has(filter.operator)

  return (
    <div className="flex items-center gap-2">
      <span className="w-7 shrink-0 font-mono text-[10px] font-medium text-amber-400">IF</span>
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {properties.options.length > 0 ? (
          <Select
            value={filter.key || undefined}
            onValueChange={(v) => onChange({ key: v })}
            disabled={disabled}
          >
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
            value={filter.key}
            onChange={(e) => onChange({ key: e.target.value })}
            placeholder="property"
            disabled={disabled}
            className="w-32 rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
          />
        )}
        <Select
          value={filter.operator}
          onValueChange={(v) => onChange({ operator: v as MetricOperator })}
          disabled={disabled}
        >
          <SelectTrigger className="h-7 w-[130px] text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METRIC_OPERATORS.map((op) => (
              <SelectItem key={op} value={op} className="text-xs">
                {METRIC_OPERATOR_LABELS[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!valueless && (
          <input
            value={filter.value}
            onChange={(e) => onChange({ value: e.target.value })}
            placeholder="value"
            disabled={disabled}
            className="w-32 rounded bg-primary/10 px-2 py-1 font-mono text-xs text-primary placeholder:text-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
          />
        )}
      </div>
      {!disabled && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-2 shrink-0 text-muted-foreground/40 transition-colors hover:text-red-400"
          aria-label="Remove condition"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

function MeanMetricFields({
  metric,
  eventOptions,
  disabled,
  onChange,
}: {
  metric: MeanMetricUI
  eventOptions: { value: string; label: string }[]
  disabled: boolean
  onChange: (metric: MetricUI) => void
}) {
  return (
    <div className="flex flex-col sm:flex-row gap-2">
      <div className="flex-1 min-w-0">
        <EventCombobox
          value={metric.event}
          options={eventOptions}
          disabled={disabled}
          onChange={(event) => onChange({ ...metric, event })}
          placeholder="Select event"
        />
      </div>
      <input
        value={metric.property}
        onChange={(e) => onChange({ ...metric, property: e.target.value })}
        placeholder="numeric property (e.g. amount)"
        disabled={disabled}
        className="flex-1 min-w-0 rounded bg-muted/50 px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
      />
    </div>
  )
}

function RatioMetricFields({
  metric,
  eventOptions,
  disabled,
  onChange,
}: {
  metric: RatioMetricUI
  eventOptions: { value: string; label: string }[]
  disabled: boolean
  onChange: (metric: MetricUI) => void
}) {
  return (
    <div className="flex flex-col sm:flex-row gap-2">
      <div className="flex-1 min-w-0">
        <span className="block text-[10px] font-medium text-muted-foreground mb-1">
          Numerator event
        </span>
        <EventCombobox
          value={metric.numeratorEvent}
          options={eventOptions}
          disabled={disabled}
          onChange={(numeratorEvent) => onChange({ ...metric, numeratorEvent })}
          placeholder="Select event"
        />
      </div>
      <div className="flex-1 min-w-0">
        <span className="block text-[10px] font-medium text-muted-foreground mb-1">
          Denominator event
        </span>
        <EventCombobox
          value={metric.denominatorEvent}
          options={eventOptions}
          disabled={disabled}
          onChange={(denominatorEvent) => onChange({ ...metric, denominatorEvent })}
          placeholder="Select event"
        />
      </div>
    </div>
  )
}

function RetentionMetricFields({
  metric,
  eventOptions,
  disabled,
  onChange,
}: {
  metric: RetentionMetricUI
  eventOptions: { value: string; label: string }[]
  disabled: boolean
  onChange: (metric: MetricUI) => void
}) {
  return (
    <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
      <div className="flex-1 min-w-0">
        <span className="block text-[10px] font-medium text-muted-foreground mb-1">
          Return event
        </span>
        <EventCombobox
          value={metric.returnEvent}
          options={eventOptions}
          disabled={disabled}
          onChange={(returnEvent) => onChange({ ...metric, returnEvent })}
          placeholder="Select event"
        />
      </div>
      <div className="w-full sm:w-28">
        <label
          htmlFor="retention-metric-days"
          className="block text-[10px] font-medium text-muted-foreground mb-1"
        >
          Days
        </label>
        <input
          id="retention-metric-days"
          type="number"
          min={1}
          value={metric.days}
          onChange={(e) => onChange({ ...metric, days: Math.max(1, Number(e.target.value) || 1) })}
          disabled={disabled}
          className="w-full rounded bg-muted/50 px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
        />
      </div>
    </div>
  )
}

/** Small searchable single-value combobox for event pickers (Command+Popover
 * pattern, mirrors FunnelBuilderPage.tsx/SegmentBuilderPage.tsx's local
 * EventCombobox — each builder page keeps its own copy rather than sharing
 * one component). */
function EventCombobox({
  value,
  options,
  disabled,
  onChange,
  placeholder,
}: {
  value: string
  options: { value: string; label: string }[]
  disabled?: boolean
  onChange: (value: string) => void
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  const label = useMemo(
    () => options.find((o) => o.value === value)?.label ?? value,
    [options, value],
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="w-full flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-foreground hover:bg-muted/40 transition-colors disabled:opacity-50"
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

export default ExperimentBuilderPage
