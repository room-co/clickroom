import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  Pencil,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  Webhook,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonCard, SkeletonTable, SkeletonText } from '@/components/skeletons'
import { UsageSummaryPanel } from '@/components/UsageSummaryPanel'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { track } from '@/lib/analytics'
import { formatDate } from '@/lib/format'
import { getDeployment } from '@/lib/runtime-config'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useEntitlement } from '@/lib/use-entitlement'
import { useInternalFlag } from '@/lib/use-internal-flag'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'
import { type Environment, useEnvironments } from './flags/types'

type TabId = 'environments' | 'team' | 'billing' | 'ai'

const DEFAULT_TAB: TabId = 'environments'
const TAB_IDS: readonly TabId[] = ['environments', 'team', 'billing', 'ai']

// Mirrors `AIProviderName`/`DEFAULT_MODELS` from `packages/ai/src/{types,provider}.ts`.
// Not imported directly — `@clickroom/ai` pulls in server-only AI SDK provider
// deps (`@ai-sdk/*`) and isn't a dependency of `apps/web`; this small mirror
// keeps the frontend bundle free of that server-side surface.
type AIProviderName = 'anthropic' | 'openai' | 'google'

const AI_PROVIDERS: { value: AIProviderName; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
]

const DEFAULT_MODELS: Record<AIProviderName, string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-4o',
  google: 'gemini-2.5-pro',
}

function parseTabParam(value: string | null): TabId {
  return TAB_IDS.includes(value as TabId) ? (value as TabId) : DEFAULT_TAB
}

// Content width per tab: short settings rows read better with a comfortable
// measure, while code/tables benefit from the full page width. Keep this in
// one place so no tab needs a one-off exception in the JSX below.
const CONTENT_WIDTH: Record<TabId, string> = {
  environments: 'max-w-full',
  team: '',
  billing: '',
  ai: 'max-w-lg',
}

// Runtime shape of an org membership row from `org.members.list`.
type OrgMember = {
  id: string
  role: 'org_admin' | 'member' | 'viewer'
  createdAt: string
  user: { id: string; email: string; name: string | null }
}

const ROLE_LABEL: Record<OrgMember['role'], string> = {
  org_admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
}

// Runtime shape of a pending invite row from `org.members.pendingInvites`.
type PendingInvite = {
  id: string
  email: string
  role: OrgMember['role']
  createdAt: string
  expiresAt: string
}

function initialsFor(member: OrgMember): string {
  const source = member.user.name?.trim() || member.user.email
  const parts = source.split(/[\s@.]+/).filter(Boolean)
  const first = parts[0]?.[0] ?? '?'
  const second = parts[1]?.[0] ?? ''
  return (first + second).toUpperCase()
}

