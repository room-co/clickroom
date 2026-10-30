import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import type { FeatureFlagRow } from './FlagBits'
import {
  type BooleanRule,
  buildBooleanFlagFilters,
  buildValueFlagFilters,
  FLAG_OPERATORS,
  type FlagFilters,
  type FlagKind,
  type FlagOperator,
  type FlagProperty,
  flagKind,
  flagValueSet,
  OPERATOR_LABELS,
  parseBooleanFlagFilters,
  servingSummary,
  toFlagFilters,
  VALUELESS_OPERATORS,
} from './types'

type ValueEntry = { key: string; value: string | number }
type ValueRule = { properties: FlagProperty[]; variant: string }

/** Trim/normalize a condition list before persisting or previewing. */
function cleanProperties(props: FlagProperty[]): FlagProperty[] {
  return props
    .filter((p) => p.key.trim() !== '')
    .map((p) => ({
      key: p.key.trim(),
      operator: p.operator,
      value: VALUELESS_OPERATORS.has(p.operator) ? null : (p.value ?? ''),
    }))
}

/** One AND-condition row (property / operator / value). `readOnly` disables all
 * inputs and hides the remove control for viewers. */
function PropertyConditionRow({
  property,
  index,
  onChange,
  onRemove,
  readOnly = false,
}: {
  property: FlagProperty
  index: number
  onChange: (patch: Partial<FlagProperty>) => void
  onRemove: () => void
  readOnly?: boolean
}) {
  const valueless = VALUELESS_OPERATORS.has(property.operator)
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <span
        className={cn(
          'w-7 shrink-0 font-mono text-[10px] font-medium',
          index === 0 ? 'text-muted-foreground/40' : 'text-amber-400',
        )}
      >
        {index === 0 ? 'IF' : 'AND'}
      </span>
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <input
          value={property.key}
          onChange={(e) => onChange({ key: e.target.value })}
          placeholder="property"
          disabled={readOnly}
          className="w-32 rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60"
        />
        <Select
          value={property.operator}
          onValueChange={(v) => onChange({ operator: v as FlagOperator })}
          disabled={readOnly}
        >
          <SelectTrigger className="h-7 w-[130px] text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FLAG_OPERATORS.map((op) => (
              <SelectItem key={op} value={op} className="text-xs">
                {OPERATOR_LABELS[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!valueless && (
          <input
            value={String(property.value ?? '')}
            onChange={(e) => onChange({ value: e.target.value })}
            placeholder="value"
            disabled={readOnly}
            className="w-32 rounded bg-primary/10 px-2 py-1 font-mono text-xs text-primary placeholder:text-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60"
          />
        )}
      </div>
      {!readOnly && (
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

/**
 * "Who gets what" — the ordered reading of the flag, built from the *pending*
 * editor state so it updates as you type. This is the answer to "what value does
 * a given user actually get", which the rule/rollout controls alone don't say.
 */
function ServingSummary({ filters }: { filters: FlagFilters }) {
  const rows = servingSummary(filters)
  if (rows.length === 0) return null

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="text-sm font-medium text-foreground">Who gets what</div>
      <div className="mb-4 mt-0.5 text-[11px] text-muted-foreground">
        Evaluated top to bottom: the first matching rule wins.
      </div>
      <div className="space-y-1.5">
        {rows.map((row, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: summary rows have no stable id
            key={i}
            className={cn(
              'flex flex-col gap-1 rounded-md px-3 py-2 text-[11px] sm:flex-row sm:items-center sm:gap-2',
              row.isDefault ? 'bg-muted/30' : 'bg-muted/50',
              row.unreachable && 'opacity-40',
            )}
          >
            <span className="font-mono text-[10px] uppercase text-muted-foreground/40 sm:w-16 sm:shrink-0">
              {row.isDefault ? 'Default' : `Rule ${i + 1}`}
            </span>
            <span className="min-w-0 flex-1 break-words text-muted-foreground">
              {row.audience}
              {row.rollout < 100 && (
                <span className="text-muted-foreground/60"> ({row.rollout}% of them)</span>
              )}
            </span>
            <span className="shrink-0 text-muted-foreground">
              → <span className="font-mono font-semibold text-foreground">{row.serves}</span>
            </span>
          </div>
        ))}
      </div>
      {rows.some((r) => r.unreachable) && (
        <div className="mt-3 text-[11px] text-amber-400/80">
          Greyed rows never run — an earlier rule has no conditions, so it already matches every
          user.
        </div>
      )}
      {rows.some((r) => !r.isDefault && r.rollout < 100) && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          Users who match a rule but fall outside its rollout are served{' '}
          <span className="font-mono text-foreground">false</span> — they stop there and do not fall
          through to the default.
        </div>
      )}
    </div>
  )
}

/** Shared rule chrome: header (serve control + reorder/remove) and conditions. */
function RuleCard({
  index,
  count,
  properties,
  serveControl,
  rolloutControl,
  onChangeProperties,
  onMove,
  onRemove,
  canEdit,
}: {
  index: number
  count: number
  properties: FlagProperty[]
  serveControl: ReactNode
  rolloutControl?: ReactNode
  onChangeProperties: (next: FlagProperty[]) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
  canEdit: boolean
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] font-medium text-muted-foreground/40">
          Rule {index + 1}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Serve</span>
          {serveControl}
          {canEdit && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={index === 0}
                onClick={() => onMove(-1)}
                className="rounded p-1 text-muted-foreground/50 transition-colors hover:text-foreground disabled:opacity-30"
                aria-label="Move rule up"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={index === count - 1}
                onClick={() => onMove(1)}
                className="rounded p-1 text-muted-foreground/50 transition-colors hover:text-foreground disabled:opacity-30"
                aria-label="Move rule down"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={onRemove}
                className="rounded p-1 text-muted-foreground/40 transition-colors hover:text-red-400"
                aria-label="Remove rule"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="space-y-2">
        {properties.length > 0 ? (
          properties.map((p, pi) => (
            <PropertyConditionRow
              // biome-ignore lint/suspicious/noArrayIndexKey: condition rows have no stable id
              key={pi}
              property={p}
              index={pi}
              onChange={(patch) =>
                onChangeProperties(
                  properties.map((prop, idx) => (idx === pi ? { ...prop, ...patch } : prop)),
                )
              }
              onRemove={() => onChangeProperties(properties.filter((_, idx) => idx !== pi))}
              readOnly={!canEdit}
            />
          ))
        ) : (
          <div className="text-[11px] text-muted-foreground">
            No conditions — matches everyone not caught by an earlier rule.
          </div>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() =>
              onChangeProperties([...properties, { key: '', operator: 'exact', value: '' }])
            }
            className="flex items-center gap-1.5 text-[11px] text-primary transition-opacity hover:opacity-80"
          >
            <Plus className="h-3 w-3" />
            Add condition
          </button>
        )}
      </div>
      {rolloutControl}
    </div>
  )
}

/** The pinned trailing row: what a user matching no rule is served. */
function DefaultRow({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-card px-4 py-3">
      <span className="font-mono text-[10px] font-medium text-muted-foreground/40">DEFAULT</span>
      {children}
    </div>
  )
}

function SaveButton({
  onClick,
  pending,
  label,
  className,
}: {
  onClick: () => void
  pending: boolean
  label: string
  className?: string
}) {
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onClick}
      className={cn(
        'rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50',
        className,
      )}
    >
      {label}
    </button>
  )
}

