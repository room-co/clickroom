import { renderSurvey, type SurveyDefinition as SdkSurveyDefinition } from '@clickroom/sdk-js'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ExternalLink,
  Loader2,
  Plus,
  RotateCcw,
  TrendingUp,
  Users,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { PageHeader } from '@/components/PageHeader'
import {
  emptyPropertyFilter,
  type PropertyFilter,
  PropertyFilterRow,
} from '@/components/PropertyFilterRow'
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
import {
  type ChoiceQuestionUI,
  defaultTriggers,
  fromApiDefinition,
  type LinkQuestionUI,
  newQuestion,
  QUESTION_TYPE_LABELS,
  type RatingDisplay,
  type RatingPreset,
  type RatingQuestionUI,
  type RatingScale,
  STATUS_BADGE,
  type SurveyAppearanceUI,
  type SurveyDefinitionUI,
  type SurveyFrequency,
  type SurveyPosition,
  type SurveyQuestionType,
  type SurveyQuestionUI,
  type SurveyRow,
  type SurveyStatus,
  type SurveyTriggersUI,
  toApiDefinition,
  validateDefinition,
} from './types'
import { useLinkedFlag } from './useLinkedFlag'

const QUESTION_TYPES: readonly SurveyQuestionType[] = [
  'rating',
  'open',
  'single_choice',
  'multiple_choice',
  'link',
]
const POSITIONS: readonly SurveyPosition[] = ['bottom_right', 'bottom_left', 'center']
const POSITION_LABELS: Record<SurveyPosition, string> = {
  bottom_right: 'Bottom right',
  bottom_left: 'Bottom left',
  center: 'Center (modal)',
}
const SCALES: readonly RatingScale[] = [5, 7, 10]
const DISPLAYS: readonly RatingDisplay[] = ['number', 'emoji', 'star']
const PRESETS: readonly (RatingPreset | 'none')[] = ['none', 'csat', 'ces', 'nps']

const inputClass =
  'w-full rounded border border-border bg-muted/30 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50'
const labelClass = 'block text-[11px] font-medium text-muted-foreground mb-1.5'

