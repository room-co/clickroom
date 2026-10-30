import { AlertTriangle, Check, KeyRound, Plus, Search, ShieldOff, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { StatusBadge } from '@/components/badges'
import { CopyButton } from '@/components/CopyButton'
import { PageHeader } from '@/components/PageHeader'
import { SecretField } from '@/components/SecretField'
import { SkeletonTable } from '@/components/skeletons'
import { formatTimestamp } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'
import { fallbackEnvStyle } from './flags/FlagBits'
import { defaultEnvKey, useEnvironments } from './flags/types'

// ── Types (real backend shape) ────────────────────────────────────────────────

// `mcp` included defensively to match the tRPC procedure's inferred `ApiKeyType`
// column type — `projects.keys.list` filters `mcp` rows out server-side (they're
// managed via the dedicated `mcpKey` router/`McpPage`), so this variant never
// actually renders here.
type KeyType = 'write' | 'read' | 'mcp'
// Env now travels as an arbitrary per-project `Environment` slug —
// custom environments), not a fixed 3-value union.
type KeyEnv = string
type KeyScope = 'events:read' | 'events:write' | 'flags:read' | 'flags:write' | 'users:read'
type Expiry = '30d' | '90d' | '1y' | 'never'

type ApiKey = {
  id: string
  keyPrefix: string
  type: KeyType
  label: string | null
  scopes: string[]
  env: KeyEnv
  lastUsedAt: string | null
  revokedAt: string | null
  expiresAt: string | null
  createdAt: string
}

const SCOPES: { id: KeyScope; label: string; desc: string }[] = [
  { id: 'events:read', label: 'Events · Read', desc: 'Query events and sessions' },
  { id: 'events:write', label: 'Events · Write', desc: 'Ingest events via API' },
  { id: 'flags:read', label: 'Flags · Read', desc: 'Evaluate feature flags' },
  { id: 'flags:write', label: 'Flags · Write', desc: 'Create and update flags' },
  { id: 'users:read', label: 'Users · Read', desc: 'List and query users' },
]

const EXPIRY_OPTIONS: { value: Expiry; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '1y', label: '1 year' },
]

const scopeColor: Record<string, string> = {
  'events:read': 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  'events:write': 'bg-teal-500/15 text-teal-300 border-teal-500/30',
  'flags:read': 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  'flags:write': 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  'users:read': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
}

/** Key types the dialog can mint (`mcp` keys are managed on the MCP page). */
type CreatableKeyType = 'write' | 'read'

const KEY_TYPE_OPTIONS: { value: CreatableKeyType; label: string; desc: string; prefix: string }[] =
  [
    { value: 'write', label: 'Write', desc: 'Ingest events, manage flags', prefix: 'ckw_live_' },
    { value: 'read', label: 'Read', desc: 'Read-only, e.g. flag definitions', prefix: 'ckr_live_' },
  ]

const DEFAULT_SCOPES: Record<CreatableKeyType, KeyScope[]> = {
  write: ['events:write', 'flags:read'],
  read: ['flags:read'],
}

const isWriteScope = (s: KeyScope) => s.endsWith(':write')

// ── Confirm dialog for destructive actions ────────────────────────────────────

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  pending,
  onConfirm,
  onCancel,
}: {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  pending?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/60"
        onClick={onCancel}
      />
      <div className="relative w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl shadow-black/50">
        <div className="mb-4 flex items-start gap-3">
          <div
            className={cn(
              'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
              danger ? 'bg-red-500/15' : 'bg-amber-500/15',
            )}
          >
            <AlertTriangle className={cn('h-4 w-4', danger ? 'text-red-400' : 'text-amber-400')} />
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground">{title}</div>
            <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{body}</div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
              danger
                ? 'border border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/20'
                : 'border border-amber-500/20 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20',
            )}
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── "Key created" reveal modal — shown once after minting ─────────────────────