const SERVE_OPTIONS = ['true', 'false'] as const

function BooleanServeSelect({
  value,
  onChange,
  disabled,
}: {
  value: boolean
  onChange: (next: boolean) => void
  disabled: boolean
}) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(v === 'true')} disabled={disabled}>
      <SelectTrigger className="h-7 w-[100px] text-[11px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SERVE_OPTIONS.map((opt) => (
          <SelectItem key={opt} value={opt} className="font-mono text-xs">
            {opt}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ── Boolean flags ────────────────────────────────────────────────────────────

const EMPTY_BOOLEAN_RULE: BooleanRule = { properties: [], rollout: 100, serve: true }

function BooleanTargeting({
  rules,
  setRules,
  defaultServe,
  setDefaultServe,
  dirty,
  pending,
  onSave,
  canEdit,
}: {
  rules: BooleanRule[]
  setRules: (next: BooleanRule[]) => void
  defaultServe: boolean
  setDefaultServe: (next: boolean) => void
  dirty: boolean
  pending: boolean
  onSave: () => void
  canEdit: boolean
}) {
  const patch = (i: number, next: Partial<BooleanRule>) =>
    setRules(rules.map((r, idx) => (idx === i ? { ...r, ...next } : r)))

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rules.length) return
    const next = [...rules]
    ;[next[i], next[j]] = [next[j], next[i]]
    setRules(next)
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-foreground">Targeting rules</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Evaluated in order: the first matching rule serves its value
          </div>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => setRules([...rules, { ...EMPTY_BOOLEAN_RULE }])}
            className="flex items-center gap-1.5 rounded-md border border-primary/25 px-2.5 py-1.5 text-xs text-primary transition-opacity hover:opacity-80"
          >
            <Plus className="h-3 w-3" />
            Add rule
          </button>
        )}
      </div>

      <div className="space-y-2">
        {rules.map((rule, i) => (
          <RuleCard
            // biome-ignore lint/suspicious/noArrayIndexKey: rule rows have no stable id
            key={i}
            index={i}
            count={rules.length}
            properties={rule.properties}
            canEdit={canEdit}
            onChangeProperties={(properties) => patch(i, { properties })}
            onMove={(dir) => move(i, dir)}
            onRemove={() => setRules(rules.filter((_, idx) => idx !== i))}
            serveControl={
              <BooleanServeSelect
                value={rule.serve}
                onChange={(serve) => patch(i, { serve })}
                disabled={!canEdit}
              />
            }
            rolloutControl={
              <div className="mt-4 border-t border-border pt-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">Rollout</span>
                  <span className="font-mono text-xs font-semibold text-primary">
                    {rule.rollout}%
                  </span>
                </div>
                <Slider
                  min={0}
                  max={100}
                  step={1}
                  value={[rule.rollout]}
                  onValueChange={([v]) => patch(i, { rollout: v })}
                  aria-label={`Rollout percentage for rule ${i + 1}`}
                  disabled={!canEdit}
                />
                {rule.rollout < 100 && (
                  <div className="mt-2 text-[11px] text-muted-foreground">
                    {rule.rollout}% of matching users are served{' '}
                    <span className="font-mono text-foreground">{String(rule.serve)}</span>; the
                    other {100 - rule.rollout}% are served{' '}
                    <span className="font-mono text-foreground">false</span> and stop here.
                  </div>
                )}
              </div>
            }
          />
        ))}
      </div>

      <DefaultRow>
        <span className="text-[11px] text-muted-foreground">Serve</span>
        <BooleanServeSelect value={defaultServe} onChange={setDefaultServe} disabled={!canEdit} />
        <span className="text-[11px] text-muted-foreground">to all other users</span>
      </DefaultRow>

      {canEdit && dirty && (
        <SaveButton onClick={onSave} pending={pending} label="Save targeting" className="mt-3" />
      )}
    </div>
  )
}