export function SurveyBuilderPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const { id } = useParams()
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canManage = can('projects:manage')

  const existing = trpc.surveys.get.useQuery(
    { projectId: projectId as string, id: id as string },
    { enabled: !!projectId && !!id },
  )
  const survey = existing.data as unknown as SurveyRow | undefined

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<SurveyStatus>('draft')
  const [definition, setDefinition] = useState<SurveyDefinitionUI>(() => ({
    version: 1,
    questions: [newQuestion('rating')],
    appearance: { position: 'bottom_right' },
    triggers: defaultTriggers(),
  }))
  const [hydrated, setHydrated] = useState(false)
  const [error, setError] = useState('')

  // Save and status changes are separate mutation instances so their pending
  // states don't bleed into each other's buttons (one shared `isPending` would
  // spin the Save button while only the status is changing, and vice versa).
  const save = trpc.surveys.update.useMutation()
  const statusChange = trpc.surveys.update.useMutation()

  const linkedFlag = useLinkedFlag(projectId, survey?.featureFlagId)

  // Serialized snapshot of the exact save payload — used both to seed the
  // dirty baseline and to compare against on every edit.
  const snapshot = useCallback(
    (n: string, d: string, def: SurveyDefinitionUI) =>
      JSON.stringify({
        name: n.trim(),
        description: d.trim() || null,
        definition: toApiDefinition(def),
      }),
    [],
  )
  // Baseline of the last-saved state; dirty = current payload differs from it.
  const baselineRef = useRef<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: hydrate once, keyed on survey id
  useEffect(() => {
    if (survey && !hydrated) {
      const def = fromApiDefinition(survey.definition)
      setName(survey.name)
      setDescription(survey.description ?? '')
      setStatus(survey.status)
      setDefinition(def)
      baselineRef.current = snapshot(survey.name, survey.description ?? '', def)
      setHydrated(true)
    }
  }, [survey?.id, hydrated])

  const currentSig = useMemo(
    () => snapshot(name, description, definition),
    [snapshot, name, description, definition],
  )
  const isDirty = hydrated && baselineRef.current !== null && currentSig !== baselineRef.current

  function patchDefinition(patch: Partial<SurveyDefinitionUI>) {
    setDefinition((d) => ({ ...d, ...patch }))
  }
  function updateQuestion(index: number, next: SurveyQuestionUI) {
    setDefinition((d) => ({
      ...d,
      questions: d.questions.map((q, i) => (i === index ? next : q)),
    }))
  }
  function addQuestion() {
    setDefinition((d) => ({ ...d, questions: [...d.questions, newQuestion('rating')] }))
  }
  function removeQuestion(index: number) {
    setDefinition((d) => ({ ...d, questions: d.questions.filter((_, i) => i !== index) }))
  }
  function moveQuestion(index: number, dir: -1 | 1) {
    setDefinition((d) => {
      const next = [...d.questions]
      const target = index + dir
      if (target < 0 || target >= next.length) return d
      ;[next[index], next[target]] = [next[target], next[index]]
      return { ...d, questions: next }
    })
  }

  async function handleSave() {
    if (!projectId || !id || !canManage) return
    const validationError = validateDefinition(name, definition)
    if (validationError) {
      setError(validationError)
      return
    }
    setError('')
    try {
      await save.mutateAsync({
        projectId,
        id,
        patch: {
          name: name.trim(),
          description: description.trim() || null,
          definition: toApiDefinition(definition) as never,
        },
      })
      // Saved state is the new clean baseline.
      baselineRef.current = snapshot(name, description, definition)
      await utils.surveys.get.invalidate({ projectId, id })
      await utils.surveys.list.invalidate()
      toast.success('Survey saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save survey.')
    }
  }

  async function changeStatus(next: SurveyStatus) {
    if (!projectId || !id || !canManage) return
    try {
      await statusChange.mutateAsync({ projectId, id, patch: { status: next } })
      setStatus(next)
      track('survey_status_changed', { survey_id: id, status: next })
      await utils.surveys.get.invalidate({ projectId, id })
      await utils.surveys.list.invalidate()
      toast.success(`Survey ${next === 'active' ? 'activated' : next}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update status.')
    }
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No project selected.
      </div>
    )
  }

  if (existing.isPending) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <PageHeader title="Edit survey" />
        <div className="flex-1 overflow-auto">
          <div className="space-y-5 p-4 md:p-6">
            <SkeletonCard lines={2} />
            <SkeletonCard lines={6} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader title="Edit survey" subtitle={name || undefined}>
        <Badge variant={STATUS_BADGE[status]} className="capitalize">
          {status}
        </Badge>
        {canManage && status === 'draft' && (
          <Button
            size="sm"
            onClick={() => changeStatus('active')}
            disabled={statusChange.isPending}
          >
            {statusChange.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Enable survey
          </Button>
        )}
        {canManage && status === 'active' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => changeStatus('draft')}
            disabled={statusChange.isPending}
          >
            Pause
          </Button>
        )}
        {canManage && status !== 'archived' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => changeStatus('archived')}
            disabled={statusChange.isPending}
          >
            Archive
          </Button>
        )}
        {canManage && status === 'archived' && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => changeStatus('draft')}
            disabled={statusChange.isPending}
          >
            Restore
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => navigate(`/surveys/${id}/results`)}>
          <TrendingUp className="h-3.5 w-3.5" />
          Results
        </Button>
        <Button variant="outline" size="sm" onClick={() => navigate('/surveys')}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={save.isPending || !canManage || !isDirty}>
          {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {isDirty ? 'Save changes' : 'Saved'}
        </Button>
      </PageHeader>

      {/* Two-pane: editor + live preview. Stacks to one column below md. */}
      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        <div className="flex-1 overflow-auto md:border-r md:border-border">
          <div className="space-y-6 p-4 md:p-6">
            {!canManage && (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-amber-400">
                You don&apos;t have permission to edit surveys — changes won&apos;t be saved.
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="survey-name" className={labelClass}>
                  Name
                </label>
                <input
                  id="survey-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Post-checkout CSAT"
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="survey-desc" className={labelClass}>
                  Description
                </label>
                <input
                  id="survey-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional"
                  className={inputClass}
                />
              </div>
            </div>

            <AudienceCard flag={linkedFlag} status={status} />

            {/* Questions */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-medium text-muted-foreground">
                  Questions ({definition.questions.length})
                </span>
                {canManage && (
                  <button
                    type="button"
                    onClick={addQuestion}
                    className="flex items-center gap-1 text-[11px] text-primary hover:opacity-80"
                  >
                    <Plus className="h-3 w-3" />
                    Add question
                  </button>
                )}
              </div>
              <div className="space-y-3">
                {definition.questions.map((q, i) => (
                  <QuestionEditor
                    key={q.id}
                    question={q}
                    index={i}
                    total={definition.questions.length}
                    disabled={!canManage}
                    onChange={(next) => updateQuestion(i, next)}
                    onRemove={() => removeQuestion(i)}
                    onMove={(dir) => moveQuestion(i, dir)}
                  />
                ))}
              </div>
            </section>

            <AppearanceEditor
              appearance={definition.appearance}
              disabled={!canManage}
              onChange={(appearance) => patchDefinition({ appearance })}
            />

            <TriggersEditor
              triggers={definition.triggers}
              projectId={projectId}
              disabled={!canManage}
              onChange={(triggers) => patchDefinition({ triggers })}
            />

            {error && <p className="text-[11px] font-medium text-red-400">{error}</p>}
          </div>
        </div>

        <PreviewPane definition={definition} />
      </div>
    </div>
  )
}

// ── Linked flag reference ─────────────────────────────────────────────────────

function AudienceCard({
  flag,
  status,
}: {
  flag: { key: string; env: string; active: boolean } | null
  status: SurveyStatus
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-foreground">Audience</span>
            <Badge variant="secondary" className="text-[9px]">
              Everyone
            </Badge>
          </div>
          <p className="text-[10px] leading-snug text-muted-foreground">
            {status === 'active'
              ? 'Shown to everyone who matches the triggers below.'
              : 'When enabled, this survey is shown to everyone who matches the triggers below.'}{' '}
            {flag && (
              <Link
                to={`/flags/${encodeURIComponent(flag.key)}?env=${flag.env}`}
                className="inline-flex items-center gap-0.5 text-primary hover:underline"
              >
                Advanced targeting
                <ExternalLink className="h-2.5 w-2.5" />
              </Link>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Question editor ───────────────────────────────────────────────────────────

function QuestionEditor({
  question,
  index,
  total,
  disabled,
  onChange,
  onRemove,
  onMove,
}: {
  question: SurveyQuestionUI
  index: number
  total: number
  disabled: boolean
  onChange: (q: SurveyQuestionUI) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
}) {
  function changeType(type: SurveyQuestionType) {
    // Preserve the id + prompt text, reset type-specific fields.
    const fresh = newQuestion(type)
    onChange({ ...fresh, id: question.id, question: question.question } as SurveyQuestionUI)
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-bold text-primary">
          {index + 1}
        </span>
        <Select value={question.type} onValueChange={(v) => changeType(v as SurveyQuestionType)}>
          <SelectTrigger className="h-7 w-[150px] text-[11px]" disabled={disabled}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {QUESTION_TYPES.map((t) => (
              <SelectItem key={t} value={t} className="text-xs">
                {QUESTION_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={disabled || index === 0}
            aria-label="Move up"
            className="rounded p-1 text-muted-foreground/60 transition-colors hover:text-foreground disabled:opacity-30"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={disabled || index === total - 1}
            aria-label="Move down"
            className="rounded p-1 text-muted-foreground/60 transition-colors hover:text-foreground disabled:opacity-30"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled || total <= 1}
            aria-label="Remove question"
            className="rounded p-1 text-muted-foreground/60 transition-colors hover:text-red-400 disabled:opacity-30"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <input
          value={question.question}
          onChange={(e) => onChange({ ...question, question: e.target.value })}
          placeholder="Question prompt"
          disabled={disabled}
          className={inputClass}
        />

        {question.type === 'rating' && (
          <RatingFields question={question} disabled={disabled} onChange={onChange} />
        )}
        {question.type === 'open' && (
          <input
            value={question.placeholder ?? ''}
            onChange={(e) => onChange({ ...question, placeholder: e.target.value })}
            placeholder="Placeholder text (optional)"
            disabled={disabled}
            className={inputClass}
          />
        )}
        {(question.type === 'single_choice' || question.type === 'multiple_choice') && (
          <ChoiceFields question={question} disabled={disabled} onChange={onChange} />
        )}
        {question.type === 'link' && (
          <LinkFields question={question} disabled={disabled} onChange={onChange} />
        )}
      </div>
    </div>
  )
}

function RatingFields({
  question,
  disabled,
  onChange,
}: {
  question: RatingQuestionUI
  disabled: boolean
  onChange: (q: SurveyQuestionUI) => void
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <span className={labelClass}>Preset</span>
          <Select
            value={question.preset ?? 'none'}
            onValueChange={(v) =>
              onChange({ ...question, preset: v === 'none' ? undefined : (v as RatingPreset) })
            }
          >
            <SelectTrigger className="h-7 text-[11px]" disabled={disabled}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => (
                <SelectItem key={p} value={p} className="text-xs uppercase">
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <span className={labelClass}>Scale</span>
          <Select
            value={String(question.scale)}
            onValueChange={(v) => onChange({ ...question, scale: Number(v) as RatingScale })}
          >
            <SelectTrigger className="h-7 text-[11px]" disabled={disabled}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCALES.map((s) => (
                <SelectItem key={s} value={String(s)} className="text-xs">
                  1–{s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <span className={labelClass}>Display</span>
          <Select
            value={question.display}
            onValueChange={(v) => onChange({ ...question, display: v as RatingDisplay })}
          >
            <SelectTrigger className="h-7 text-[11px] capitalize" disabled={disabled}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DISPLAYS.map((d) => (
                <SelectItem key={d} value={d} className="text-xs capitalize">
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input
          value={question.lowerLabel ?? ''}
          onChange={(e) => onChange({ ...question, lowerLabel: e.target.value })}
          placeholder="Low-end label (e.g. Not likely)"
          disabled={disabled}
          className={inputClass}
        />
        <input
          value={question.upperLabel ?? ''}
          onChange={(e) => onChange({ ...question, upperLabel: e.target.value })}
          placeholder="High-end label (e.g. Very likely)"
          disabled={disabled}
          className={inputClass}
        />
      </div>
    </div>
  )
}

function ChoiceFields({
  question,
  disabled,
  onChange,
}: {
  question: ChoiceQuestionUI
  disabled: boolean
  onChange: (q: SurveyQuestionUI) => void
}) {
  function setChoice(i: number, value: string) {
    onChange({ ...question, choices: question.choices.map((c, j) => (j === i ? value : c)) })
  }
  function addChoice() {
    onChange({ ...question, choices: [...question.choices, ''] })
  }
  function removeChoice(i: number) {
    onChange({ ...question, choices: question.choices.filter((_, j) => j !== i) })
  }
  return (
    <div className="space-y-2">
      <span className={labelClass}>Choices</span>
      {question.choices.map((choice, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: choice rows are positional
          key={i}
          className="flex items-center gap-2"
        >
          <input
            value={choice}
            onChange={(e) => setChoice(i, e.target.value)}
            placeholder={`Option ${i + 1}`}
            disabled={disabled}
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => removeChoice(i)}
            disabled={disabled || question.choices.length <= 1}
            aria-label="Remove choice"
            className="shrink-0 rounded p-1 text-muted-foreground/60 transition-colors hover:text-red-400 disabled:opacity-30"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {!disabled && (
        <button
          type="button"
          onClick={addChoice}
          className="flex items-center gap-1 text-[11px] text-primary hover:opacity-80"
        >
          <Plus className="h-3 w-3" />
          Add choice
        </button>
      )}
    </div>
  )
}

function LinkFields({
  question,
  disabled,
  onChange,
}: {
  question: LinkQuestionUI
  disabled: boolean
  onChange: (q: SurveyQuestionUI) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <input
        value={question.buttonText}
        onChange={(e) => onChange({ ...question, buttonText: e.target.value })}
        placeholder="Button text"
        disabled={disabled}
        className={inputClass}
      />
      <input
        value={question.url}
        onChange={(e) => onChange({ ...question, url: e.target.value })}
        placeholder="https://example.com"
        disabled={disabled}
        className={inputClass}
      />
    </div>
  )
}

// ── Appearance ────────────────────────────────────────────────────────────────

function AppearanceEditor({
  appearance,
  disabled,
  onChange,
}: {
  appearance: SurveyAppearanceUI
  disabled: boolean
  onChange: (a: SurveyAppearanceUI) => void
}) {
  return (
    <section>
      <span className="mb-2 block text-[11px] font-medium text-muted-foreground">Appearance</span>
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div>
          <span className={labelClass}>Position</span>
          <Select
            value={appearance.position}
            onValueChange={(v) => onChange({ ...appearance, position: v as SurveyPosition })}
          >
            <SelectTrigger className="h-8 text-xs sm:w-56" disabled={disabled}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POSITIONS.map((p) => (
                <SelectItem key={p} value={p} className="text-xs">
                  {POSITION_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="appearance-bg" className={labelClass}>
              Background color
            </label>
            <input
              id="appearance-bg"
              value={appearance.backgroundColor ?? ''}
              onChange={(e) => onChange({ ...appearance, backgroundColor: e.target.value })}
              placeholder="#ffffff"
              disabled={disabled}
              className={cn(inputClass, 'font-mono')}
            />
          </div>
          <div>
            <label htmlFor="appearance-text" className={labelClass}>
              Text color
            </label>
            <input
              id="appearance-text"
              value={appearance.textColor ?? ''}
              onChange={(e) => onChange({ ...appearance, textColor: e.target.value })}
              placeholder="#0f172a"
              disabled={disabled}
              className={cn(inputClass, 'font-mono')}
            />
          </div>
        </div>
        <div>
          <label htmlFor="appearance-thanks" className={labelClass}>
            Thank-you message
          </label>
          <input
            id="appearance-thanks"
            value={appearance.thanksMessage ?? ''}
            onChange={(e) => onChange({ ...appearance, thanksMessage: e.target.value })}
            placeholder="Thanks for your feedback!"
            disabled={disabled}
            className={inputClass}
          />
        </div>
      </div>
    </section>
  )
}

// ── Triggers ──────────────────────────────────────────────────────────────────

type FrequencyKind = 'once' | 'always' | 'every_n_days'

function frequencyKind(f: SurveyFrequency): FrequencyKind {
  if (f === 'once' || f === 'always') return f
  return 'every_n_days'
}

/** Multi-select event picker: a searchable Command popover over the project's
 * known event names, with the chosen events rendered as removable pills. */
function EventMultiPicker({
  projectId,
  value,
  disabled,
  onChange,
}: {
  projectId: string | undefined
  value: string[]
  disabled: boolean
  onChange: (events: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const { options } = useEventNames(projectId)

  const selected = new Set(value)
  const available = options.filter((o) => !selected.has(o.value))
  const filtered = available.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))

  function add(event: string) {
    if (!selected.has(event)) onChange([...value, event])
    setSearch('')
  }
  function remove(event: string) {
    onChange(value.filter((e) => e !== event))
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((event) => (
        <span
          key={event}
          className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 py-1 pl-2 pr-1 font-mono text-[11px] text-foreground"
        >
          {event}
          {!disabled && (
            <button
              type="button"
              onClick={() => remove(event)}
              className="text-muted-foreground/50 transition-colors hover:text-red-400"
              aria-label={`Remove ${event}`}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="flex items-center gap-1 rounded border border-border px-2.5 py-1 text-[11px] font-mono text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
            Add event
            <ChevronDown className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search events…" value={search} onValueChange={setSearch} />
            <CommandList>
              <CommandEmpty>No matching events.</CommandEmpty>
              <CommandGroup>
                {filtered.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    onSelect={() => add(option.value)}
                    className="font-mono text-xs"
                  >
                    {option.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function TriggersEditor({
  triggers,
  projectId,
  disabled,
  onChange,
}: {
  triggers: SurveyTriggersUI
  projectId: string | undefined
  disabled: boolean
  onChange: (t: SurveyTriggersUI) => void
}) {
  const kind = frequencyKind(triggers.frequency)
  const everyN = typeof triggers.frequency === 'object' ? triggers.frequency.every_n_days : 7

  // Property-filter options are scoped to the first selected event (contextual
  // autocomplete); with no event selected the query returns all event props.
  const scopeEvent = triggers.events[0]
  const properties = useEventProperties(projectId, scopeEvent || undefined)

  function setFrequencyKind(next: FrequencyKind) {
    if (next === 'every_n_days') onChange({ ...triggers, frequency: { every_n_days: everyN } })
    else onChange({ ...triggers, frequency: next })
  }

  function addFilter() {
    onChange({ ...triggers, eventFilters: [...triggers.eventFilters, emptyPropertyFilter()] })
  }
  function changeFilter(index: number, patch: Partial<PropertyFilter>) {
    onChange({
      ...triggers,
      eventFilters: triggers.eventFilters.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    })
  }
  function removeFilter(index: number) {
    onChange({ ...triggers, eventFilters: triggers.eventFilters.filter((_, i) => i !== index) })
  }

  return (
    <section>
      <span className="mb-2 block text-[11px] font-medium text-muted-foreground">Triggers</span>
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div>
          <span className={labelClass}>Events</span>
          <EventMultiPicker
            projectId={projectId}
            value={triggers.events}
            disabled={disabled}
            onChange={(events) => onChange({ ...triggers, events })}
          />
        </div>
        <div>
          <span className={labelClass}>Where</span>
          {triggers.eventFilters.length > 0 ? (
            <div className="space-y-1.5">
              {triggers.eventFilters.map((filter, fi) => (
                <PropertyFilterRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: filter rows are positional
                  key={fi}
                  datalistIdPrefix="survey-trigger-values"
                  index={fi}
                  filter={filter}
                  projectId={projectId ?? ''}
                  event={scopeEvent ?? ''}
                  propertyOptions={properties.options}
                  onChange={(patch) => changeFilter(fi, patch)}
                  onRemove={() => removeFilter(fi)}
                />
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground/60">
              No property filters — the survey fires on any matching event.
            </p>
          )}
          <button
            type="button"
            onClick={addFilter}
            disabled={disabled}
            className="mt-1.5 flex items-center gap-1 text-[11px] text-primary transition-opacity hover:opacity-80 disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
            Add condition
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="trigger-url" className={labelClass}>
              URL match
            </label>
            <input
              id="trigger-url"
              value={triggers.urlMatch ?? ''}
              onChange={(e) => onChange({ ...triggers, urlMatch: e.target.value })}
              placeholder="/pricing"
              disabled={disabled}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="trigger-selector" className={labelClass}>
              Element selector
            </label>
            <input
              id="trigger-selector"
              value={triggers.selector ?? ''}
              onChange={(e) => onChange({ ...triggers, selector: e.target.value })}
              placeholder=".upgrade-button"
              disabled={disabled}
              className={cn(inputClass, 'font-mono')}
            />
          </div>
          <div>
            <label htmlFor="trigger-delay" className={labelClass}>
              Delay (ms)
            </label>
            <input
              id="trigger-delay"
              type="number"
              min={0}
              value={triggers.delayMs ?? ''}
              onChange={(e) =>
                onChange({
                  ...triggers,
                  delayMs: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)),
                })
              }
              placeholder="0"
              disabled={disabled}
              className={cn(inputClass, 'font-mono')}
            />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <span className={labelClass}>Frequency</span>
            <Select value={kind} onValueChange={(v) => setFrequencyKind(v as FrequencyKind)}>
              <SelectTrigger className="h-8 text-xs" disabled={disabled}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="once" className="text-xs">
                  Once per user
                </SelectItem>
                <SelectItem value="every_n_days" className="text-xs">
                  Every N days
                </SelectItem>
                <SelectItem value="always" className="text-xs">
                  Always
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === 'every_n_days' && (
            <div>
              <label htmlFor="trigger-n" className={labelClass}>
                Days between shows
              </label>
              <input
                id="trigger-n"
                type="number"
                min={1}
                value={everyN}
                onChange={(e) =>
                  onChange({
                    ...triggers,
                    frequency: { every_n_days: Math.max(1, Number(e.target.value) || 1) },
                  })
                }
                disabled={disabled}
                className={cn(inputClass, 'font-mono')}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

// ── Live preview pane ─────────────────────────────────────────────────────────

/**
 * Mounts the SDK's pure `renderSurvey` with the current draft definition and a
 * no-op response callback — the exact popover users will see, with NO config
 * fetch and NO `$survey_*` events. The popover is
 * shadow-DOM-isolated and pinned to the viewport corner (or centered) per the
 * chosen `appearance.position`; it re-mounts on every edit. Draft surveys never
 * reach `/v1/surveys`, so this is the only way to see a survey before enabling.
 */
function PreviewPane({ definition }: { definition: SurveyDefinitionUI }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [nonce, setNonce] = useState(0)

  // The SDK's `SurveyDefinition` uses a looser (index-signature) question shape;
  // our strict editor union is structurally compatible, so cast. Memoized on
  // `definition` so the mount effect re-runs on every edit (and only then).
  const previewDefinition = useMemo(
    () =>
      ({
        version: 1,
        questions: definition.questions,
        appearance: definition.appearance,
      }) as unknown as SdkSurveyDefinition,
    [definition],
  )

  // Re-mount whenever the definition changes or a manual replay is requested.
  // `renderSurvey` returns a `destroy()` handle we call on cleanup so old
  // popovers don't stack.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce intentionally forces a manual remount (Replay)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (previewDefinition.questions.length === 0) return
    const handle = renderSurvey(previewDefinition, {
      onResponse: () => {},
      container,
      // Preview remounts on every edit; never let it steal focus from the editor inputs.
      autoFocus: false,
    })
    return () => handle.destroy()
  }, [previewDefinition, nonce])

  return (
    <div className="shrink-0 overflow-auto border-t border-border bg-muted/10 md:w-[380px] md:border-t-0">
      <div className="space-y-3 p-4 md:p-6">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-muted-foreground">Live preview</span>
          <Button variant="outline" size="sm" onClick={() => setNonce((n) => n + 1)}>
            <RotateCcw className="h-3.5 w-3.5" />
            Replay
          </Button>
        </div>
        <p className="text-[10px] leading-snug text-muted-foreground">
          The real popover, rendered with your draft config — pinned to the viewport corner (or
          centered) as your users will see it. No events are sent.
        </p>
        {/* The shadow-DOM host mounts here; the popover itself is position:fixed. */}
        <div
          ref={containerRef}
          className="relative min-h-[180px] rounded-lg border border-dashed border-border/70"
        />
      </div>
    </div>
  )
}
