import type { LucideIcon } from 'lucide-react'
import { AlertCircle, Blocks, Loader2, MousePointer, ShieldCheck, Wrench } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { track } from '@/lib/analytics'
import { trpc } from '@/lib/trpc'

type ProjectOption = { orgId: string; orgName: string; projectId: string; projectName: string }

type Permission = { icon: LucideIcon; label: string }

/**
 * Pure, total mapper: an OAuth scope string → a human-readable permission the
 * user can reason about. Unknown scopes fall back to the raw string with a
 * generic icon so the list never hides what is being granted and never throws.
 */
function scopeToPermission(scope: string): Permission {
  switch (scope) {
    case 'mcp':
      return { icon: Wrench, label: 'Use Clickroom tools to act on your behalf' }
    default:
      return { icon: ShieldCheck, label: scope }
  }
}

/** Map raw scopes to permissions, defaulting to full MCP access when empty. */
function toPermissions(scopes: string[]): Permission[] {
  const list = scopes.length > 0 ? scopes : ['mcp']
  return list.map(scopeToPermission)
}

/** Two-letter mark derived from the client name, for the connection glyph. */
function clientInitials(name: string): string {
  const cleaned = name.trim()
  if (!cleaned) return '?'
  const parts = cleaned.split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?'
}

type ClientBrand = {
  match: string
  src: string
  /** Icon ships its own tile/background (e.g. Cursor's black square) → render
   *  edge-to-edge. Bare transparent marks stay padded on a neutral tile. */
  fullBleed: boolean
}

const CLIENT_BRANDS: ClientBrand[] = [
  { match: 'claude', src: '/mcp-clients/claude.webp', fullBleed: false },
  { match: 'cursor', src: '/mcp-clients/cursor.webp', fullBleed: true },
  { match: 'codex', src: '/mcp-clients/codex.svg', fullBleed: false },
]

/**
 * Known MCP clients → brand icon, matched by substring on the registered
 * client name (e.g. "Claude Code (clickroom-local)", "Cursor", "Codex CLI") so
 * config suffixes don't defeat the match. Null for unknown clients — total,
 * never throws.
 */
function clientBrand(name: string): ClientBrand | null {
  const n = name.toLowerCase()
  return CLIENT_BRANDS.find((b) => n.includes(b.match)) ?? null
}

/** The left endpoint of the connection glyph: brand icon or initials fallback. */
function ClientTile({ clientName }: { clientName: string }) {
  const brand = clientBrand(clientName)

  if (brand?.fullBleed) {
    return (
      <img
        src={brand.src}
        alt={clientName}
        className="size-14 rounded-2xl border object-cover shadow-sm"
      />
    )
  }

  return (
    <div className="flex size-14 items-center justify-center rounded-2xl border bg-muted shadow-sm">
      {brand ? (
        <img src={brand.src} alt={clientName} className="size-8 object-contain" />
      ) : (
        <span className="text-base font-semibold text-foreground">
          {clientInitials(clientName)}
        </span>
      )}
    </div>
  )
}

/** The right endpoint of the connection glyph: Clickroom's own mark. */
function ClickroomTile() {
  return (
    <div className="flex size-14 items-center justify-center rounded-2xl border bg-card shadow-sm">
      <div className="flex size-8 items-center justify-center rounded-lg bg-primary">
        <MousePointer className="size-4 text-primary-foreground" />
      </div>
    </div>
  )
}

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted flex items-center justify-center p-6">
      <div className="w-full max-w-md px-4 sm:px-0">{children}</div>
    </div>
  )
}

/**
 * Signature element: the external client and Clickroom shown as two endpoints
 * about to be wired together. This is what the whole screen is about — granting
 * an outside app a live connection into your Clickroom account.
 */
function ConnectionHero({ clientName }: { clientName: string }) {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center gap-3">
        <ClientTile clientName={clientName} />

        <div className="relative flex h-px w-16 items-center">
          <span className="absolute inset-0 border-t border-dashed border-muted-foreground/40" />
          <span className="absolute left-1/2 -translate-x-1/2 flex size-6 items-center justify-center rounded-full border bg-card shadow-sm">
            <Blocks className="size-3.5 text-muted-foreground" />
            <span className="absolute inset-0 rounded-full border border-primary/30 motion-safe:animate-ping" />
          </span>
        </div>

        <ClickroomTile />
      </div>

      <div className="text-center">
        <h1 className="text-lg font-semibold tracking-tight">Connect {clientName} to Clickroom</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {clientName} wants to access your Clickroom account.
        </p>
      </div>
    </div>
  )
}