// ── String / number flags ────────────────────────────────────────────────────

function ValueTargeting({
  kind,
  values,
  setValues,
  defaultKey,
  setDefaultKey,
  rules,
  setRules,
  valuesDirty,
  rulesDirty,
  pending,
  onSave,
  canEdit,
}: {
  kind: Extract<FlagKind, 'string' | 'number'>
  values: ValueEntry[]
  setValues: (next: ValueEntry[]) => void
  defaultKey: string
  setDefaultKey: (next: string) => void
  rules: ValueRule[]
  setRules: (next: ValueRule[]) => void
  valuesDirty: boolean
  rulesDirty: boolean
  pending: boolean
  onSave: () => void
  canEdit: boolean
}) {
  const named = values.filter((v) => v.key.trim() !== '')

  const patchValue = (i: number, next: Partial<ValueEntry>) =>
    setValues(values.map((v, idx) => (idx === i ? { ...v, ...next } : v)))

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rules.length) return
    const next = [...rules]
    ;[next[i], next[j]] = [next[j], next[i]]
    setRules(next)
  }

  const valueSelect = (value: string, onChange: (v: string) => void) => (
    <Select value={value} onValueChange={onChange} disabled={!canEdit}>
      <SelectTrigger className="h-7 w-[140px] text-[11px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {named.map((v) => (
          <SelectItem key={v.key} value={v.key} className="text-xs">
            {v.key}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <>
      {/* Values */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="text-sm font-medium text-foreground">Values</div>
        <div className="mb-4 mt-0.5 text-[11px] text-muted-foreground">
          Define the {kind} values this flag can serve.
        </div>
        <div className="space-y-2">
          {values.map((v, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: value rows have no stable id
              key={i}
              className="flex flex-wrap items-center gap-2"
            >
              {kind === 'number' ? (
                <>
                  <input
                    value={v.key}
                    onChange={(e) => patchValue(i, { key: e.target.value })}
                    placeholder="label"
                    disabled={!canEdit}
                    className="w-32 rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60"
                  />
                  <input
                    type="number"
                    value={typeof v.value === 'number' ? v.value : Number(v.value) || 0}
                    onChange={(e) =>
                      patchValue(i, { value: e.target.value === '' ? 0 : Number(e.target.value) })
                    }
                    placeholder="value"
                    disabled={!canEdit}
                    className="w-32 rounded bg-primary/10 px-2 py-1 font-mono text-xs text-primary placeholder:text-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60"
                  />
                </>
              ) : (
                <input
                  value={String(v.value ?? '')}
                  onChange={(e) => patchValue(i, { key: e.target.value, value: e.target.value })}
                  placeholder="value"
                  disabled={!canEdit}
                  className="w-56 rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60"
                />
              )}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => setValues(values.filter((_, idx) => idx !== i))}
                  className="shrink-0 text-muted-foreground/40 transition-colors hover:text-red-400"
                  aria-label="Remove value"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <button
              type="button"
              onClick={() => setValues([...values, { key: '', value: kind === 'number' ? 0 : '' }])}
              className="flex items-center gap-1.5 text-[11px] text-primary transition-opacity hover:opacity-80"
            >
              <Plus className="h-3 w-3" />
              Add value
            </button>
          )}
        </div>
        {canEdit && valuesDirty && (
          <SaveButton onClick={onSave} pending={pending} label="Save values" className="mt-4" />
        )}
      </div>

      {/* Rules */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-foreground">Targeting rules</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Evaluated in order: the first matching rule serves its value
            </div>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() =>
                setRules([...rules, { properties: [], variant: named[0]?.key ?? defaultKey }])
              }
              className="flex items-center gap-1.5 rounded-md border border-primary/25 px-2.5 py-1.5 text-xs text-primary transition-opacity hover:opacity-80"
            >
              <Plus className="h-3 w-3" />
              Add rule
            </button>
          )}
        </div>

        <div className="space-y-2">
          {rules.map((rule, i) => (
            <RuleCard
              // biome-ignore lint/suspicious/noArrayIndexKey: rule rows have no stable id
              key={i}
              index={i}
              count={rules.length}
              properties={rule.properties}
              canEdit={canEdit}
              onChangeProperties={(properties) =>
                setRules(rules.map((r, idx) => (idx === i ? { ...r, properties } : r)))
              }
              onMove={(dir) => move(i, dir)}
              onRemove={() => setRules(rules.filter((_, idx) => idx !== i))}
              serveControl={valueSelect(rule.variant, (variant) =>
                setRules(rules.map((r, idx) => (idx === i ? { ...r, variant } : r))),
              )}
            />
          ))}
        </div>

        <DefaultRow>
          <span className="text-[11px] text-muted-foreground">Serve</span>
          {valueSelect(defaultKey, setDefaultKey)}
          <span className="text-[11px] text-muted-foreground">to all other users</span>
        </DefaultRow>

        {canEdit && (valuesDirty || rulesDirty) && (
          <SaveButton onClick={onSave} pending={pending} label="Save rules" className="mt-3" />
        )}
      </div>
    </>
  )
}

