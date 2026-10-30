import { renderSupport, type SupportDefinition as SdkSupportDefinition } from '@clickroom/sdk-js'
import {
  Activity,
  AlertTriangle,
  BookOpen,
  Bot,
  Bug,
  Check,
  ChevronDown,
  ExternalLink,
  FileText,
  Flag,
  Globe,
  GripVertical,
  HelpCircle,
  LifeBuoy,
  Loader2,
  Lock,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Shield,
  Users,
  Webhook,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { PageHeader } from '@/components/PageHeader'
import { type HealthTone, StatusDot } from '@/components/StatusDot'
import { SkeletonCard } from '@/components/skeletons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { track } from '@/lib/analytics'
import { formatRelative } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useEntitlement } from '@/lib/use-entitlement'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'
import { useLinkedFlag } from '../surveys/useLinkedFlag'
import {
  APPEARANCE_DEFAULTS,
  type DropdownFieldUI,
  fromApiDefinition,
  LAYOUT_LABELS,
  newField,
  POSITION_LABELS,
  type SupportAppearanceUI,
  type SupportChannel,
  type SupportDefinitionUI,
  type SupportFieldType,
  type SupportFieldUI,
  type SupportFormRow,
  type SupportHeaderStyleUI,
  type SupportLauncherIconUI,
  type SupportLayoutUI,
  type SupportPositionUI,
  type SupportRoutingUI,
  type SupportSourceUI,
  type SupportStatus,
  type SupportTrackingUI,
  toApiDefinition,
  validateDefinition,
} from './types'

// ── Design constants (frame 1a) ───────────────────────────────────────────────
//
// Copy strings, ordering and the bespoke hexes below come verbatim from the
// prototype markup (`Clickroom Support.dc.html`). Values with no theme token
// (`#8a8aa6` secondary copy, `#4a4a63` icon-only glyphs) are written as Tailwind
// arbitrary values rather than rounded to the nearest token.

/** Channel segmented toggle — frame order + frame labels (`AI answer bot`, not `Answer bot`). */
const CHANNEL_ITEMS: readonly {
  value: SupportChannel
  label: string
  Icon: typeof MessageSquare
}[] = [
  { value: 'contact', label: 'Contact form', Icon: MessageSquare },
  { value: 'bot', label: 'AI answer bot', Icon: Bot },
  { value: 'bug', label: 'Bug report', Icon: Bug },
]

// `channel` is load-bearing, not cosmetic: capture-rs falls back to it when a ticket arrives
// without an explicit `type`, so `bug` is the only way an older SDK in the field can
// file a typed bug. `bot` still behaves exactly like `contact`.
const CHANNEL_NOTE =
  "All three share the same fields, sources, and tracking — the bot answers first, then hands off to the contact form when it can't resolve. Tickets from a Bug report form default to type Bug; contact and bot forms default to a conversation."

/** The frame's type-pill copy. `File`, not the `File upload` of `FIELD_TYPE_LABELS`. */
const TYPE_PILL_LABELS: Record<SupportFieldType, string> = {
  short_text: 'Short text',
  long_text: 'Long text',
  dropdown: 'Dropdown',
  email: 'Email',
  file: 'File',
}
const FIELD_TYPES: readonly SupportFieldType[] = [
  'short_text',
  'long_text',
  'dropdown',
  'email',
  'file',
]

const SOURCES_NOTE =
  'The AI bot answers from the crawled help center and KB articles, citing the source it used.'

const TRACKING_DESCRIPTION =
  'Every ticket carries who the user is and how they filled the form — no snippet changes needed, it rides on the events you already send.'

const AUTO_REPLY_NOTE = 'Bot attempts an answer; only unresolved tickets are routed.'

const PREVIEW_DISCLAIMER =
  'The real widget, rendered with your draft config as your users will see it. No tickets are created.'

// Shared atoms ---------------------------------------------------------------

/** 11px/500 `--mfg` section label. */
const sectionLabel = 'block text-[11px] font-medium text-muted-foreground'
/** Builder input: `rgba(26,26,40,.4)` fill, `7px 12px`, r6. */
const inputClass =
  'w-full rounded-lg border border-border bg-muted/40 px-3 py-[7px] text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60'
/** Header ghost button: transparent fill, `6px 12px`, r6, 12px/500. */
const ghostButton =
  'h-auto gap-1.5 rounded-lg border-border bg-transparent px-3 py-1.5 text-xs font-medium text-foreground hover:bg-transparent hover:opacity-85 dark:border-border dark:bg-transparent dark:hover:bg-transparent'
/** Header solid button: teal fill, `6px 14px`, r6, 12px/600. */
const solidButton = 'h-auto gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold'
/** Inline teal affordance ("Add field", "Connect source"). */
const inlineAction = 'flex items-center gap-[5px] text-[11px] text-primary hover:opacity-85'
/** `Select` trigger matched to `inputClass` geometry (r6, `7px 12px`, `bg-muted/40`). */
const selectTriggerClass =
  'h-auto w-full rounded-lg border-border bg-muted/40 px-3 py-[7px] text-xs text-foreground dark:bg-muted/40 dark:hover:bg-muted/40 [&>svg]:size-3 [&>svg]:text-muted-foreground [&>svg]:opacity-100'

const AUDIENCE_NOTE =
  'Eligibility rides on a linked feature flag: rollout %, environment and segment conditions are edited on the flag itself.'

const APPEARANCE_NOTE = 'Colours, layout and copy the widget renders with.'