function PermissionRow({ icon: Icon, label }: Permission) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="size-4 text-foreground" />
      </span>
      <span className="text-sm text-foreground">{label}</span>
    </li>
  )
}

function PermissionList({ scopes }: { scopes: string[] }) {
  const permissions = toPermissions(scopes)
  return (
    <div className="space-y-2.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        This will allow {permissions.length === 1 ? 'it' : 'the app'} to
      </p>
      <ul className="space-y-2.5">
        {permissions.map((permission) => (
          <PermissionRow key={permission.label} icon={permission.icon} label={permission.label} />
        ))}
      </ul>
    </div>
  )
}

function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: ProjectOption[]
  value: string
  onChange: (id: string) => void
}) {
  if (projects.length === 0) {
    return <p className="text-sm text-muted-foreground">You have no projects to authorize.</p>
  }
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Authorizing as
      </span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger data-testid="mcp-consent-project-select">
          <SelectValue placeholder="Select a project" />
        </SelectTrigger>
        <SelectContent>
          {projects.map((project) => (
            <SelectItem key={project.projectId} value={project.projectId}>
              {project.projectName} · {project.orgName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function ConsentCard({
  req,
  clientName,
  scopes,
  projects,
}: {
  req: string
  clientName: string
  scopes: string[]
  projects: ProjectOption[]
}) {
  const [projectId, setProjectId] = useState(projects[0]?.projectId ?? '')
  const approve = trpc.mcpOAuth.approve.useMutation({
    onSuccess: (res) => {
      track('mcp_token_created')
      window.location.href = res.redirectTo
    },
  })
  const deny = trpc.mcpOAuth.deny.useMutation({
    onSuccess: (res) => {
      window.location.href = res.redirectTo
    },
  })

  const pending = approve.isPending || deny.isPending
  const canApprove = projects.length > 0 && !!projectId && !pending

  return (
    <Card data-testid="mcp-consent-card" className="w-full">
      <CardContent className="space-y-6 pt-2">
        <ConnectionHero clientName={clientName} />
        <PermissionList scopes={scopes} />
        <ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0" />
          You can revoke this access anytime in Settings.
        </p>
      </CardContent>
      <CardFooter className="grid grid-cols-2 gap-2">
        <Button
          data-testid="mcp-consent-deny"
          variant="outline"
          disabled={pending}
          onClick={() => deny.mutate({ req })}
        >
          {deny.isPending ? <Loader2 className="size-4 animate-spin" /> : 'Deny'}
        </Button>
        <Button
          data-testid="mcp-consent-approve"
          disabled={!canApprove}
          onClick={() => approve.mutate({ req, projectId })}
        >
          {approve.isPending ? <Loader2 className="size-4 animate-spin" /> : 'Approve'}
        </Button>
      </CardFooter>
    </Card>
  )
}

function StatusShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-6">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <MousePointer className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="font-semibold text-base tracking-tight text-foreground">
            click<span className="text-primary">room</span>
          </span>
        </div>
        <div className="text-center space-y-3">{children}</div>
      </div>
    </AuthShell>
  )
}

function LoadingState() {
  return (
    <StatusShell>
      <Loader2 className="mx-auto size-8 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Loading authorization request…</p>
    </StatusShell>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <StatusShell>
      <AlertCircle className="mx-auto size-8 text-destructive" />
      <p className="font-medium text-foreground">Authorization failed</p>
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">{message}</p>
    </StatusShell>
  )
}

export function McpConsentPage() {
  const [searchParams] = useSearchParams()
  const req = searchParams.get('req') ?? ''

  const consentInfo = trpc.mcpOAuth.consentInfo.useQuery(
    { req },
    { enabled: req.length > 0, retry: false },
  )

  if (!req) return <ErrorState message="This authorization request is invalid or has expired." />
  if (consentInfo.isLoading) return <LoadingState />
  if (consentInfo.isError || !consentInfo.data) {
    return <ErrorState message="This authorization request is invalid or has expired." />
  }

  return (
    <AuthShell>
      <ConsentCard
        req={req}
        clientName={consentInfo.data.clientName}
        scopes={consentInfo.data.scopes}
        projects={consentInfo.data.projects}
      />
    </AuthShell>
  )
}