export function SettingsPage() {
  const projectId = useProjectId()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = parseTabParam(searchParams.get('tab'))

  function setTab(next: TabId) {
    // replace (not push) — switching a tab is a filter change, not new
    // navigation history; keeps back/forward from stepping through every tab.
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        params.set('tab', next)
        return params
      },
      { replace: true },
    )
  }

  const { can } = useAuth()
  const isOrgAdmin = can('members:manage')
  // SSO settings mirror the server-side `requirePermission('org:update')`
  // gate on sso.router.ts — same permission `UsageSummaryPanel` uses for the
  // overage-policy control, so the link only renders for org admins.
  const canManageSso = can('org:update')
  // (SSO) is still rolling out — gate the entry-point card behind an
  // internal rollout flag so it doesn't show for every org
  // while it's finished, without touching the already-shipped `/settings/sso`
  // route or its server-side `org:update` permission gate above.
  const ssoRolloutEnabled = useInternalFlag('internal-sso-settings', true)
  // The webhooks link card is entitlement-gated exactly like
  // its route. The server-side `entitlementMiddleware('feature:support')` on the
  // procedures is the real gate; this only decides whether the card shows.
  const supportEntitled = useEntitlement('feature:support').allowed

  const membersQuery = trpc.org.members.list.useQuery()
  // `pendingInvites` is admin-gated server-side (members:manage) — only fire
  // it for admins, otherwise every non-admin visit to this tab throws a
  // background FORBIDDEN query error for nothing.
  const pendingInvitesQuery = trpc.org.members.pendingInvites.useQuery(undefined, {
    enabled: isOrgAdmin,
  })
  const [inviting, setInviting] = useState(false)

  const members = (membersQuery.data ?? []) as OrgMember[]
  const pendingInvites = (pendingInvitesQuery.data ?? []) as PendingInvite[]

  // AI settings hold a BYO LLM key and are gated `org:update` server-side
  // (`getAISettings`/`setAISettings`/`clearAISettings` in org.router.ts) —
  // there's no read-level permission for non-admins to fall back to, so the
  // tab itself is hidden rather than shown as a broken/read-only form that
  // would 403 on every query. Mirrors `pendingInvitesQuery`'s
  // `enabled: isOrgAdmin` gate above for the same reason.
  const canManageAI = isOrgAdmin
  // A non-admin who lands on ?tab=ai directly (stale link, manual edit) falls
  // back to the default tab instead of rendering an empty pane.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setTab wraps setSearchParams and is recreated every render — including it would re-run this effect on every render instead of only on tab/role changes.
  useEffect(() => {
    if (tab === 'ai' && !canManageAI) {
      setTab(DEFAULT_TAB)
    }
  }, [tab, canManageAI])
  const selfHost = getDeployment() === 'self_host'
  const tabs: { id: TabId; label: string }[] = [
    { id: 'environments', label: 'Environments' },
    { id: 'team', label: 'Team' },
    { id: 'billing', label: selfHost ? 'Usage' : 'Billing' },
    ...(canManageAI ? [{ id: 'ai' as const, label: 'AI Assistant' }] : []),
  ]

  return (
    <div className="flex flex-col h-full overflow-auto">
      <PageHeader title="Settings" subtitle="Project configuration and workspace management" />

      <div className="px-5 border-b border-border flex gap-0 shrink-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'px-4 py-3 text-xs font-medium border-b-2 -mb-px transition-colors',
              tab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={cn('flex-1 p-5', CONTENT_WIDTH[tab])}>
        {tab === 'environments' && projectId && (
          <div className="space-y-4">
            <EnvironmentsSettings projectId={projectId} />
            {supportEntitled && (
              // Same shape as the SSO card below — a Settings
              // surface too big for a tab gets a link card. Gated on the same
              // `feature:support` entitlement as the `/settings/webhooks` route
              // and the `support.webhooks.*` procedures, so an unentitled org
              // isn't pointed at an upsell wall.
              <Link
                to="/settings/webhooks"
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted/20"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <Webhook className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <div className="text-xs font-medium text-foreground">Webhooks</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      HTTP endpoints that receive support tickets and replies.
                    </div>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            )}
          </div>
        )}

        {tab === 'team' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-foreground">Team Members</h3>
              {isOrgAdmin && (
                <button
                  type="button"
                  onClick={() => setInviting(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs font-medium hover:opacity-90 transition-opacity"
                >
                  <Plus className="w-3 h-3" />
                  Invite
                </button>
              )}
            </div>
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-border">
                      {['Member', 'Joined', 'Role'].map((h) => (
                        <th
                          key={h}
                          className="text-left px-4 py-2.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {membersQuery.isPending && (
                      <tr>
                        <td colSpan={3} className="p-0">
                          <SkeletonTable rows={3} cols={3} header={false} />
                        </td>
                      </tr>
                    )}
                    {!membersQuery.isPending && members.length === 0 && (
                      <tr>
                        <td colSpan={3} className="px-4 py-3 text-[11px] text-muted-foreground">
                          No members yet.
                        </td>
                      </tr>
                    )}
                    {members.map((m) => (
                      <tr
                        key={m.id}
                        className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center text-[10px] font-bold text-primary-foreground shrink-0">
                              {initialsFor(m)}
                            </div>
                            <div>
                              <div className="text-xs font-medium text-foreground whitespace-nowrap">
                                {m.user.name ?? m.user.email}
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                {m.user.email}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                          {formatDate(m.createdAt)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-[10px] font-medium px-2 py-0.5 bg-muted/50 text-muted-foreground rounded whitespace-nowrap">
                            {ROLE_LABEL[m.role]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {canManageSso && ssoRolloutEnabled && (
              <Link
                to="/settings/sso"
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted/20"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <div className="text-xs font-medium text-foreground">Single Sign-On</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      Configure SAML/OIDC, verified domains, and group mappings.
                    </div>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            )}

            {isOrgAdmin && pendingInvites.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-foreground">Pending Invites</h3>
                <div className="bg-card border border-border rounded-lg divide-y divide-border/50">
                  {pendingInvites.map((invite) => (
                    <PendingInviteRow key={invite.id} invite={invite} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'billing' && (
          <div className="space-y-4">
            <UsageSummaryPanel showPolicyControl={!selfHost} />
            {!selfHost && (
              <p className="text-[11px] text-muted-foreground">
                Contact your Clickroom rep to change plans. Self-serve upgrades aren&apos;t
                available yet.
              </p>
            )}
          </div>
        )}

        {tab === 'ai' && canManageAI && <AISettingsSection />}
      </div>

      {inviting && <InviteMemberDialog onClose={() => setInviting(false)} />}
    </div>
  )
}

// ── Team management ───────────────────────────────────────────────────────────

function InviteMemberDialog({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils()
  const invite = trpc.org.members.invite.useMutation()

  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrgMember['role']>('member')
  const [error, setError] = useState('')
  const [inviteLink, setInviteLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function handleInvite() {
    const trimmedEmail = email.trim()
    if (!trimmedEmail) {
      setError('Email is required.')
      return
    }
    setError('')
    try {
      const result = await invite.mutateAsync({ email: trimmedEmail, role })
      track('invite_sent', { role })
      await utils.org.members.pendingInvites.invalidate()
      setInviteLink(`${window.location.origin}/invite/${result.token}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invite')
    }
  }

  async function handleCopy() {
    if (!inviteLink) return
    await navigator.clipboard.writeText(inviteLink)
    setCopied(true)
    toast.success('Invite link copied')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div className="relative w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl shadow-black/50">
        <div className="mb-5 flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">Invite member</div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {inviteLink ? (
          <div className="space-y-4">
            <p className="text-[11px] text-muted-foreground">
              Share this link with {email.trim()} — no email is sent automatically.
            </p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={inviteLink}
                className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 font-mono text-[11px] text-foreground"
              />
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy invite link"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="invite-member-email" className="text-[11px] text-muted-foreground">
                Email
              </label>
              <input
                id="invite-member-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@company.com"
                className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="invite-member-role" className="text-[11px] text-muted-foreground">
                Role
              </label>
              <select
                id="invite-member-role"
                value={role}
                onChange={(e) => setRole(e.target.value as OrgMember['role'])}
                className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              >
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
                <option value="org_admin">Admin</option>
              </select>
            </div>

            {error && <p className="text-[11px] font-medium text-red-400">{error}</p>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={invite.isPending}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleInvite}
                disabled={invite.isPending}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {invite.isPending ? 'Generating…' : 'Generate link'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function PendingInviteRow({ invite }: { invite: PendingInvite }) {
  const utils = trpc.useUtils()
  const revoke = trpc.org.members.revokeInvite.useMutation()

  // The invite's token (the shareable link's secret) is never sent to the
  // client past the one-time `invite` mutation result — the pending list
  // intentionally can't re-derive a copyable link. Revoke and re-invite to
  // get a fresh link.
  async function handleRevoke() {
    try {
      await revoke.mutateAsync({ id: invite.id })
      await utils.org.members.pendingInvites.invalidate()
      toast.success('Invite revoked')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to revoke invite')
    }
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-xs font-medium text-foreground">{invite.email}</div>
        <div className="text-[10px] text-muted-foreground">
          {ROLE_LABEL[invite.role]} · expires {formatDate(invite.expiresAt)}
        </div>
      </div>
      <div className="flex items-center gap-2 self-start sm:self-auto">
        <button
          type="button"
          onClick={handleRevoke}
          disabled={revoke.isPending}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-red-500/30 hover:text-red-400 disabled:opacity-50"
        >
          <Trash2 className="h-3 w-3" />
          Revoke
        </button>
      </div>
    </div>
  )
}

// ── Environments management ──────────────────────────────────────────────────

const ENV_COLOR_SWATCHES = [
  '#2DD4BF', // teal
  '#F59E0B', // amber
  '#8B5CF6', // violet
  '#38BDF8', // sky
  '#F472B6', // pink
  '#84CC16', // lime
]

function CreateEnvironmentDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string
  onClose: () => void
  onCreated: () => void
}) {
  const utils = trpc.useUtils()
  const create = trpc.environments.create.useMutation()

  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(ENV_COLOR_SWATCHES[0])
  const [error, setError] = useState('')

  async function handleCreate() {
    const trimmedKey = key.trim()
    const trimmedName = name.trim()
    if (!/^[a-z0-9-]+$/.test(trimmedKey)) {
      setError('Key must be lowercase letters, numbers, and hyphens only.')
      return
    }
    if (!trimmedName) {
      setError('Name is required.')
      return
    }
    setError('')
    try {
      await create.mutateAsync({ projectId, key: trimmedKey, name: trimmedName, color })
      track('settings_changed', { section: 'environment' })
      await utils.environments.list.invalidate()
      toast.success('Environment created')
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create environment')
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
      <div className="relative w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl shadow-black/50">
        <div className="mb-5 flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">New environment</div>
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
            <label htmlFor="new-env-key" className="text-[11px] text-muted-foreground">
              Key
            </label>
            <input
              id="new-env-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="qa"
              className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            <p className="text-[10px] text-muted-foreground">
              Lowercase letters, numbers, hyphens only. Cannot be changed after creation.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="new-env-name" className="text-[11px] text-muted-foreground">
              Name
            </label>
            <input
              id="new-env-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="QA"
              className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>

          <div className="space-y-1.5">
            <span className="text-[11px] text-muted-foreground">Color</span>
            <div className="flex flex-wrap gap-2">
              {ENV_COLOR_SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Use color ${c}`}
                  aria-pressed={color === c}
                  className={cn(
                    'h-6 w-6 shrink-0 rounded-full border-2 transition-transform',
                    color === c ? 'scale-110 border-foreground' : 'border-transparent',
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
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
            disabled={create.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create environment'}
          </button>
        </div>
      </div>
    </div>
  )
}

function EditEnvironmentDialog({
  projectId,
  environment,
  onClose,
  onUpdated,
}: {
  projectId: string
  environment: Environment
  onClose: () => void
  onUpdated: () => void
}) {
  const utils = trpc.useUtils()
  const update = trpc.environments.update.useMutation()

  const [name, setName] = useState(environment.name)
  const [color, setColor] = useState<string>(environment.color ?? ENV_COLOR_SWATCHES[0])
  const [error, setError] = useState('')

  async function handleSave() {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Name is required.')
      return
    }
    setError('')
    try {
      await update.mutateAsync({ projectId, id: environment.id, name: trimmedName, color })
      track('settings_changed', { section: 'environment' })
      await utils.environments.list.invalidate()
      toast.success('Environment updated')
      onUpdated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update environment')
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
      <div className="relative w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl shadow-black/50">
        <div className="mb-5 flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">Edit environment</div>
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
            <label htmlFor="edit-env-key" className="text-[11px] text-muted-foreground">
              Key
            </label>
            <input
              id="edit-env-key"
              value={environment.key}
              disabled
              className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 font-mono text-xs text-muted-foreground disabled:opacity-70"
            />
            <p className="text-[10px] text-muted-foreground">Cannot be changed after creation.</p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="edit-env-name" className="text-[11px] text-muted-foreground">
              Name
            </label>
            <input
              id="edit-env-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="QA"
              className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>

          <div className="space-y-1.5">
            <span className="text-[11px] text-muted-foreground">Color</span>
            <div className="flex flex-wrap gap-2">
              {ENV_COLOR_SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Use color ${c}`}
                  aria-pressed={color === c}
                  className={cn(
                    'h-6 w-6 shrink-0 rounded-full border-2 transition-transform',
                    color === c ? 'scale-110 border-foreground' : 'border-transparent',
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          {error && <p className="text-[11px] font-medium text-red-400">{error}</p>}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={update.isPending}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={update.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {update.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DeleteEnvironmentDialog({
  projectId,
  environment,
  onClose,
  onDeleted,
}: {
  projectId: string
  environment: Environment
  onClose: () => void
  onDeleted: () => void
}) {
  const utils = trpc.useUtils()
  const del = trpc.environments.delete.useMutation()
  const [error, setError] = useState('')

  async function handleDelete() {
    setError('')
    try {
      await del.mutateAsync({ projectId, id: environment.id })
      await utils.environments.list.invalidate()
      toast.success('Environment deleted')
      onDeleted()
    } catch (err) {
      // Surfaced plainly — the API names exactly what still references this
      // environment (flag/key counts) so the block-if-in-use CONFLICT reads
      // as actionable, not a generic failure.
      setError(err instanceof Error ? err.message : 'Failed to delete environment')
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
      <div className="relative w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl shadow-black/50">
        <div className="mb-4 flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500/15">
            <AlertTriangle className="h-4 w-4 text-red-400" />
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground">Delete this environment?</div>
            <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-mono text-foreground">{environment.key}</span> will be removed
              permanently. This cannot be undone.
            </div>
          </div>
        </div>
        {error && (
          <div className="mb-4 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-red-400">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={del.isPending}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={del.isPending}
            className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
          >
            {del.isPending ? 'Deleting…' : 'Delete forever'}
          </button>
        </div>
      </div>
    </div>
  )
}

function EnvironmentsSettings({ projectId }: { projectId: string }) {
  const { can } = useAuth()
  const canManageFlags = can('flags:write')
  const environmentsQuery = useEnvironments(projectId)
  const environments = environmentsQuery.data ?? []
  const [creating, setCreating] = useState(false)
  const [pendingEdit, setPendingEdit] = useState<Environment | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Environment | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-xs font-semibold text-foreground">Environments</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Environments scope feature flags and API keys within this project. Keys are permanent
            once created.
          </p>
        </div>
        {canManageFlags && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex items-center justify-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 sm:justify-start"
          >
            <Plus className="h-3.5 w-3.5" />
            New environment
          </button>
        )}
      </div>

      {environmentsQuery.isPending ? (
        <div className="flex flex-col gap-2">
          <SkeletonCard lines={1} />
          <SkeletonCard lines={1} />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {environments.map((env) => (
            <div
              key={env.id}
              className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-center gap-3">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: env.color ?? '#6B6B8A' }}
                />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-foreground">{env.name}</span>
                    {env.isDefault && (
                      <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        Default
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {env.key}
                  </div>
                </div>
              </div>
              {canManageFlags && (
                <div className="flex items-center gap-2 self-start sm:self-auto">
                  <button
                    type="button"
                    onClick={() => setPendingEdit(env)}
                    className="flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(env)}
                    className="flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-red-500/30 hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}

          {environments.length === 0 && (
            <div className="rounded-lg border border-dashed border-border bg-card px-6 py-8 text-center">
              <div className="text-xs font-medium text-foreground">No environments yet</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Create one to start scoping flags and keys.
              </div>
            </div>
          )}
        </div>
      )}

      {creating && (
        <CreateEnvironmentDialog
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={() => setCreating(false)}
        />
      )}
      {pendingEdit && (
        <EditEnvironmentDialog
          projectId={projectId}
          environment={pendingEdit}
          onClose={() => setPendingEdit(null)}
          onUpdated={() => setPendingEdit(null)}
        />
      )}
      {pendingDelete && (
        <DeleteEnvironmentDialog
          projectId={projectId}
          environment={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onDeleted={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}

// ── AI Assistant settings ────────────────────────────────
// BYO-provider LLM key for Ask AI. Server never returns the plaintext/
// encrypted key — `getAISettings` only reports `{provider, model,
// has_api_key}` — so this section always renders a masked placeholder for a
// configured key rather than attempting to display or pre-fill it.

function AISettingsSection() {
  const utils = trpc.useUtils()
  const settingsQuery = trpc.org.getAISettings.useQuery()
  const setSettings = trpc.org.setAISettings.useMutation()
  const clearSettings = trpc.org.clearAISettings.useMutation()

  const [provider, setProvider] = useState<AIProviderName>('anthropic')
  const [model, setModel] = useState(DEFAULT_MODELS.anthropic)
  const [apiKey, setApiKey] = useState('')
  // Whether the raw key input is shown at all — false while a key is already
  // connected and the user hasn't clicked "Change" yet.
  const [editingKey, setEditingKey] = useState(false)

  // Seed local form state from the loaded settings once, then let the user's
  // own edits take over (re-syncing on every refetch would stomp in-progress
  // edits after a save).
  const [seeded, setSeeded] = useState(false)
  useEffect(() => {
    if (seeded || !settingsQuery.data) return
    const data = settingsQuery.data
    if (data.provider) setProvider(data.provider as AIProviderName)
    if (data.model) setModel(data.model)
    setEditingKey(!data.has_api_key)
    setSeeded(true)
  }, [seeded, settingsQuery.data])

  const hasKey = settingsQuery.data?.has_api_key ?? false

  function handleProviderChange(next: AIProviderName) {
    setProvider(next)
    // Reset the model field to the new provider's default — editable from
    // there ("model picker defaulting to DEFAULT_MODELS[provider],
    // editable").
    setModel(DEFAULT_MODELS[next])
  }

  async function handleSave() {
    const trimmedKey = apiKey.trim()
    const trimmedModel = model.trim()
    if (!trimmedModel) {
      toast.error('Model is required.')
      return
    }
    if (!trimmedKey) {
      toast.error('API key is required.')
      return
    }
    try {
      await setSettings.mutateAsync({
        provider,
        model: trimmedModel,
        apiKey: trimmedKey,
      })
      track('settings_changed', { section: 'ai' })
      await utils.org.getAISettings.invalidate()
      setApiKey('')
      setEditingKey(false)
      toast.success('AI settings saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save AI settings')
    }
  }

  async function handleRemove() {
    try {
      await clearSettings.mutateAsync()
      await utils.org.getAISettings.invalidate()
      setApiKey('')
      setEditingKey(true)
      toast.success('API key removed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove API key')
    }
  }

  return (
    <div className="max-w-lg space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <Sparkles className="h-4 w-4 text-primary" />
        </div>
        <div>
          <h3 className="text-xs font-semibold text-foreground">AI Assistant</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Connect your own LLM provider key to enable Ask AI for this org. The key is encrypted at
            rest and never shown again after saving.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        {settingsQuery.isPending ? (
          <SkeletonText lines={4} />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <span className="text-[11px] text-muted-foreground">Provider</span>
              <Select
                value={provider}
                onValueChange={(v) => handleProviderChange(v as AIProviderName)}
              >
                <SelectTrigger className="w-full text-xs">
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  {AI_PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="ai-model" className="text-[11px] text-muted-foreground">
                Model
              </label>
              <input
                id="ai-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={DEFAULT_MODELS[provider]}
                className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="ai-api-key" className="text-[11px] text-muted-foreground">
                API key
              </label>
              {editingKey ? (
                <input
                  id="ai-api-key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={hasKey ? 'Enter a new key to replace the current one' : 'sk-…'}
                  className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
              ) : (
                <div className="flex items-center justify-between gap-2 rounded border border-border bg-muted/30 px-3 py-1.5">
                  <span className="font-mono text-xs text-muted-foreground">
                    •••••••••••••••••••••
                  </span>
                  <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                    Connected
                  </span>
                </div>
              )}
              <div className="flex flex-wrap gap-2 pt-0.5">
                {!editingKey && (
                  <button
                    type="button"
                    onClick={() => setEditingKey(true)}
                    className="text-[11px] font-medium text-primary hover:opacity-80"
                  >
                    Change key
                  </button>
                )}
                {editingKey && hasKey && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingKey(false)
                      setApiKey('')
                    }}
                    className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                )}
                {hasKey && (
                  <button
                    type="button"
                    onClick={handleRemove}
                    disabled={clearSettings.isPending}
                    className="text-[11px] font-medium text-red-400 hover:opacity-80 disabled:opacity-50"
                  >
                    {clearSettings.isPending ? 'Removing…' : 'Remove key'}
                  </button>
                )}
              </div>
            </div>

            {editingKey && (
              // The API always requires the key alongside provider/model
              // (`setAISettings` has no partial-update path — see
              // org.router.ts), so a provider/model-only save isn't
              // possible without re-entering the key; the save action only
              // appears once the user is (re)supplying one.
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={setSettings.isPending}
                  className="w-full rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 sm:w-auto"
                >
                  {setSettings.isPending ? 'Saving…' : hasKey ? 'Save changes' : 'Connect'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