function KeyRevealModal({ fullKey, onClose }: { fullKey: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl shadow-black/50">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-teal-500/15">
              <KeyRound className="h-3.5 w-3.5 text-teal-400" />
            </div>
            <span className="text-sm font-semibold text-foreground">API key created</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
          <p className="text-[11px] leading-relaxed text-amber-300">
            Copy this key now — it will <strong>never be shown again</strong>. Store it in a secrets
            manager or environment variable.
          </p>
        </div>

        <div className="mb-4 overflow-hidden rounded-lg border border-border bg-muted/30">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="font-mono text-[10px] text-muted-foreground">Secret key</span>
            <CopyButton value={fullKey} label="Copy" copiedIconClassName="text-teal-400" />
          </div>
          <div className="select-all break-all px-3 py-3 font-mono text-xs leading-relaxed text-foreground">
            {fullKey}
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-md bg-primary py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Done, I copied it
        </button>
      </div>
    </div>
  )
}

// ── Create key slide-over ─────────────────────────────────────────────────────

function CreateKeyPanel({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string
  onClose: () => void
  onCreated: (token: string) => void
}) {
  const environmentsQuery = useEnvironments(projectId)
  const environments = useMemo(() => environmentsQuery.data ?? [], [environmentsQuery.data])

  const [name, setName] = useState('')
  const [env, setEnv] = useState<KeyEnv>('')
  const [keyType, setKeyType] = useState<CreatableKeyType>('write')
  const [scopes, setScopes] = useState<KeyScope[]>(DEFAULT_SCOPES.write)
  const [expiry, setExpiry] = useState<Expiry>('never')
  const [error, setError] = useState('')

  // Default to the project's `isDefault` environment once it loads.
  useEffect(() => {
    if (!env) {
      const fallback = defaultEnvKey(environments)
      if (fallback) setEnv(fallback)
    }
  }, [env, environments])

  const utils = trpc.useUtils()
  const create = trpc.projects.keys.create.useMutation()

  const selectKeyType = (t: CreatableKeyType) => {
    if (t === keyType) return
    setKeyType(t)
    setScopes(DEFAULT_SCOPES[t])
  }

  const toggleScope = (s: KeyScope) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))

  async function handleCreate() {
    if (scopes.length === 0) {
      setError('Select at least one scope.')
      return
    }
    setError('')
    try {
      const res = await create.mutateAsync({
        projectId,
        type: keyType,
        label: name.trim() ? name.trim() : undefined,
        scopes,
        env,
        expiry,
      })
      await utils.projects.keys.list.invalidate()
      onCreated(res.token)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create key')
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div className="relative ml-auto flex h-full w-full flex-col border-l border-border bg-card shadow-2xl shadow-black/40 md:max-w-[420px]">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/15">
              <KeyRound className="h-3.5 w-3.5 text-primary" />
            </div>
            <span className="text-sm font-semibold text-foreground">New API key</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-auto p-5">
          {/* Name */}
          <div>
            <label
              htmlFor="key-name"
              className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
            >
              Key name
            </label>
            <input
              id="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production Ingest, CI Pipeline"
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs text-foreground transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/60"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              A human-readable label to identify this key.
            </p>
          </div>

          {/* Key type */}
          <div>
            <span className="mb-2 block text-[11px] font-medium text-muted-foreground">
              Key type
            </span>
            <div className="grid grid-cols-2 gap-2">
              {KEY_TYPE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={keyType === o.value}
                  onClick={() => selectKeyType(o.value)}
                  className={cn(
                    'rounded-md border px-3 py-2 text-left transition-colors',
                    keyType === o.value
                      ? 'border-primary/25 bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:border-border/80 hover:text-foreground',
                  )}
                >
                  <div className="text-[11px] font-medium">{o.label}</div>
                  <div className="text-[10px] opacity-80">{o.desc}</div>
                  <div className="mt-0.5 font-mono text-[10px] opacity-70">{o.prefix}…</div>
                </button>
              ))}
            </div>
          </div>

          {/* Environment */}
          <div>
            <span className="mb-2 block text-[11px] font-medium text-muted-foreground">
              Environment
            </span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {environments.map((e) => (
                <button
                  key={e.key}
                  type="button"
                  onClick={() => setEnv(e.key)}
                  className={cn(
                    'rounded-md border px-2 py-2 text-[11px] font-medium transition-colors',
                    env === e.key
                      ? cn(fallbackEnvStyle(e.key), 'border-current/30')
                      : 'border-border text-muted-foreground hover:border-border/80 hover:text-foreground',
                  )}
                  style={
                    env === e.key && e.color
                      ? { color: e.color, backgroundColor: `${e.color}1a`, borderColor: e.color }
                      : undefined
                  }
                >
                  {e.name}
                </button>
              ))}
            </div>
          </div>

          {/* Scopes */}
          <div>
            <span className="mb-2 block text-[11px] font-medium text-muted-foreground">
              Permissions
            </span>
            <div className="space-y-1.5">
              {SCOPES.filter((s) => keyType === 'write' || !isWriteScope(s.id)).map((s) => {
                const activeScope = scopes.includes(s.id)
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggleScope(s.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
                      activeScope
                        ? 'border-primary/25 bg-primary/5'
                        : 'border-border hover:border-border/80 hover:bg-muted/20',
                    )}
                  >
                    <div
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                        activeScope ? 'border-primary bg-primary' : 'border-border bg-muted/30',
                      )}
                    >
                      {activeScope && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-medium text-foreground">{s.label}</div>
                      <div className="text-[10px] text-muted-foreground">{s.desc}</div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Expiry */}
          <div>
            <span className="mb-2 block text-[11px] font-medium text-muted-foreground">
              Expiration
            </span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {EXPIRY_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setExpiry(o.value)}
                  className={cn(
                    'rounded-md border py-2 text-[11px] font-medium transition-colors',
                    expiry === o.value
                      ? 'border-primary/25 bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:border-border/80 hover:text-foreground',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-[11px] font-medium text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={create.isPending}
            className="flex-1 rounded-md border border-border py-2 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={create.isPending}
            className="flex-1 rounded-md bg-primary py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {create.isPending ? 'Generating…' : 'Generate key'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type EnvFilter = 'all' | KeyEnv

export function ApiKeysPage() {
  const { can } = useAuth()
  const canManageKeys = can('keys:manage')
  const projectId = useProjectId()
  const utils = trpc.useUtils()
  const keysQuery = trpc.projects.keys.list.useQuery(
    { projectId: projectId as string },
    { enabled: !!projectId },
  )
  const environmentsQuery = useEnvironments(projectId)
  const environments = useMemo(() => environmentsQuery.data ?? [], [environmentsQuery.data])
  const envColorByKey = useMemo(
    () => Object.fromEntries(environments.map((e) => [e.key, e.color])),
    [environments],
  )
  const revoke = trpc.projects.keys.revoke.useMutation()
  const del = trpc.projects.keys.delete.useMutation()

  const [showCreate, setShowCreate] = useState(false)
  const [newFullKey, setNewFullKey] = useState<string | null>(null)
  const [visiblePrefix, setVisiblePrefix] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ type: 'revoke' | 'delete'; key: ApiKey } | null>(null)
  const [search, setSearch] = useState('')
  const [filterEnv, setFilterEnv] = useState<EnvFilter>('all')

  const keys = useMemo<ApiKey[]>(() => keysQuery.data ?? [], [keysQuery.data])
  const active = keys.filter((k) => !k.revokedAt).length
  const revokedCount = keys.length - active

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return keys.filter((k) => {
      if (filterEnv !== 'all' && k.env !== filterEnv) return false
      if (q === '') return true
      return (k.label?.toLowerCase().includes(q) ?? false) || k.keyPrefix.toLowerCase().includes(q)
    })
  }, [keys, search, filterEnv])

  async function handleRevoke(key: ApiKey) {
    if (!projectId) return
    try {
      await revoke.mutateAsync({ keyId: key.id, projectId })
      await utils.projects.keys.list.invalidate()
      toast.success('API key revoked')
      setConfirm(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to revoke key')
    }
  }

  async function handleDelete(key: ApiKey) {
    if (!projectId) return
    try {
      await del.mutateAsync({ keyId: key.id, projectId })
      await utils.projects.keys.list.invalidate()
      toast.success('API key deleted')
      setConfirm(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete key')
    }
  }

  if (!projectId) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <PageHeader title="API Keys" subtitle="No project selected" />
        <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
          <KeyRound className="mb-3 h-8 w-8 text-muted-foreground/30" />
          <div className="text-sm font-medium text-muted-foreground">No project selected</div>
          <div className="mt-1 text-[11px] text-muted-foreground/60">
            Select a project to manage its API keys.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        title="API Keys"
        subtitle={`${active} active key${active !== 1 ? 's' : ''} · ${keys.length} total`}
      >
        {canManageKeys && (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            New key
          </button>
        )}
      </PageHeader>

      {/* Filter bar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search keys..."
            className="w-56 rounded border border-border bg-muted/30 py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
        <div className="flex items-center overflow-hidden rounded border border-border text-[11px]">
          <button
            type="button"
            onClick={() => setFilterEnv('all')}
            className={cn(
              'px-3 py-1.5 capitalize transition-colors',
              filterEnv === 'all'
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            all
          </button>
          {environments.map((e) => (
            <button
              key={e.key}
              type="button"
              onClick={() => setFilterEnv(e.key)}
              className={cn(
                'px-3 py-1.5 transition-colors',
                filterEnv === e.key
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {e.name}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-4 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-teal-400" />
            {active} active
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
            {revokedCount} revoked
          </span>
        </div>
      </div>

      {/* Table / states */}
      <div className="flex-1 overflow-auto">
        {keysQuery.isPending ? (
          <div className="overflow-x-auto">
            <SkeletonTable rows={5} cols={8} className="p-5" />
          </div>
        ) : keysQuery.error ? (
          <div className="m-5 flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <div className="text-sm font-medium text-red-400">Failed to load API keys</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {keysQuery.error.message}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-background">
                  <tr className="border-b border-border">
                    {[
                      'Name',
                      'Key prefix',
                      'Type',
                      'Scopes',
                      'Environment',
                      'Last used',
                      'Expires',
                      'Status',
                      '',
                    ].map((h) => (
                      <th
                        key={h}
                        className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((key) => {
                    const revoked = !!key.revokedAt
                    return (
                      <tr
                        key={key.id}
                        className={cn(
                          'border-b border-border/50 transition-colors',
                          revoked ? 'opacity-50' : 'hover:bg-muted/20',
                        )}
                      >
                        {/* Name */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div
                              className={cn(
                                'h-1.5 w-1.5 shrink-0 rounded-full',
                                revoked ? 'bg-muted-foreground/40' : 'bg-teal-400',
                              )}
                            />
                            {key.label ? (
                              <span className="whitespace-nowrap font-medium text-foreground">
                                {key.label}
                              </span>
                            ) : (
                              <span className="whitespace-nowrap italic text-muted-foreground">
                                Unnamed key
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Prefix */}
                        <td className="px-4 py-3">
                          <SecretField
                            value={key.keyPrefix}
                            masked={`${key.keyPrefix.slice(0, 12)}••••••••`}
                            // Reveal is hoisted so only one row is open at a time.
                            revealed={visiblePrefix === key.id}
                            onRevealedChange={(next) => setVisiblePrefix(next ? key.id : null)}
                            copyable={false}
                            label="key prefix"
                          />
                        </td>

                        {/* Type */}
                        <td className="px-4 py-3">
                          <span className="rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium capitalize text-muted-foreground">
                            {key.type}
                          </span>
                        </td>

                        {/* Scopes */}
                        <td className="px-4 py-3">
                          <div className="flex max-w-full flex-wrap gap-1 sm:max-w-[240px]">
                            {key.scopes.length === 0 ? (
                              <span className="text-muted-foreground/40">—</span>
                            ) : (
                              key.scopes.map((s) => (
                                <span
                                  key={s}
                                  className={cn(
                                    'rounded border px-1.5 py-0.5 font-mono text-[10px]',
                                    scopeColor[s] ??
                                      'border-border bg-muted/60 text-muted-foreground',
                                  )}
                                >
                                  {s}
                                </span>
                              ))
                            )}
                          </div>
                        </td>

                        {/* Environment */}
                        <td className="px-4 py-3">
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 text-[10px] font-medium capitalize',
                              !envColorByKey[key.env] && fallbackEnvStyle(key.env),
                            )}
                            style={
                              envColorByKey[key.env]
                                ? {
                                    color: envColorByKey[key.env] as string,
                                    backgroundColor: `${envColorByKey[key.env]}1a`,
                                  }
                                : undefined
                            }
                          >
                            {key.env}
                          </span>
                        </td>

                        {/* Last used */}
                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                          {key.lastUsedAt ? (
                            formatTimestamp(key.lastUsedAt)
                          ) : (
                            <span className="italic text-muted-foreground/40">Never</span>
                          )}
                        </td>

                        {/* Expires */}
                        <td className="whitespace-nowrap px-4 py-3 font-mono text-muted-foreground">
                          {key.expiresAt ? (
                            formatTimestamp(key.expiresAt)
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>

                        {/* Status */}
                        <td className="px-4 py-3">
                          <StatusBadge status={revoked ? 'revoked' : 'active'} />
                        </td>

                        {/* Actions */}
                        <td className="px-4 py-3">
                          {canManageKeys && (
                            <div className="flex items-center gap-1">
                              {!revoked && (
                                <button
                                  type="button"
                                  onClick={() => setConfirm({ type: 'revoke', key })}
                                  title="Revoke key"
                                  className="rounded p-1.5 text-muted-foreground/60 transition-colors hover:bg-amber-500/10 hover:text-amber-400"
                                >
                                  <ShieldOff className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => setConfirm({ type: 'delete', key })}
                                title="Delete key"
                                className="rounded p-1.5 text-muted-foreground/60 transition-colors hover:bg-red-500/10 hover:text-red-400"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {filtered.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <KeyRound className="mb-3 h-8 w-8 text-muted-foreground/30" />
                <div className="text-sm font-medium text-muted-foreground">No keys found</div>
                <div className="mt-1 text-[11px] text-muted-foreground/60">
                  {search || filterEnv !== 'all'
                    ? 'Try a different search or filter.'
                    : 'Generate your first API key to get started.'}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Overlays */}
      {canManageKeys && showCreate && (
        <CreateKeyPanel
          projectId={projectId}
          onClose={() => setShowCreate(false)}
          onCreated={(token) => {
            setShowCreate(false)
            setNewFullKey(token)
          }}
        />
      )}
      {newFullKey && <KeyRevealModal fullKey={newFullKey} onClose={() => setNewFullKey(null)} />}
      {canManageKeys && confirm?.type === 'revoke' && (
        <ConfirmDialog
          title="Revoke this key?"
          body="The key will stop working immediately. Any services using it will lose access. Revoked keys cannot be re-activated."
          confirmLabel="Revoke key"
          pending={revoke.isPending}
          onConfirm={() => handleRevoke(confirm.key)}
          onCancel={() => setConfirm(null)}
        />
      )}
      {canManageKeys && confirm?.type === 'delete' && (
        <ConfirmDialog
          title="Permanently delete this key?"
          body="This action cannot be undone. The key will be deleted from all records and can never be recovered."
          confirmLabel="Delete forever"
          danger
          pending={del.isPending}
          onConfirm={() => handleDelete(confirm.key)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