export function SupportBuilderPage() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const { id } = useParams()
  const utils = trpc.useUtils()
  const { can } = useAuth()
  const canManage = can('projects:manage')

  const existing = trpc.support.get.useQuery(
    { projectId: projectId as string, id: id as string },
    { enabled: !!projectId && !!id },
  )
  const form = existing.data as unknown as SupportFormRow | undefined
  // The form's linked flag is the ONLY eligibility / rollout / segment mechanism
  // for a support form — same hook + posture as the surveys builder.
  const linkedFlag = useLinkedFlag(projectId, form?.featureFlagId)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<SupportStatus>('draft')
  const [definition, setDefinition] = useState<SupportDefinitionUI>(() =>
    fromApiDefinition(undefined),
  )
  const [hydrated, setHydrated] = useState(false)
  const [error, setError] = useState('')

  // Save and status changes are separate mutation instances so their pending
  // states don't bleed into each other's buttons.
  const save = trpc.support.update.useMutation()
  const statusChange = trpc.support.update.useMutation()

  // Serialized snapshot of the exact save payload — seeds the dirty baseline and
  // is compared against on every edit.
  const snapshot = useCallback(
    (n: string, d: string, def: SupportDefinitionUI) =>
      JSON.stringify({
        name: n.trim(),
        description: d.trim() || null,
        definition: toApiDefinition(def),
      }),
    [],
  )
  const baselineRef = useRef<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: hydrate once, keyed on form id
  useEffect(() => {
    if (form && !hydrated) {
      const def = fromApiDefinition(form.definition)
      setName(form.name)
      setDescription(form.description ?? '')
      setStatus(form.status)
      setDefinition(def)
      baselineRef.current = snapshot(form.name, form.description ?? '', def)
      setHydrated(true)
    }
  }, [form?.id, hydrated])

  const currentSig = useMemo(
    () => snapshot(name, description, definition),
    [snapshot, name, description, definition],
  )
  const isDirty = hydrated && baselineRef.current !== null && currentSig !== baselineRef.current

  function patchDefinition(patch: Partial<SupportDefinitionUI>) {
    setDefinition((d) => ({ ...d, ...patch }))
  }
  function updateField(index: number, next: SupportFieldUI) {
    setDefinition((d) => ({ ...d, fields: d.fields.map((f, i) => (i === index ? next : f)) }))
  }
  function addField() {
    setDefinition((d) => ({ ...d, fields: [...d.fields, newField('short_text')] }))
  }
  function removeField(index: number) {
    setDefinition((d) => ({ ...d, fields: d.fields.filter((_, i) => i !== index) }))
  }
  /** Move `from` to `to`, clamped. Drives both the drag handle and its arrow keys. */
  function reorderFields(from: number, to: number) {
    setDefinition((d) => {
      if (to < 0 || to >= d.fields.length || from === to) return d
      const next = [...d.fields]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return { ...d, fields: next }
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
      baselineRef.current = snapshot(name, description, definition)
      await utils.support.get.invalidate({ projectId, id })
      await utils.support.list.invalidate()
      toast.success('Support form saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save support form.')
    }
  }

  async function changeStatus(next: SupportStatus) {
    if (!projectId || !id || !canManage) return
    try {
      await statusChange.mutateAsync({ projectId, id, patch: { status: next } })
      setStatus(next)
      track('support_form_status_changed', { form_id: id, status: next })
      await utils.support.get.invalidate({ projectId, id })
      await utils.support.list.invalidate()
      toast.success(`Support form ${next === 'active' ? 'activated' : next}`)
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
        <PageHeader title="Edit support form" />
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
      <PageHeader title="Edit support form" subtitle={name || undefined}>
        <span className="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-semibold capitalize text-primary-foreground">
          {status}
        </span>
        {canManage && status === 'draft' && (
          <Button
            size="sm"
            className={solidButton}
            onClick={() => changeStatus('active')}
            disabled={statusChange.isPending}
          >
            {statusChange.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Enable form
          </Button>
        )}
        {canManage && status === 'active' && (
          <Button
            variant="outline"
            size="sm"
            className={ghostButton}
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
            className={ghostButton}
            onClick={() => changeStatus('archived')}
            disabled={statusChange.isPending}
          >
            Archive
          </Button>
        )}
        {canManage && status === 'archived' && (
          <Button
            variant="outline"
            size="sm"
            className={ghostButton}
            onClick={() => changeStatus('draft')}
            disabled={statusChange.isPending}
          >
            Restore
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className={ghostButton}
          onClick={() => navigate(`/support/${id}/inbox`)}
        >
          <Activity className="h-[13px] w-[13px]" />
          Inbox
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={ghostButton}
          onClick={() => navigate('/support')}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className={solidButton}
          onClick={handleSave}
          disabled={save.isPending || !canManage || !isDirty}
        >
          {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {isDirty ? 'Save changes' : 'Saved'}
        </Button>
      </PageHeader>

      {/* Two-pane: editor + live preview. Stacks to one column below md. */}
      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        <div className="min-w-0 flex-1 overflow-auto md:border-r md:border-border">
          <div className="flex flex-col gap-[22px] p-4 md:px-6 md:py-[22px]">
            {!canManage && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-amber-400">
                You don&apos;t have permission to edit support forms — changes won&apos;t be saved.
              </div>
            )}

            {/* 1 — Name / Description */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="support-name" className={cn(sectionLabel, 'mb-1.5')}>
                  Name
                </label>
                <input
                  id="support-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!canManage}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="support-desc" className={cn(sectionLabel, 'mb-1.5')}>
                  Description
                </label>
                <input
                  id="support-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional"
                  disabled={!canManage}
                  className={inputClass}
                />
              </div>
            </div>

            {/* 2 — Channel */}
            <ChannelToggle
              channel={definition.channel}
              disabled={!canManage}
              onChange={(channel) => patchDefinition({ channel })}
            />

            {/* 3 — Fields */}
            <FieldsSection
              fields={definition.fields}
              disabled={!canManage}
              onAdd={addField}
              onChange={updateField}
              onRemove={removeField}
              onReorder={reorderFields}
            />

            {/* 4 — Sources */}
            <SourcesSection sources={definition.sources} />

            {/* 5 — User tracking */}
            <TrackingCard
              tracking={definition.tracking}
              disabled={!canManage}
              onChange={(tracking) => patchDefinition({ tracking })}
            />

            {/* 6 — Routing */}
            <RoutingCard
              routing={definition.routing}
              projectId={projectId}
              disabled={!canManage}
              onChange={(routing) => patchDefinition({ routing })}
            />

            {/* 7 — Audience (not drawn by frame 1a; see the section's doc comment) */}
            <AudienceCard flag={linkedFlag} status={status} />

            {/* 8 — Appearance (not drawn by frame 1a; collapsed disclosure) */}
            <AppearanceSection
              appearance={definition.appearance}
              disabled={!canManage}
              onChange={(appearance) => patchDefinition({ appearance })}
            />

            {error && <p className="text-[11px] font-medium text-destructive">{error}</p>}
          </div>
        </div>

        <PreviewPane definition={definition} />
      </div>
    </div>
  )
}

// ── Shared bespoke controls ───────────────────────────────────────────────────

/** 34×20 pill toggle with a 16px `--background` knob (frame 1a, tracking + routing). */
function PillToggle({
  checked,
  disabled,
  label,
  className,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  className?: string
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-[34px] shrink-0 rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-switch-background',
        className,
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full bg-background transition-all',
          checked ? 'right-0.5' : 'left-0.5',
        )}
      />
    </button>
  )
}

/** 16px square checkbox: teal fill + `--background` check when on, hairline when off. */
function SquareCheckbox({
  checked,
  disabled,
  label,
  detail,
  note,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  detail: string
  /** Optional sub-copy rendered under the row — used by the opt-in tracking rows. */
  note?: string
  onChange: (next: boolean) => void
}) {
  return (
    <label
      className={cn(
        'flex gap-2.5 text-xs text-foreground',
        note ? 'items-start' : 'items-center',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
      )}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded-md border',
          note && 'mt-px',
          checked ? 'border-primary bg-primary' : 'border-white/[0.14] bg-transparent',
        )}
      >
        {checked && <Check className="h-2.5 w-2.5 text-primary-foreground" strokeWidth={3.5} />}
      </span>
      <span className="min-w-0">
        <span>
          {label}
          <span className="text-muted-foreground"> — {detail}</span>
        </span>
        {note && (
          <span className="mt-1 block text-[11px] leading-[1.5] text-[#8a8aa6]">{note}</span>
        )}
      </span>
    </label>
  )
}

// ── 2. Channel ────────────────────────────────────────────────────────────────

function ChannelToggle({
  channel,
  disabled,
  onChange,
}: {
  channel: SupportChannel
  disabled: boolean
  onChange: (c: SupportChannel) => void
}) {
  return (
    <section>
      <span className={cn(sectionLabel, 'mb-2')}>Channel</span>
      <div className="inline-flex flex-wrap gap-0.5 rounded-[8px] border border-border bg-muted p-[3px]">
        {CHANNEL_ITEMS.map(({ value, label, Icon }) => {
          const active = channel === value
          return (
            <button
              key={value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(value)}
              className={cn(
                'flex items-center gap-[7px] rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-60',
                active ? 'bg-primary text-primary-foreground' : 'text-foreground',
              )}
            >
              <Icon className="h-[13px] w-[13px]" strokeWidth={2} />
              {label}
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-[10px] leading-[1.5] text-muted-foreground">{CHANNEL_NOTE}</p>
    </section>
  )
}

// ── 3. Fields ─────────────────────────────────────────────────────────────────

function FieldsSection({
  fields,
  disabled,
  onAdd,
  onChange,
  onRemove,
  onReorder,
}: {
  fields: SupportFieldUI[]
  disabled: boolean
  onAdd: () => void
  onChange: (index: number, next: SupportFieldUI) => void
  onRemove: (index: number) => void
  onReorder: (from: number, to: number) => void
}) {
  const dragFrom = useRef<number | null>(null)

  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between">
        <span className={sectionLabel}>Fields ({fields.length})</span>
        {!disabled && (
          <button type="button" onClick={onAdd} className={inlineAction}>
            <Plus className="h-3 w-3" />
            Add field
          </button>
        )}
      </div>
      <p className="mb-2.5 text-xs text-muted-foreground">
        Subject and Message are always included — add any extra fields below.
      </p>
      <div className="flex flex-col gap-2.5">
        {fields.map((field, i) => (
          <FieldCard
            key={field.id}
            field={field}
            index={i}
            total={fields.length}
            disabled={disabled}
            onChange={(next) => onChange(i, next)}
            onRemove={() => onRemove(i)}
            onReorder={onReorder}
            dragFrom={dragFrom}
          />
        ))}
      </div>
    </section>
  )
}

/** The frame's per-field hint line. For editable types the hint IS the editable
 *  value (placeholder / choices), so the card stays a one-line row as designed. */
function fieldHint(field: SupportFieldUI): string {
  switch (field.type) {
    case 'dropdown':
      return field.choices.join(' · ')
    case 'file':
      return 'Optional image or file attachment'
    default:
      return field.placeholder ?? ''
  }
}

function fieldHintPlaceholder(field: SupportFieldUI): string {
  switch (field.type) {
    case 'dropdown':
      return 'Option A · Option B'
    case 'file':
      return ''
    default:
      return 'Hint shown under the field'
  }
}

function FieldCard({
  field,
  index,
  total,
  disabled,
  onChange,
  onRemove,
  onReorder,
  dragFrom,
}: {
  field: SupportFieldUI
  index: number
  total: number
  disabled: boolean
  onChange: (f: SupportFieldUI) => void
  onRemove: () => void
  onReorder: (from: number, to: number) => void
  dragFrom: React.MutableRefObject<number | null>
}) {
  function changeType(type: SupportFieldType) {
    // Preserve the id + label, reset type-specific fields.
    const fresh = newField(type)
    onChange({ ...fresh, id: field.id, label: field.label, required: field.required })
  }

  function changeHint(value: string) {
    if (field.type === 'dropdown') {
      const dropdown = field as DropdownFieldUI
      onChange({ ...dropdown, choices: value.split('·').map((c) => c.trim()) })
      return
    }
    if (field.type === 'file') return
    onChange({ ...field, placeholder: value })
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target for the row's own drag handle; keyboard reorder lives on that (focusable) handle
    <div
      onDragOver={(e) => {
        if (dragFrom.current !== null) e.preventDefault()
      }}
      onDrop={(e) => {
        e.preventDefault()
        if (dragFrom.current !== null) onReorder(dragFrom.current, index)
        dragFrom.current = null
      }}
      className="flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3"
    >
      <button
        type="button"
        draggable={!disabled}
        onDragStart={() => {
          dragFrom.current = index
        }}
        onDragEnd={() => {
          dragFrom.current = null
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            onReorder(index, index - 1)
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            onReorder(index, index + 1)
          }
        }}
        disabled={disabled}
        aria-label={`Reorder ${field.label || 'field'} (${index + 1} of ${total})`}
        className="shrink-0 cursor-grab text-[#4a4a63] active:cursor-grabbing disabled:cursor-not-allowed"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <input
            value={field.label}
            onChange={(e) => onChange({ ...field, label: e.target.value })}
            placeholder="Field label"
            disabled={disabled}
            aria-label="Field label"
            className="min-w-0 max-w-full bg-transparent text-[13px] font-medium text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground"
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...field, required: !field.required })}
            className={cn(
              'shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-semibold',
              field.required
                ? 'bg-destructive/[.12] text-destructive'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {field.required ? 'Required' : 'Optional'}
          </button>
        </div>
        <input
          value={fieldHint(field)}
          onChange={(e) => changeHint(e.target.value)}
          placeholder={fieldHintPlaceholder(field)}
          readOnly={field.type === 'file'}
          disabled={disabled}
          aria-label="Field hint"
          className="mt-0.5 w-full bg-transparent text-[11px] text-muted-foreground outline-none placeholder:text-muted-foreground/60"
        />
      </div>

      <Select
        value={field.type}
        onValueChange={(v) => changeType(v as SupportFieldType)}
        disabled={disabled}
      >
        <SelectTrigger className="h-auto w-auto shrink-0 gap-2 rounded-lg border-border bg-muted px-2.5 py-[5px] text-[11px] text-[#8a8aa6] dark:bg-muted dark:hover:bg-muted [&>svg]:size-3 [&>svg]:text-muted-foreground [&>svg]:opacity-100">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FIELD_TYPES.map((t) => (
            <SelectItem key={t} value={t} className="text-xs">
              {TYPE_PILL_LABELS[t]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Remove field"
        className="shrink-0 cursor-pointer text-[#4a4a63] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

// ── 4. Sources ────────────────────────────────────────────────────────────────

const SOURCE_STYLE: Record<
  SupportSourceUI['type'],
  { Icon: typeof Globe; tint: string; stroke: string; status: string }
> = {
  url: { Icon: Globe, tint: 'bg-chart-5/[.14]', stroke: 'text-chart-5', status: 'Connected' },
  sitemap: {
    Icon: BookOpen,
    tint: 'bg-chart-2/[.14]',
    stroke: 'text-chart-2',
    status: 'Connected',
  },
  text: { Icon: FileText, tint: 'bg-chart-3/[.12]', stroke: 'text-chart-3', status: 'Published' },
}

function SourcesSection({ sources }: { sources: SupportSourceUI[] }) {
  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between">
        <span className={sectionLabel}>Sources</span>
        <button
          type="button"
          onClick={() => toast.info('Source crawling ships with the answer-bot phase.')}
          className={inlineAction}
        >
          <Plus className="h-3 w-3" />
          Connect source
        </button>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {sources.length === 0 ? (
          <div className="border-b border-border px-3.5 py-3 text-[11px] text-muted-foreground">
            No sources connected yet.
          </div>
        ) : (
          sources.map((source) => {
            const { Icon, tint, stroke, status } = SOURCE_STYLE[source.type]
            return (
              <div
                key={source.id}
                className="flex items-center gap-3 border-b border-border px-3.5 py-3"
              >
                <span
                  className={cn(
                    'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px]',
                    tint,
                  )}
                >
                  <Icon className={cn('h-[15px] w-[15px]', stroke)} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-foreground">
                    {source.label ?? source.value}
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {source.value}
                  </div>
                </div>
                <span className="flex shrink-0 items-center gap-[5px] text-[11px] text-primary">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  {status}
                </span>
                <MoreHorizontal className="h-3.5 w-3.5 shrink-0 cursor-pointer text-[#4a4a63]" />
              </div>
            )
          })
        )}
        <div className="flex items-center gap-2 bg-primary/[.04] px-3.5 py-2.5">
          <Shield className="h-[13px] w-[13px] shrink-0 text-primary" />
          <span className="text-[11px] text-[#8a8aa6]">{SOURCES_NOTE}</span>
        </div>
      </div>
    </section>
  )
}

// ── 5. User tracking ──────────────────────────────────────────────────────────

type TrackingRow = {
  key: keyof SupportTrackingUI
  label: string
  detail: string
  note?: string
  locked?: boolean
}

/** Swept on/off together by the "Attach user context" master toggle. */
const TRACKING_ROWS: readonly TrackingRow[] = [
  { key: 'identity', label: 'Identity', detail: 'user id, email, plan' },
  {
    key: 'formAnalytics',
    label: 'Form-filling analytics',
    detail: 'field focus order, edits, drop-off',
  },
  {
    key: 'recentEvents',
    label: 'Recent events timeline',
    detail: 'last 20 actions before submitting',
  },
]

/** Off by default and never touched by the master toggle — each is an explicit opt-in. */
const TRACKING_OPT_IN_ROWS: readonly TrackingRow[] = [
  {
    key: 'bugContext',
    label: 'Bug context',
    detail: 'evidence attached to bug reports',
    note: 'Captures the page URL, browser / OS / viewport, recent console errors and recent failed requests at the moment the report is submitted. URLs and messages are redacted for tokens, keys and passwords in the browser before anything is sent.',
  },
  // No replay product yet — renders as a permanently unchecked row.
  { key: 'sessionReplay', label: 'Session replay link', detail: 'add-on', locked: true },
]

function TrackingCard({
  tracking,
  disabled,
  onChange,
}: {
  tracking: SupportTrackingUI
  disabled: boolean
  onChange: (t: SupportTrackingUI) => void
}) {
  // The frame's master toggle has no field of its own: it reads as "any context
  // attached" and clears / restores the three real switches.
  const anyOn = tracking.identity || tracking.formAnalytics || tracking.recentEvents

  return (
    <section>
      <span className={cn(sectionLabel, 'mb-2.5')}>User tracking</span>
      <div className="rounded-xl border border-primary/[.22] bg-primary/5 p-3.5">
        <div className="flex items-start gap-3">
          <PillToggle
            checked={anyOn}
            disabled={disabled}
            label="Attach user context"
            className="mt-px"
            onChange={(next) =>
              onChange({
                ...tracking,
                identity: next,
                formAnalytics: next,
                recentEvents: next,
              })
            }
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-foreground">Attach user context</span>
              <span className="rounded-md bg-primary/[.14] px-[7px] py-0.5 text-[9px] font-semibold text-primary">
                On by default
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-[1.5] text-[#8a8aa6]">{TRACKING_DESCRIPTION}</p>
            <div className="mt-3 flex flex-col gap-2">
              {TRACKING_ROWS.map((row) => (
                <SquareCheckbox
                  key={row.key}
                  checked={row.locked ? false : tracking[row.key]}
                  disabled={disabled || row.locked}
                  label={row.label}
                  detail={row.detail}
                  onChange={(next) => onChange({ ...tracking, [row.key]: next })}
                />
              ))}
            </div>
            <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3">
              <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Off by default
              </span>
              {TRACKING_OPT_IN_ROWS.map((row) => (
                <SquareCheckbox
                  key={row.key}
                  checked={row.locked ? false : tracking[row.key]}
                  disabled={disabled || row.locked}
                  label={row.label}
                  detail={row.detail}
                  note={row.note}
                  onChange={(next) => onChange({ ...tracking, [row.key]: next })}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ── 6. Routing ────────────────────────────────────────────────────────────────

const WEBHOOK_SETTINGS_PATH = '/settings/webhooks'

/**
 * Frame `6c`'s "New webhook" / "Manage webhooks" affordances open Settings in a
 * NEW TAB rather than navigating: the builder holds unsaved definition state and
 * a router push would throw it away mid-edit.
 */
function openWebhookSettings() {
  window.open(WEBHOOK_SETTINGS_PATH, '_blank', 'noopener')
}

/** Frame `7a`'s routed delivery history, replacing the `5b` overlay. */
function deliveriesPath(webhookId: string): string {
  return `${WEBHOOK_SETTINGS_PATH}/${webhookId}/deliveries`
}

/** `formatRelative` takes a string; the health rollup's timestamp arrives as a Date. */
function relativeOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : formatRelative(parsed.toISOString())
}

/** One `5a` destination row's right-aligned meta: `3 failed` beats `2m ago`. */
function destinationMeta(health: RoutingHealth | undefined): string {
  if (health && health.failures > 0) return `${health.failures} failed`
  return relativeOrNull(health?.lastDeliveryAt) ?? 'Never delivered'
}

type RoutingHealth = {
  webhookId: string
  considered: number
  failures: number
  p95LatencyMs: number | null
  lastDeliveryAt: Date | string | null
  health: HealthTone
}

const destinationRowBase =
  'flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg border px-2.5 py-2 sm:flex-nowrap'

/**
 * Frame `5a`: a full-width row carrying health, not a truncated pill. The tone
 * comes from the single project-wide `webhooks.health` query — a webhook with no
 * deliveries has no row there at all, which is `idle` (constraint 8: never a
 * per-destination `deliveries` call).
 */
function DestinationRow({
  url,
  health,
  disabled,
  historyHref,
  onRemove,
}: {
  url: string
  health: RoutingHealth | undefined
  disabled: boolean
  historyHref: string
  onRemove: () => void
}) {
  const tone = health?.health ?? 'idle'
  const failing = tone === 'failing'

  return (
    <div
      className={cn(
        destinationRowBase,
        failing ? 'border-red-500/30 bg-red-500/5' : 'border-border bg-muted/40',
      )}
    >
      <Webhook
        className={cn(
          'h-[15px] w-[15px] shrink-0',
          failing ? 'text-red-400' : 'text-muted-foreground',
        )}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground sm:flex-none sm:max-w-[220px]">
        {url}
      </span>
      <StatusDot tone={tone} />
      <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
        {destinationMeta(health)}
      </span>
      {/* A real link, not an overlay (frame `7a`) — and a NEW TAB for the same
          reason `Manage webhooks →` / `New webhook` open one: the builder holds
          unsaved definition state (`isDirty`) that a router push would discard
          mid-edit. `Link`/`navigate` is deliberately not used here. */}
      <a
        href={historyHref}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 cursor-pointer text-[11px] text-teal-400 hover:underline"
      >
        History
      </a>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Remove destination"
        className="shrink-0 cursor-pointer text-[#4a4a63] disabled:cursor-not-allowed"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

/**
 * Deleting a webhook deliberately leaves its id behind in every form definition
 * that routed to it — the forms keep creating tickets and post nowhere. Rendering
 * the bare id (the earlier behaviour) showed the customer a cuid and no
 * explanation; this row says what happened and what to do about it.
 */
function DeletedDestinationRow({
  disabled,
  onRemove,
}: {
  disabled: boolean
  onRemove: () => void
}) {
  return (
    <div className={cn(destinationRowBase, 'border-red-500/30 bg-red-500/5')}>
      <AlertTriangle className="h-[15px] w-[15px] shrink-0 text-red-400" />
      <span className="min-w-0 flex-1 text-xs text-red-400">
        Endpoint deleted — remove this destination
      </span>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Remove destination"
        className="ml-auto shrink-0 cursor-pointer text-[#4a4a63] disabled:cursor-not-allowed"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

/** Frame `6c`: the dead end replaced by a real next step. */
function NoWebhooksEmptyState() {
  return (
    <div className="px-3 py-4 text-center">
      <Webhook className="mx-auto mb-2 h-5 w-5 text-[#4a4a63]" />
      <p className="text-[12.5px] font-medium text-foreground">No webhooks yet</p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Create an endpoint to route new tickets to Slack, your API, or an inbox.
      </p>
      <Button size="sm" className="mt-3 h-7 gap-1.5 text-[11.5px]" onClick={openWebhookSettings}>
        <Plus className="h-3 w-3" />
        New webhook
      </Button>
      <p className="mt-2 text-[10.5px] text-muted-foreground">
        Opens Settings › Webhooks in a new tab
      </p>
    </div>
  )
}

function RoutingCard({
  routing,
  projectId,
  disabled,
  onChange,
}: {
  routing: SupportRoutingUI
  projectId: string
  disabled: boolean
  onChange: (r: SupportRoutingUI) => void
}) {
  const webhooksQuery = trpc.support.webhooks.list.useQuery({ projectId })
  // ONE health read for the whole project alongside ONE list — constraint 8.
  const healthQuery = trpc.support.webhooks.health.useQuery({ projectId })
  const webhooks = webhooksQuery.data ?? []
  const healthById = useMemo(
    () => new Map((healthQuery.data ?? []).map((row) => [row.webhookId, row])),
    [healthQuery.data],
  )
  const selected = new Set(routing.destinations.map((d) => d.webhookId))
  const available = webhooks.filter((hook) => !selected.has(hook.id))

  function add(webhookId: string) {
    onChange({ ...routing, destinations: [...routing.destinations, { webhookId }] })
  }
  function remove(webhookId: string) {
    onChange({
      ...routing,
      destinations: routing.destinations.filter((d) => d.webhookId !== webhookId),
    })
  }

  // Survives for the "Add destination" trigger only — the destinations
  // themselves are full-width rows now (`5a`).
  const pillBox =
    'inline-flex items-center gap-[7px] rounded-lg border border-border px-2.5 py-1.5 font-mono text-xs'

  return (
    <section>
      <span className={cn(sectionLabel, 'mb-2.5')}>Routing</span>
      <div className="flex flex-col gap-3.5 rounded-xl border border-border bg-card p-3.5">
        <div>
          <span className={cn(sectionLabel, 'mb-1.5')}>New tickets go to</span>
          {webhooksQuery.isPending ? (
            <SkeletonCard lines={1} title={false} className="border-border/60" />
          ) : (
            <div className="flex flex-col gap-2">
              {routing.destinations.map((dest) => {
                const hook = webhooks.find((h) => h.id === dest.webhookId)
                if (!hook) {
                  return (
                    <DeletedDestinationRow
                      key={dest.webhookId}
                      disabled={disabled}
                      onRemove={() => remove(dest.webhookId)}
                    />
                  )
                }
                return (
                  <DestinationRow
                    key={dest.webhookId}
                    url={hook.url}
                    health={healthById.get(hook.id)}
                    disabled={disabled}
                    historyHref={deliveriesPath(hook.id)}
                    onRemove={() => remove(dest.webhookId)}
                  />
                )
              })}
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={disabled}
                  className={cn(
                    pillBox,
                    'cursor-pointer gap-1.5 self-start bg-transparent text-muted-foreground disabled:cursor-not-allowed',
                  )}
                >
                  <Plus className="h-3 w-3" />
                  Add destination
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-[264px] max-w-[calc(100vw-2rem)] sm:max-w-[280px]"
                >
                  {webhooks.length === 0 ? (
                    <NoWebhooksEmptyState />
                  ) : (
                    <>
                      {available.length === 0 ? (
                        <DropdownMenuItem disabled className="text-xs">
                          Every webhook is already a destination
                        </DropdownMenuItem>
                      ) : (
                        available.map((hook) => (
                          <DropdownMenuItem
                            key={hook.id}
                            onSelect={() => add(hook.id)}
                            className="truncate font-mono text-xs"
                          >
                            {hook.url}
                            {!hook.active && ' (paused)'}
                          </DropdownMenuItem>
                        ))
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={openWebhookSettings} className="text-xs">
                        Manage webhooks →
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border pt-3">
          <PillToggle
            checked={routing.autoReply}
            disabled={disabled}
            label="AI auto-reply before routing"
            onChange={(autoReply) => onChange({ ...routing, autoReply })}
          />
          <div className="min-w-0">
            <span className="text-[13px] text-foreground">AI auto-reply before routing</span>
            <p className="mt-0.5 text-[11px] text-[#8a8aa6]">{AUTO_REPLY_NOTE}</p>
          </div>
        </div>
      </div>
    </section>
  )
}

// ── 7. Audience (linked flag) ─────────────────────────────────────────────────
//
// Frame 1a draws no Audience section, but the linked `FeatureFlag` is the only
// eligibility / rollout / segment mechanism a support form has, so
// dropping it left no way to target a form from the UI at all. It sits AFTER the
// frame's six sections and is read-only by design — the flag's rollout %, env and
// segment conditions are edited on the flag page, exactly as in the surveys
// builder — so it has no state of its own to dirty-track.

function AudienceCard({
  flag,
  status,
}: {
  flag: { key: string; env: string; active: boolean } | null
  status: SupportStatus
}) {
  return (
    <section>
      <span className={cn(sectionLabel, 'mb-2.5')}>Audience</span>
      <div className="flex flex-col gap-3.5 rounded-xl border border-border bg-card p-3.5">
        <div className="flex items-start gap-3">
          <Users className="mt-0.5 h-[15px] w-[15px] shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-foreground">Everyone</span>
              <span className="rounded-md bg-primary/[.14] px-[7px] py-0.5 text-[9px] font-semibold text-primary">
                {status === 'active' ? 'Live' : 'Not live yet'}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-[1.5] text-[#8a8aa6]">
              {status === 'active'
                ? 'Shown to everyone the linked flag lets through. '
                : 'When enabled, shown to everyone the linked flag lets through. '}
              {AUDIENCE_NOTE}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {flag ? (
            <>
              <span className="inline-flex items-center gap-[7px] rounded-lg border border-border bg-muted px-2.5 py-1.5 font-mono text-xs text-foreground">
                <Flag className="h-[13px] w-[13px] shrink-0 text-muted-foreground" />
                <span className="max-w-[220px] truncate">{flag.key}</span>
              </span>
              <span className="flex shrink-0 items-center gap-[5px] text-[11px] text-muted-foreground">
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    flag.active ? 'bg-primary' : 'bg-[#4a4a63]',
                  )}
                />
                {flag.active ? 'Flag enabled' : 'Flag disabled'} · {flag.env}
              </span>
              <Link
                to={`/flags/${encodeURIComponent(flag.key)}?env=${flag.env}`}
                className={cn(inlineAction, 'ml-auto')}
              >
                Rollout &amp; segments
                <ExternalLink className="h-3 w-3" />
              </Link>
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">Resolving linked flag…</span>
          )}
        </div>
      </div>
    </section>
  )
}

// ── 8. Appearance ─────────────────────────────────────────────────────────────
//
// Also absent from frame 1a. `definition.appearance` round-trips through
// `fromApiDefinition`/`toApiDefinition` either way, but the SDK's `renderSupport`
// reads every field below, so without this the widget's brand + copy were
// uneditable. Rendered as a collapsed disclosure in the same card idiom so the
// frame's six sections keep the page's visual hierarchy; edits flow through
// `patchDefinition`, so it participates in dirty tracking like any other section.

const LAYOUTS: readonly SupportLayoutUI[] = ['launcher', 'slide_out', 'modal', 'inline']
const POSITIONS: readonly SupportPositionUI[] = ['bottom_right', 'bottom_left', 'center']

/** Launcher glyph segmented control — icon + a11y label per option. */
const LAUNCHER_ICONS: readonly {
  value: SupportLauncherIconUI
  label: string
  Icon: typeof MessageSquare
}[] = [
  { value: 'message', label: 'Message', Icon: MessageSquare },
  { value: 'help', label: 'Help', Icon: LifeBuoy },
  { value: 'chat', label: 'Chat', Icon: MessageCircle },
  { value: 'question', label: 'Question', Icon: HelpCircle },
]

const HEADER_STYLES: readonly { value: SupportHeaderStyleUI; label: string }[] = [
  { value: 'accent', label: 'Accent' },
  { value: 'plain', label: 'Plain' },
]

/**
 * `hideBranding` (remove the "Powered by Clickroom" footer) is a white-label
 * perk. The whole Support product is already gated by `feature:support` (pro+),
 * so the branding toggle needs a *stricter* gate to be meaningful — `feature:sso`
 * is the only enforced enterprise-exclusive entitlement, which lines white-label
 * up with the enterprise tier.
 * // TODO confirm entitlement key — replace with a dedicated `removeBranding` /
 * // `whiteLabel` PlanFeatures key once one exists in the plan registry.
 */
const HIDE_BRANDING_ACTION = 'feature:sso' as const

const DEFAULT_FONT_STACK = 'Inter, system-ui, -apple-system, sans-serif'

/** Small segmented (radio-group) toggle — reused for launcher icon + header style. */
function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string; Icon?: typeof MessageSquare }[]
  disabled: boolean
  onChange: (next: T) => void
}) {
  return (
    <div>
      <span className={cn(sectionLabel, 'mb-1.5')}>{label}</span>
      <div className="inline-flex flex-wrap gap-0.5 rounded-[8px] border border-border bg-muted p-[3px]">
        {options.map(({ value: v, label: l, Icon }) => {
          const active = v === value
          return (
            <button
              key={v}
              type="button"
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onChange(v)}
              className={cn(
                'flex items-center gap-[6px] rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-60',
                active ? 'bg-primary text-primary-foreground' : 'text-foreground',
              )}
            >
              {Icon && <Icon className="h-[13px] w-[13px]" strokeWidth={2} />}
              {l}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Labelled slider with a live px readout. */
function SliderRow({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  unit = 'px',
  hint,
  disabled,
  onChange,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  hint?: string
  disabled: boolean
  onChange: (next: number) => void
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label htmlFor={id} className={sectionLabel}>
          {label}
        </label>
        <span className="font-mono text-[11px] text-muted-foreground">
          {value}
          {unit}
        </span>
      </div>
      <Slider
        id={id}
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={label}
        onValueChange={([next]) => onChange(next)}
      />
      {hint && <p className="mt-1 text-[10px] leading-[1.5] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function AppearanceSection({
  appearance,
  disabled,
  onChange,
}: {
  appearance: SupportAppearanceUI
  disabled: boolean
  onChange: (a: SupportAppearanceUI) => void
}) {
  const brandingEntitlement = useEntitlement(HIDE_BRANDING_ACTION)
  // Never let the flag be true when the plan can't remove branding — the server
  // is authority, but a value it would reject shouldn't round-trip either.
  const canHideBranding = brandingEntitlement.allowed
  // Inline forms fill a host container: no floating launcher and no anchored
  // position, so the position + launcher/panel geometry controls are no-ops.
  const isInline = appearance.layout === 'inline'
  const field = (
    id: string,
    label: string,
    value: string | undefined,
    placeholder: string,
    key: keyof SupportAppearanceUI,
    mono = false,
  ) => (
    <div>
      <label htmlFor={id} className={cn(sectionLabel, 'mb-1.5')}>
        {label}
      </label>
      <input
        id={id}
        value={value ?? ''}
        onChange={(e) => onChange({ ...appearance, [key]: e.target.value })}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(inputClass, mono && 'font-mono')}
      />
    </div>
  )

  return (
    <details className="group rounded-xl border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-3 [&::-webkit-details-marker]:hidden">
        <span className={sectionLabel}>Appearance</span>
        <span className="text-[11px] text-[#8a8aa6]">{APPEARANCE_NOTE}</span>
        <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-[#4a4a63] transition-transform group-open:rotate-180" />
      </summary>

      <div className="flex flex-col gap-3.5 border-t border-border px-3.5 py-3.5">
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <div>
            <span className={cn(sectionLabel, 'mb-1.5')}>Layout</span>
            <Select
              value={appearance.layout}
              disabled={disabled}
              onValueChange={(v) => onChange({ ...appearance, layout: v as SupportLayoutUI })}
            >
              <SelectTrigger className={selectTriggerClass} aria-label="Layout">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LAYOUTS.map((l) => (
                  <SelectItem key={l} value={l} className="text-xs">
                    {LAYOUT_LABELS[l]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <span className={cn(sectionLabel, 'mb-1.5')}>Position</span>
            <Select
              value={appearance.position}
              disabled={disabled || isInline}
              onValueChange={(v) => onChange({ ...appearance, position: v as SupportPositionUI })}
            >
              <SelectTrigger className={selectTriggerClass} aria-label="Position">
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
        </div>

        {isInline && (
          <p className="text-[10px] leading-[1.5] text-muted-foreground">
            Inline forms render as a full page inside your own layout — they have no launcher and no
            position, so those controls are disabled.
          </p>
        )}

        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {field(
            'support-primary-color',
            'Accent colour',
            appearance.primaryColor,
            '#4F46E5',
            'primaryColor',
            true,
          )}
          {field(
            'support-bg-color',
            'Background colour',
            appearance.backgroundColor,
            '#ffffff',
            'backgroundColor',
            true,
          )}
          {field(
            'support-text-color',
            'Text colour',
            appearance.textColor,
            '#0f172a',
            'textColor',
            true,
          )}
        </div>

        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {field(
            'support-launcher-label',
            'Launcher label',
            appearance.launcherLabel,
            'Help',
            'launcherLabel',
          )}
          {/* Empty greeting is meaningful: `renderSupport` then falls back to each
              layout's own frame title (1b "Help & Contact" vs 1d "How can we help?"). */}
          {field(
            'support-greeting',
            'Greeting',
            appearance.greeting,
            "Blank — use the layout's own title",
            'greeting',
          )}
        </div>

        {/* Launcher & panel geometry ------------------------------------ */}
        <div className="border-t border-border pt-3.5">
          <span className={cn(sectionLabel, 'mb-2.5 block text-foreground/80')}>
            Launcher &amp; panel
          </span>
          <div className="flex flex-col gap-3.5">
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <Segmented
                label="Launcher icon"
                value={appearance.launcherIcon ?? APPEARANCE_DEFAULTS.launcherIcon}
                options={LAUNCHER_ICONS}
                disabled={disabled || isInline}
                onChange={(launcherIcon) => onChange({ ...appearance, launcherIcon })}
              />
              <Segmented
                label="Header style"
                value={appearance.headerStyle ?? APPEARANCE_DEFAULTS.headerStyle}
                options={HEADER_STYLES}
                disabled={disabled}
                onChange={(headerStyle) => onChange({ ...appearance, headerStyle })}
              />
            </div>

            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <SliderRow
                id="support-launcher-size"
                label="Launcher size"
                value={appearance.launcherSize ?? APPEARANCE_DEFAULTS.launcherSize}
                min={40}
                max={72}
                disabled={disabled || isInline}
                onChange={(launcherSize) => onChange({ ...appearance, launcherSize })}
              />
              <SliderRow
                id="support-corner-radius"
                label="Corner radius"
                value={appearance.cornerRadius ?? APPEARANCE_DEFAULTS.cornerRadius}
                min={0}
                max={24}
                disabled={disabled}
                onChange={(cornerRadius) => onChange({ ...appearance, cornerRadius })}
              />
              <SliderRow
                id="support-panel-width"
                label="Panel width"
                value={appearance.panelWidth ?? APPEARANCE_DEFAULTS.panelWidth}
                min={300}
                max={480}
                hint="Only affects the launcher layout."
                disabled={disabled || isInline}
                onChange={(panelWidth) => onChange({ ...appearance, panelWidth })}
              />
            </div>
          </div>
        </div>

        {/* Typography --------------------------------------------------- */}
        {field(
          'support-font-family',
          'Font family',
          appearance.fontFamily,
          DEFAULT_FONT_STACK,
          'fontFamily',
          true,
        )}

        {/* Branding (entitlement-gated) --------------------------------- */}
        <div className="flex items-start gap-3 border-t border-border pt-3.5">
          <PillToggle
            checked={canHideBranding ? Boolean(appearance.hideBranding) : false}
            disabled={disabled || !canHideBranding}
            label="Remove Clickroom branding"
            className="mt-px"
            onChange={(hideBranding) => {
              if (!canHideBranding) return
              onChange({ ...appearance, hideBranding })
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-foreground">
                Remove Clickroom branding
              </span>
              {!canHideBranding && (
                <span className="inline-flex items-center gap-1 rounded-md bg-muted px-[7px] py-0.5 text-[9px] font-semibold text-muted-foreground">
                  <Lock className="h-2.5 w-2.5" />
                  {brandingEntitlement.upgradeTo === 'enterprise' ? 'Enterprise' : 'Upgrade'}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] leading-[1.5] text-[#8a8aa6]">
              {canHideBranding
                ? 'Hides the “Powered by Clickroom” footer in the widget.'
                : 'Removing the “Powered by Clickroom” footer is available on higher plans. Contact your Clickroom rep to upgrade.'}
            </p>
          </div>
        </div>

        {field(
          'support-thanks',
          'Confirmation message',
          appearance.thanksMessage,
          "Thanks! We've got your message and will get back to you shortly.",
          'thanksMessage',
        )}
      </div>
    </details>
  )
}

// ── Live preview pane ─────────────────────────────────────────────────────────

const PREVIEW_DEBOUNCE_MS = 350

/**
 * Mounts the SDK's pure `renderSupport` with the current draft definition and
 * no-op callbacks — the exact widget users will see, with NO config fetch and
 * NO `$support_*` events. Debounced so typing a label doesn't
 * tear down and rebuild the shadow root on every keystroke.
 *
 * The mock browser is the mount container AND carries `transform-gpu`: a
 * transformed ancestor becomes the containing block for the widget's
 * `position: fixed` root, so the launcher/panel land inside the mock viewport
 * exactly as the frame draws them instead of over the dashboard.
 */
function PreviewPane({ definition }: { definition: SupportDefinitionUI }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [nonce, setNonce] = useState(0)
  const [debounced, setDebounced] = useState(definition)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(definition), PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [definition])

  // The SDK's `SupportDefinition` uses a looser (index-signature) field shape;
  // our strict editor union is structurally compatible, so cast.
  const previewDefinition = useMemo(() => debounced as unknown as SdkSupportDefinition, [debounced])

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce intentionally forces a manual remount (Replay)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // Structural Subject + Message always render, so an empty `fields` array is a valid form and
    // must still preview — only bail if the definition is malformed (no fields array at all).
    if (!Array.isArray(previewDefinition.fields)) return
    const handle = renderSupport(previewDefinition, {
      // Emits NOTHING. Resolving with an object advances the widget to its
      // `confirmed` state so the whole flow is previewable.
      onSubmit: () => ({}),
      container,
      // Preview remounts on every (debounced) edit; never let it steal focus
      // from the editor inputs.
      autoFocus: false,
    })
    return () => handle.destroy()
  }, [previewDefinition, nonce])

  return (
    <div className="w-full shrink-0 overflow-auto border-t border-border bg-[rgba(26,26,40,0.12)] md:w-[400px] md:border-t-0">
      <div className="flex flex-col gap-3.5 p-4 md:px-6 md:py-[22px]">
        <div className="flex items-center justify-between">
          <span className={sectionLabel}>Live preview</span>
          <Button
            variant="outline"
            size="sm"
            className={cn(ghostButton, 'gap-1.5 px-[11px] py-[5px]')}
            onClick={() => setNonce((n) => n + 1)}
          >
            <RotateCcw className="h-[13px] w-[13px]" />
            Replay
          </Button>
        </div>
        <p className="text-[10px] leading-[1.5] text-muted-foreground">{PREVIEW_DISCLAIMER}</p>

        {/* Mock browser — also the widget's mount container (see doc comment). */}
        <div className="h-[560px] transform-gpu overflow-hidden rounded-xl border border-dashed border-white/[0.12] bg-[#f5f6f8]">
          <div className="flex h-[26px] items-center gap-[5px] border-b border-[#d7dae1] bg-[#e7e9ee] px-2.5">
            <span className="h-2 w-2 rounded-full bg-[#e06055]" />
            <span className="h-2 w-2 rounded-full bg-[#e9b23c]" />
            <span className="h-2 w-2 rounded-full bg-[#54b04a]" />
            <span className="ml-2 font-mono text-[9px] text-[#8a90a0]">app.acme.co/dashboard</span>
          </div>
          <div ref={containerRef} className="relative p-4">
            <div className="h-2.5 w-2/5 rounded bg-[#e2e5ea]" />
            <div className="mt-2.5 h-2 w-[70%] rounded bg-[#eaecf1]" />
            <div className="mt-[7px] h-2 w-3/5 rounded bg-[#eaecf1]" />
            <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="h-[52px] rounded-lg bg-[#eef0f4]" />
              <div className="h-[52px] rounded-lg bg-[#eef0f4]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