// ── Tab ──────────────────────────────────────────────────────────────────────

export function TargetingTab({
  projectId,
  flag,
  canEdit,
}: {
  projectId: string
  flag: FeatureFlagRow
  canEdit: boolean
}) {
  const utils = trpc.useUtils()
  const update = trpc.flags.update.useMutation()

  const original = useMemo(() => toFlagFilters(flag.filters), [flag.filters])
  const kind: FlagKind = flagKind(original)
  const isBoolean = kind === 'boolean'

  // ── Boolean state ──
  const originalBoolean = useMemo(() => parseBooleanFlagFilters(original), [original])
  const [rules, setRules] = useState<BooleanRule[]>(originalBoolean.rules)
  const [defaultServe, setDefaultServe] = useState(originalBoolean.defaultServe)

  // ── Value state ──
  const originalValues = useMemo<ValueEntry[]>(() => flagValueSet(original), [original])
  const nonDefaultGroups = useMemo(
    () => (isBoolean ? [] : original.groups.slice(0, Math.max(original.groups.length - 1, 0))),
    [isBoolean, original],
  )
  const defaultGroup = isBoolean ? undefined : original.groups[original.groups.length - 1]
  const originalDefaultKey = defaultGroup?.variant ?? originalValues[0]?.key ?? ''
  const originalValueRules = useMemo<ValueRule[]>(
    () =>
      nonDefaultGroups.map((g) => ({
        properties: g.properties,
        variant: g.variant ?? originalValues[0]?.key ?? '',
      })),
    [nonDefaultGroups, originalValues],
  )

  const [values, setValues] = useState<ValueEntry[]>(originalValues)
  const [defaultKey, setDefaultKey] = useState(originalDefaultKey)
  const [valueRules, setValueRules] = useState<ValueRule[]>(originalValueRules)

  // Re-sync when the flag changes (after a save invalidates the list, or the env
  // tab switches to a different underlying flag).
  useEffect(() => {
    setRules(originalBoolean.rules)
    setDefaultServe(originalBoolean.defaultServe)
    setValues(originalValues)
    setDefaultKey(originalDefaultKey)
    setValueRules(originalValueRules)
  }, [originalBoolean, originalValues, originalDefaultKey, originalValueRules])

  const booleanDirty =
    JSON.stringify(rules) !== JSON.stringify(originalBoolean.rules) ||
    defaultServe !== originalBoolean.defaultServe
  const valuesDirty =
    JSON.stringify(values) !== JSON.stringify(originalValues) || defaultKey !== originalDefaultKey
  const valueRulesDirty = JSON.stringify(valueRules) !== JSON.stringify(originalValueRules)

  /** The filters the editor would persist right now — also what the summary reads. */
  const pending = useMemo<FlagFilters>(() => {
    if (isBoolean) {
      return buildBooleanFlagFilters(
        rules.map((r) => ({ ...r, properties: cleanProperties(r.properties) })),
        defaultServe,
      )
    }
    return buildValueFlagFilters(
      kind as Extract<FlagKind, 'string' | 'number'>,
      values.filter((v) => v.key.trim() !== ''),
      defaultKey,
      valueRules.map((r) => ({ properties: cleanProperties(r.properties), variant: r.variant })),
    )
  }, [isBoolean, kind, rules, defaultServe, values, defaultKey, valueRules])

  async function save() {
    try {
      await update.mutateAsync({ projectId, id: flag.id, patch: { filters: pending } })
      await utils.flags.list.invalidate()
      toast.success('Targeting saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save targeting')
    }
  }

  return (
    <div className="w-full space-y-5">
      <ServingSummary filters={pending} />

      {isBoolean ? (
        <BooleanTargeting
          rules={rules}
          setRules={setRules}
          defaultServe={defaultServe}
          setDefaultServe={setDefaultServe}
          dirty={booleanDirty}
          pending={update.isPending}
          onSave={save}
          canEdit={canEdit}
        />
      ) : (
        <ValueTargeting
          kind={kind as Extract<FlagKind, 'string' | 'number'>}
          values={values}
          setValues={setValues}
          defaultKey={defaultKey}
          setDefaultKey={setDefaultKey}
          rules={valueRules}
          setRules={setValueRules}
          valuesDirty={valuesDirty}
          rulesDirty={valueRulesDirty}
          pending={update.isPending}
          onSave={save}
          canEdit={canEdit}
        />
      )}

      {canEdit && (
        <div className="text-[11px] text-muted-foreground">
          To pin a specific user, add an exact rule on <span className="font-mono">email</span> or{' '}
          <span className="font-mono">distinct_id</span>.
        </div>
      )}
    </div>
  )
}
