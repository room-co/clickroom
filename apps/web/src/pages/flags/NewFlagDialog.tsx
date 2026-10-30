import { Info, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { track } from '@/lib/analytics'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import {
  buildBooleanFlagFilters,
  buildValueFlagFilters,
  defaultEnvKey,
  type FlagEnv,
  type FlagFilters,
  type FlagKind,
  useEnvironments,
} from './types'

const KIND_OPTIONS: readonly FlagKind[] = ['boolean', 'string', 'number']

interface ValueRow {
  id: string
  /** Value itself for string flags, label for number flags. */
  key: string
  /** Raw numeric input text, only used for number flags. */
  numValue: string
}

function makeRowId() {
  return Math.random().toString(36).slice(2)
}

function emptyRow(): ValueRow {
  return { id: makeRowId(), key: '', numValue: '' }
}

export function NewFlagDialog({
  projectId,
  onClose,
  onCreated,
  initialEnv = '',
  initialKey = '',
  lockKey = false,
  lockEnv = false,
}: {
  projectId: string
  onClose: () => void
  onCreated: () => void
  initialEnv?: FlagEnv
  initialKey?: string
  lockKey?: boolean
  lockEnv?: boolean
}) {
  const utils = trpc.useUtils()
  const create = trpc.flags.create.useMutation()
  const environmentsQuery = useEnvironments(projectId)
  const environments = useMemo(() => environmentsQuery.data ?? [], [environmentsQuery.data])

  const [key, setKey] = useState(initialKey)
  const [name, setName] = useState('')
  const [env, setEnv] = useState<FlagEnv>(initialEnv)
  const [tagsText, setTagsText] = useState('')

  // No initial env was provided (e.g. the parent list hasn't resolved the
  // project's default env yet) — fall back to it once environments load.
  useEffect(() => {
    if (!env) {
      const fallback = defaultEnvKey(environments)
      if (fallback) setEnv(fallback)
    }
  }, [env, environments])
  const [rollout, setRollout] = useState(0)
  const [kind, setKind] = useState<FlagKind>('boolean')
  // exposure tracking. Off by default — a plain gate stays silent;
  // only experiment/adoption flags need $feature_flag_called written.
  const [trackExposures, setTrackExposures] = useState(false)
  const [valueRows, setValueRows] = useState<ValueRow[]>([emptyRow()])
  const [defaultKey, setDefaultKey] = useState('')
  const [error, setError] = useState('')

  const uniqueValueKeys = useMemo(() => {
    const seen = new Set<string>()
    const ordered: string[] = []
    for (const row of valueRows) {
      const trimmed = row.key.trim()
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed)
        ordered.push(trimmed)
      }
    }
    return ordered
  }, [valueRows])

  function handleKindChange(next: FlagKind) {
    setKind(next)
    setValueRows([emptyRow()])
    setDefaultKey('')
    setError('')
  }

  function addValueRow() {
    setValueRows((prev) => [...prev, emptyRow()])
  }

  function removeValueRow(id: string) {
    setValueRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)))
  }

  function updateValueRow(id: string, patch: Partial<Pick<ValueRow, 'key' | 'numValue'>>) {
    setValueRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  /** Returns a validation error message for the value-set editor, or null if valid. */
  function getValueSetError(): string | null {
    if (valueRows.length === 0) return 'Add at least one value.'
    const trimmedKeys = valueRows.map((r) => r.key.trim())
    if (trimmedKeys.some((k) => k === '')) {
      return kind === 'number' ? 'Every value needs a label.' : 'Every value needs text.'
    }
    const seen = new Set<string>()
    for (const k of trimmedKeys) {
      if (seen.has(k)) return 'Values must be unique.'
      seen.add(k)
    }
    if (kind === 'number') {
      for (const row of valueRows) {
        const trimmed = row.numValue.trim()
        if (trimmed === '' || Number.isNaN(Number(trimmed))) {
          return 'Enter a valid number for each value.'
        }
      }
    }
    if (!defaultKey || !trimmedKeys.includes(defaultKey)) {
      return 'Select a default value.'
    }
    return null
  }

  const valueSetError = kind === 'boolean' ? null : getValueSetError()
  const canSubmit = key.trim() !== '' && !!env && !valueSetError

  async function handleCreate() {
    setError('')
    if (key.trim() === '') {
      setError('A key is required.')
      return
    }
    if (kind !== 'boolean') {
      const validationError = getValueSetError()
      if (validationError) {
        setError(validationError)
        return
      }
    }
    const tags = tagsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const filters: FlagFilters =
      kind === 'boolean'
        ? // A new boolean flag has no targeting rules, so its rollout IS its
          // default. At 100% that's just "serve true to everyone" — express it
          // as the DEFAULT group. Below 100% it needs a rule to bucket against,
          // and the users outside the bucket fall to a `false` default.
          rollout === 100
          ? buildBooleanFlagFilters([], true)
          : buildBooleanFlagFilters([{ properties: [], rollout, serve: true }], false)
        : buildValueFlagFilters(
            kind,
            valueRows.map((r) => ({
              key: r.key.trim(),
              value: kind === 'number' ? Number(r.numValue.trim()) : r.key.trim(),
            })),
            defaultKey,
            [],
          )
    try {
      await create.mutateAsync({
        projectId,
        key: key.trim(),
        name: name.trim() ? name.trim() : undefined,
        active: true,
        track: trackExposures,
        env,
        tags: tags.length > 0 ? tags : undefined,
        filters,
      })
      await utils.flags.list.invalidate()
      await utils.flags.get.invalidate()
      track('flag_created', { flag_key: key.trim(), environment: env })
      toast.success('Flag created')
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create flag')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl shadow-black/50">
        <div className="mb-5 flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">New feature flag</div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="new-flag-key" className="text-[11px] text-muted-foreground">
              Key
            </label>
            <input
              id="new-flag-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="new-checkout-flow"
              disabled={lockKey}
              className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="new-flag-name" className="text-[11px] text-muted-foreground">
              Name
            </label>
            <input
              id="new-flag-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional human-readable name"
              className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>

          <div className="space-y-1.5">
            <div className="text-[11px] text-muted-foreground">Kind</div>
            <Select value={kind} onValueChange={(v) => handleKindChange(v as FlagKind)}>
              <SelectTrigger className="h-8 text-xs capitalize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_OPTIONS.map((k) => (
                  <SelectItem key={k} value={k} className="text-xs capitalize">
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <div className="text-[11px] text-muted-foreground">Environment</div>
              <Select value={env} onValueChange={(v) => setEnv(v as FlagEnv)} disabled={lockEnv}>
                <SelectTrigger className="h-8 text-xs">
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
            </div>
            <div className="space-y-1.5">
              <label htmlFor="new-flag-tags" className="text-[11px] text-muted-foreground">
                Tags
              </label>
              <input
                id="new-flag-tags"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="ui, beta"
                className="h-8 w-full rounded border border-border bg-muted/30 px-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>
          </div>

          {kind === 'boolean' ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="text-[11px] text-muted-foreground">Initial rollout</div>
                <div className="font-mono text-xs text-foreground">{rollout}%</div>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={rollout}
                onChange={(e) => setRollout(Number(e.target.value))}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
              />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] text-muted-foreground">Values</div>
                  <button
                    type="button"
                    onClick={addValueRow}
                    className="text-[11px] font-medium text-primary transition-opacity hover:opacity-80"
                  >
                    + Add value
                  </button>
                </div>
                <div className="space-y-2">
                  {valueRows.map((row) => (
                    <div key={row.id} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      {kind === 'number' && (
                        <input
                          value={row.key}
                          onChange={(e) => updateValueRow(row.id, { key: e.target.value })}
                          placeholder="label"
                          className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 sm:flex-1"
                        />
                      )}
                      <input
                        value={kind === 'number' ? row.numValue : row.key}
                        onChange={(e) =>
                          kind === 'number'
                            ? updateValueRow(row.id, { numValue: e.target.value })
                            : updateValueRow(row.id, { key: e.target.value })
                        }
                        placeholder={kind === 'number' ? 'value' : 'e.g. beta'}
                        inputMode={kind === 'number' ? 'decimal' : undefined}
                        className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 sm:flex-1"
                      />
                      <button
                        type="button"
                        onClick={() => removeValueRow(row.id)}
                        disabled={valueRows.length <= 1}
                        aria-label="Remove value"
                        className="self-end text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 sm:self-auto"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="text-[11px] text-muted-foreground">Default value</div>
                <Select value={defaultKey} onValueChange={setDefaultKey}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Select a default" />
                  </SelectTrigger>
                  <SelectContent>
                    {uniqueValueKeys.map((k) => (
                      <SelectItem key={k} value={k} className="text-xs">
                        {k}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="new-flag-track" className="text-[11px] text-foreground">
                  Track exposures
                </Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="About exposure tracking"
                      className="text-muted-foreground/60 transition-colors hover:text-foreground"
                    >
                      <Info className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[220px]">
                    Emits a $feature_flag_called event on each read, powering experiment and
                    adoption analytics. Leave off for plain operational gates.
                  </TooltipContent>
                </Tooltip>
              </div>
              <p className="text-[10px] leading-snug text-muted-foreground">
                Drives experiment / adoption analytics. Not needed for plain gates.
              </p>
            </div>
            <Switch
              id="new-flag-track"
              checked={trackExposures}
              onCheckedChange={setTrackExposures}
              className="mt-0.5"
            />
          </div>

          {error && <p className="text-[11px] font-medium text-red-400">{error}</p>}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={create.isPending}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={create.isPending || !canSubmit}
            className={cn(
              'rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50',
            )}
          >
            {create.isPending ? 'Creating…' : 'Create flag'}
          </button>
        </div>
      </div>
    </div>
  )
}
