import { Check, ChevronsUpDown, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { PageHeader } from '@/components/PageHeader'
import {
  FILTER_AUTOCOMPLETE_RANGE,
  type PropertyFilter,
  PropertyFilterRow,
} from '@/components/PropertyFilterRow'
import { SegmentedToggle } from '@/components/SegmentedToggle'
import { SkeletonCard } from '@/components/skeletons'
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
import { useEventNames, useEventProperties } from '@/hooks/useTaxonomy'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'
import { FunnelPreview } from '@/pages/funnels/FunnelPreview'

const WINDOW_OPTIONS = [
  { value: 3600, label: '1h' },
  { value: 86400, label: '1d' },
  { value: 604800, label: '7d' },
] as const

type FunnelStepFilter = PropertyFilter

interface FunnelStep {
  event: string
  alias?: string
  filters: FunnelStepFilter[]
}

function emptyStep(defaultEvent = ''): FunnelStep {
  return { event: defaultEvent, filters: [] }
}

export function FunnelBuilderPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const { id } = useParams()
  const isEdit = !!id
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canManageProjects = can('projects:manage')

  const eventNames = useEventNames(projectId)

  const existing = trpc.funnels.get.useQuery(
    { projectId: projectId as string, id: id as string },
    { enabled: !!projectId && isEdit },
  )

  const [name, setName] = useState('')
  const [windowSecs, setWindowSecs] = useState<number>(86400)
  const [steps, setSteps] = useState<FunnelStep[]>([emptyStep(), emptyStep()])
  const [error, setError] = useState('')
  const [hydrated, setHydrated] = useState(!isEdit)

  // biome-ignore lint/correctness/useExhaustiveDependencies: key on the funnel id (not the whole existing.data object) to avoid re-triggering on refetches
  useEffect(() => {
    if (isEdit && existing.data && !hydrated) {
      const data = existing.data as unknown as { name: string; window: number; steps: unknown }
      setName(data.name)
      setWindowSecs(data.window)
      const loadedSteps = Array.isArray(data.steps) ? (data.steps as FunnelStep[]) : []
      setSteps(loadedSteps.length > 0 ? loadedSteps : [emptyStep(), emptyStep()])
      setHydrated(true)
    }
  }, [isEdit, existing.data?.id, hydrated])

  const create = trpc.funnels.create.useMutation()
  const update = trpc.funnels.update.useMutation()
  const saving = create.isPending || update.isPending

  function addStep() {
    if (steps.length < 8) setSteps((s) => [...s, emptyStep()])
  }
  function removeStep(index: number) {
    setSteps((s) => s.filter((_, i) => i !== index))
  }
  function updateStep(index: number, patch: Partial<FunnelStep>) {
    setSteps((s) => s.map((st, i) => (i === index ? { ...st, ...patch } : st)))
  }
  function addFilter(stepIndex: number) {
    setSteps((s) =>
      s.map((st, i) =>
        i === stepIndex
          ? { ...st, filters: [...st.filters, { key: '', operator: 'exact', value: '' }] }
          : st,
      ),
    )
  }
  function updateFilter(stepIndex: number, filterIndex: number, patch: Partial<FunnelStepFilter>) {
    setSteps((s) =>
      s.map((st, i) =>
        i === stepIndex
          ? {
              ...st,
              filters: st.filters.map((f, j) => (j === filterIndex ? { ...f, ...patch } : f)),
            }
          : st,
      ),
    )
  }
  function removeFilter(stepIndex: number, filterIndex: number) {
    setSteps((s) =>
      s.map((st, i) =>
        i === stepIndex ? { ...st, filters: st.filters.filter((_, j) => j !== filterIndex) } : st,
      ),
    )
  }

  // Cleaned steps for the live preview query — mirrors the save-time cleanup below.
  const previewSteps = steps
    .map((s) => ({
      event: s.event,
      alias: s.alias?.trim() || undefined,
      filters: s.filters.filter((f) => f.key.length > 0),
    }))
    .filter((s) => s.event.length > 0)
  const canPreview = previewSteps.length >= 2

  const preview = trpc.events.funnel.useQuery(
    {
      projectId: projectId as string,
      steps: previewSteps,
      window: windowSecs,
      range: FILTER_AUTOCOMPLETE_RANGE,
    },
    { enabled: !!projectId && canPreview, placeholderData: (prev) => prev },
  )
  const previewRows = preview.data ?? []
  const labelFor = (v: string) => eventNames.options.find((o) => o.value === v)?.label ?? v
  const previewDisplayLabel = (r: { label: string; alias?: string }) => r.alias || labelFor(r.label)
  const previewWindowLabel =
    WINDOW_OPTIONS.find((o) => o.value === windowSecs)?.label ?? `${windowSecs}s`
  const previewState = !canPreview
    ? 'idle'
    : preview.isPending
      ? 'loading'
      : preview.error
        ? 'error'
        : previewRows.length === 0
          ? 'empty'
          : 'ready'

  async function handleSave() {
    if (!projectId || !canManageProjects) return
    if (!name.trim()) {
      setError('Funnel name is required.')
      return
    }
    const validSteps = steps.filter((s) => s.event.length > 0)
    if (validSteps.length < 2) {
      setError('Add at least 2 steps.')
      return
    }
    setError('')
    const payload = {
      projectId,
      name: name.trim(),
      window: windowSecs,
      steps: validSteps.map((s) => ({
        event: s.event,
        alias: s.alias?.trim() || undefined,
        filters: s.filters.filter((f) => f.key.length > 0),
      })),
    }
    try {
      if (isEdit && id) {
        await update.mutateAsync({
          projectId,
          id,
          patch: { name: payload.name, window: payload.window, steps: payload.steps },
        })
      } else {
        await create.mutateAsync(payload)
      }
      await utils.funnels.list.invalidate()
      navigate('/funnels')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save funnel.')
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
        <PageHeader title="Edit funnel" />
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
      <PageHeader title={isEdit ? 'Edit funnel' : 'New funnel'} subtitle={name || undefined}>
        <Button variant="outline" size="sm" onClick={() => navigate('/funnels')}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving || !canManageProjects}>
          {isEdit ? 'Save changes' : 'Create funnel'}
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-auto">
        <div className="p-4 md:p-6 space-y-5">
          {!canManageProjects && (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-amber-400">
              You don&apos;t have permission to edit funnels. You can view this funnel, but changes
              won&apos;t be saved.
            </div>
          )}

          <div>
            <label
              htmlFor="funnel-name"
              className="block text-[11px] font-medium text-muted-foreground mb-1.5"
            >
              Funnel name
            </label>
            <input
              id="funnel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Trial → Paid Conversion"
              className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
            />
          </div>

          <div>
            <span className="block text-[11px] font-medium text-muted-foreground mb-2">
              Conversion window
            </span>
            <SegmentedToggle options={WINDOW_OPTIONS} value={windowSecs} onChange={setWindowSecs} />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                Steps ({steps.length})
              </span>
              <button
                type="button"
                onClick={addStep}
                disabled={steps.length >= 8 || eventNames.options.length === 0}
                className="text-[11px] text-primary hover:opacity-80 flex items-center gap-1 disabled:opacity-40"
              >
                <Plus className="w-3 h-3" />
                Add step
              </button>
            </div>

            <div className="space-y-3">
              {steps.map((step, i) => (
                <StepCard
                  // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional
                  key={i}
                  index={i}
                  step={step}
                  projectId={projectId}
                  eventOptions={eventNames.options}
                  canRemove={steps.length > 2}
                  onEventChange={(event) => updateStep(i, { event })}
                  onAliasChange={(alias) => updateStep(i, { alias })}
                  onRemove={() => removeStep(i)}
                  onAddFilter={() => addFilter(i)}
                  onFilterChange={(fi, patch) => updateFilter(i, fi, patch)}
                  onFilterRemove={(fi) => removeFilter(i, fi)}
                />
              ))}
            </div>
          </div>

          {error && <p className="text-[11px] text-red-400 font-medium">{error}</p>}

          <div>
            <span className="block text-[11px] font-medium text-muted-foreground mb-2">
              Preview
            </span>
            <div className="space-y-3">
              <FunnelPreview
                rows={previewRows}
                displayLabel={previewDisplayLabel}
                windowLabel={previewWindowLabel}
                state={previewState}
                errorMessage={preview.error?.message}
                idleHint="Add at least two steps to preview."
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function StepCard({
  index,
  step,
  projectId,
  eventOptions,
  canRemove,
  onEventChange,
  onAliasChange,
  onRemove,
  onAddFilter,
  onFilterChange,
  onFilterRemove,
}: {
  index: number
  step: FunnelStep
  projectId: string
  eventOptions: { value: string; label: string }[]
  canRemove: boolean
  onEventChange: (event: string) => void
  onAliasChange: (alias: string) => void
  onRemove: () => void
  onAddFilter: () => void
  onFilterChange: (filterIndex: number, patch: Partial<FunnelStepFilter>) => void
  onFilterRemove: (filterIndex: number) => void
}) {
  const properties = useEventProperties(projectId, step.event || undefined)

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-5 h-5 rounded-full bg-primary/15 flex items-center justify-center text-[9px] font-bold text-primary shrink-0">
          {index + 1}
        </span>
        <div className="flex-1 min-w-0">
          <EventCombobox
            value={step.event}
            options={eventOptions}
            onChange={onEventChange}
            placeholder="Select event"
          />
        </div>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-muted-foreground/40 hover:text-red-400 transition-colors shrink-0"
            aria-label="Remove step"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="pl-7 mb-3">
        <input
          value={step.alias ?? ''}
          onChange={(e) => onAliasChange(e.target.value)}
          placeholder="Optional alias"
          maxLength={60}
          className="w-full bg-muted/30 border border-border rounded-md text-[11px] px-2.5 py-1.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
        />
      </div>

      {step.filters.length > 0 && (
        <div className="space-y-1.5 mb-2 pl-7">
          {step.filters.map((filter, fi) => (
            <PropertyFilterRow
              // biome-ignore lint/suspicious/noArrayIndexKey: filter rows are positional
              key={fi}
              datalistIdPrefix="funnel-step-values"
              index={fi}
              filter={filter}
              projectId={projectId}
              event={step.event}
              propertyOptions={properties.options}
              onChange={(patch) => onFilterChange(fi, patch)}
              onRemove={() => onFilterRemove(fi)}
            />
          ))}
        </div>
      )}

      <div className="pl-7">
        <button
          type="button"
          onClick={onAddFilter}
          disabled={!step.event}
          className="text-[11px] text-primary hover:opacity-80 flex items-center gap-1 disabled:opacity-40"
        >
          <Plus className="w-3 h-3" />
          Add condition
        </button>
      </div>
    </div>
  )
}

/** Small searchable single-value combobox for the step event picker (Command+Popover pattern,
 * see components/EventTypePicker.tsx — that component is shaped for a multi-pill filter bar so
 * we mirror its pattern here rather than reuse it directly). */
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
  const label = useMemo(
    () => options.find((o) => o.value === value)?.label ?? value,
    [options, value],
  )

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
