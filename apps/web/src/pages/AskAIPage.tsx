import { MessageSquarePlus, PanelLeft, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { AiNotConfiguredPrompt, AskAIChat } from '@/components/ask-ai/AskAIChat'
import { ThreadSidebar } from '@/components/ask-ai/shell/ThreadSidebar'
import { useAskAIConversations } from '@/components/ask-ai/useAskAIConversations'
import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc'
import { useProjectId } from '@/lib/use-project'

const LAUNCH_ENTITY_TYPES = new Set(['insight', 'flag', 'experiment'])

function NoThreadSelected({ onNewChat, creating }: { onNewChat: () => void; creating: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
      <Sparkles className="h-8 w-8 opacity-40" />
      <p className="text-sm">Start a new chat or select a conversation.</p>
      <Button onClick={onNewChat} disabled={creating}>
        <MessageSquarePlus className="h-4 w-4" />
        New chat
      </Button>
    </div>
  )
}

function NoProjectSelected() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Sparkles className="h-8 w-8 text-muted-foreground/30" />
      <div className="text-sm font-medium text-muted-foreground">No project selected</div>
      <div className="mt-1 text-[11px] text-muted-foreground/60">
        Select a project to use Ask AI.
      </div>
    </div>
  )
}

export function AskAIPage() {
  const navigate = useNavigate()
  const projectId = useProjectId()
  const projectsQuery = trpc.projects.list.useQuery()
  const projectName = projectsQuery.data?.find((p) => p.id === projectId)?.name

  const [searchParams] = useSearchParams()
  const entityType = searchParams.get('entityType')
  const entityId = searchParams.get('entityId')
  const launchEntity =
    entityType && entityId && LAUNCH_ENTITY_TYPES.has(entityType)
      ? { type: entityType, id: entityId }
      : undefined

  // Reactive gate: `/ai/chat` itself returns 409 `ai_not_configured` if this
  // changes mid-session, but checking proactively avoids letting a user type
  // a whole message before finding out there's no key connected.
  const aiConfigured = trpc.org.isAIConfigured.useQuery(undefined, { enabled: !!projectId })

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const convs = useAskAIConversations(projectId, !!projectId && aiConfigured.data === true)

  const selectThread = (id: string) => {
    convs.setSelectedId(id)
    setSidebarOpen(false)
  }

  if (!projectId) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <Header
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          onNewChat={() => {}}
          creating={false}
        />
        <NoProjectSelected />
      </div>
    )
  }

  if (aiConfigured.data === false) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <Header
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          onNewChat={() => {}}
          creating={false}
        />
        <AiNotConfiguredPrompt onSetup={() => navigate('/settings?tab=ai')} />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <Header
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        onNewChat={() => convs.createConversation()}
        creating={convs.creating}
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <ThreadSidebar
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          conversations={convs.conversations}
          isLoading={convs.isLoading}
          selectedId={convs.selectedId}
          onSelect={selectThread}
          onNewChat={() => convs.createConversation()}
          creating={convs.creating}
          rename={convs.rename}
          onDelete={convs.deleteConversation}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {convs.selectedId ? (
            <AskAIChat
              conversationId={convs.selectedId}
              projectId={projectId}
              projectName={projectName}
              launchEntity={launchEntity}
            />
          ) : (
            <NoThreadSelected
              onNewChat={() => convs.createConversation()}
              creating={convs.creating}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function Header({
  sidebarOpen,
  onToggleSidebar,
  onNewChat,
  creating,
}: {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onNewChat: () => void
  creating: boolean
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3 md:px-6">
      <div className="flex items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          onClick={onToggleSidebar}
          aria-label="Toggle conversations"
          aria-pressed={sidebarOpen}
        >
          <PanelLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-4 w-4 text-primary" />
          <h1 className="text-sm font-semibold text-foreground">Ask AI</h1>
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onNewChat} disabled={creating}>
        <MessageSquarePlus className="h-3.5 w-3.5" />
        New chat
      </Button>
    </div>
  )
}
