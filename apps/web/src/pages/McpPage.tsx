import { Bot, ShieldOff } from 'lucide-react'
import { CodeBlock } from '@/components/CodeBlock'
import { PageHeader } from '@/components/PageHeader'
import { getAbsoluteApiOrigin } from '@/lib/runtime-config'
import { useAuth } from '@/lib/use-auth'
import { useProjectId } from '@/lib/use-project'

// ── Hosted /mcp endpoint card ────────────────────────────────────────────────

// The MCP `/mcp` endpoint is served by apps/api, not apps/web — same origin only in
// prod (behind a shared reverse proxy). In dev they're on different ports (5180 vs
// 3000); otherwise the runtime config's apiOrigin, or this page's own origin when same-origin.

function HostedEndpointCard() {
  const hostedUrl = `${getAbsoluteApiOrigin()}/mcp`
  const claudeCodeCmd = `claude mcp add --transport http clickroom ${hostedUrl}`

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-1 flex items-center gap-2">
        <Bot className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-semibold text-foreground">Remote endpoint (OAuth)</span>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        No pre-minted token required. Clickroom implements OAuth 2.1 with dynamic client
        registration, so the client registers itself on first connect and prompts you to sign in and
        approve access for one org + project.
      </p>
      <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
        Claude Code
      </span>
      <CodeBlock code={claudeCodeCmd} language="shell" />
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        Other MCP clients (e.g. Claude Desktop "Add custom connector"): paste the URL below and
        approve the consent screen.
      </p>
      <CodeBlock code={hostedUrl} />
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function McpPage() {
  const { can } = useAuth()
  const canManage = can('keys:manage')
  const projectId = useProjectId()

  if (!projectId) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <PageHeader title="MCP Server" subtitle="No project selected" />
        <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
          <Bot className="mb-3 h-8 w-8 text-muted-foreground/30" />
          <div className="text-sm font-medium text-muted-foreground">No project selected</div>
          <div className="mt-1 text-[11px] text-muted-foreground/60">
            Select a project to connect it to an MCP client.
          </div>
        </div>
      </div>
    )
  }

  if (!canManage) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <PageHeader title="MCP Server" subtitle="Restricted" />
        <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
          <ShieldOff className="mb-3 h-8 w-8 text-muted-foreground/30" />
          <div className="text-sm font-medium text-muted-foreground">
            You don&apos;t have permission to manage MCP access
          </div>
          <div className="mt-1 max-w-xs text-[11px] text-muted-foreground/60">
            Ask an org admin or member with key management access to connect this project.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader title="MCP Server" subtitle="Connect Claude and other MCP clients" />

      <div className="flex-1 space-y-6 overflow-auto p-4 md:p-6">
        <section>
          <h2 className="mb-2 text-xs font-semibold text-foreground">Connect remotely</h2>
          <HostedEndpointCard />
        </section>
      </div>
    </div>
  )
}
