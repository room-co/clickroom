import type { UIMessage } from 'ai'
import { AlertTriangle, Loader2, Settings } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from './ai-elements/conversation'
import { Shimmer } from './ai-elements/shimmer'
import { AskAIEmptyState } from './shell/AskAIEmptyState'
import { Composer } from './shell/Composer'
import { MessageBubble } from './shell/MessageBubble'
import { SuggestionChips } from './shell/SuggestionChips'
import { useAskAIChat } from './useAskAIChat'

/** Lightweight page-context injected into the FIRST message of a new
 * conversation only — the system prompt already carries project id/name
 * server-side (from the conversation row), so this is purely for a launch
 * entity (insight/flag/experiment) the server has no other way to know
 * about. Degrades silently: an empty/missing entity just adds nothing. */
function buildContextPrefix(entity?: { type: string; id: string }): string {
  if (!entity?.type || !entity?.id) return ''
  return `[Context: the user is currently viewing ${entity.type} "${entity.id}".]\n\n`
}

interface AskAIChatProps {
  conversationId: string
  projectId: string
  projectName?: string
  launchEntity?: { type: string; id: string }
}

function TranscriptStatus({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      {children}
    </div>
  )
}

export function AskAIChat({
  conversationId,
  projectId,
  projectName,
  launchEntity,
}: AskAIChatProps) {
  const messagesQuery = trpc.ai.getMessages.useQuery(
    { projectId, conversationId },
    {
      enabled: !!conversationId && !!projectId,
      // useChat owns the live transcript once ChatInner mounts — a refetch
      // while it's mounted could reseed stale server state over an
      // in-flight/just-persisted turn, so history is only ever fetched once
      // per mount.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  )

  if (messagesQuery.isFetching) {
    return (
      <TranscriptStatus>
        <Loader2 className="h-5 w-5 animate-spin" />
      </TranscriptStatus>
    )
  }

  if (messagesQuery.error) {
    return (
      <TranscriptStatus>
        <AlertTriangle className="h-6 w-6 text-amber-500" />
        <p className="text-sm">Couldn't load this conversation.</p>
        <Button size="sm" variant="outline" onClick={() => messagesQuery.refetch()}>
          Retry
        </Button>
      </TranscriptStatus>
    )
  }

  const seeded = (messagesQuery.data ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    parts: m.parts ?? [],
  })) as unknown as UIMessage[]

  return (
    <ChatInner
      key={conversationId}
      conversationId={conversationId}
      projectName={projectName}
      launchEntity={launchEntity}
      initialMessages={seeded}
    />
  )
}

function ChatInner({
  conversationId,
  projectName,
  launchEntity,
  initialMessages,
}: {
  conversationId: string
  projectName?: string
  launchEntity?: { type: string; id: string }
  initialMessages: UIMessage[]
}) {
  const [seedMessages] = useState(initialMessages)
  const navigate = useNavigate()
  const chat = useAskAIChat(conversationId, seedMessages)
  const { messages, isBusy, confirming, resolveTool, send, parsedError } = chat

  const sendWithContext = (text: string) => {
    if (messages.length === 0) {
      send(`${buildContextPrefix(launchEntity)}${text}`)
    } else {
      send(text)
    }
  }

  const handleComposerSubmit = () => {
    if (!chat.input.trim() || isBusy) return
    sendWithContext(chat.input)
    chat.setInput('')
  }

  if (parsedError?.kind === 'not_configured') {
    return <AiNotConfiguredPrompt onSetup={() => navigate('/settings?tab=ai')} />
  }
  if (parsedError?.kind === 'disabled') {
    return (
      <TranscriptStatus>
        <AlertTriangle className="h-6 w-6 text-amber-500" />
        <p className="text-sm">Ask AI is temporarily disabled.</p>
      </TranscriptStatus>
    )
  }
  if (parsedError?.kind === 'forbidden') {
    return (
      <TranscriptStatus>
        <AlertTriangle className="h-6 w-6 text-destructive" />
        <p className="text-sm">{parsedError.message}</p>
      </TranscriptStatus>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-3 py-4 sm:px-4">
          {messages.length === 0 ? (
            <AskAIEmptyState projectName={projectName} onSelect={sendWithContext} />
          ) : (
            messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                confirming={confirming}
                onResolve={resolveTool}
              />
            ))
          )}
          {isBusy && <Shimmer className="text-sm">Thinking…</Shimmer>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {messages.length > 0 && <SuggestionChips disabled={isBusy} onSelect={sendWithContext} />}
      <Composer
        value={chat.input}
        onChange={chat.setInput}
        onSubmit={handleComposerSubmit}
        isBusy={isBusy}
        disabled={!chat.input.trim() || isBusy}
        placeholder="Ask about analytics, flags, experiments, segments, or run SQL…"
        errorMessage={parsedError?.kind === 'generic' ? parsedError.message : undefined}
      />
    </div>
  )
}

export function AiNotConfiguredPrompt({ onSetup }: { onSetup: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <Settings className="h-8 w-8 text-muted-foreground" />
      <div>
        <p className="text-sm font-medium text-foreground">Connect an AI provider to use Ask AI</p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          Connect Anthropic, OpenAI, or Google in your organization's settings to start chatting
          with the Clickroom assistant.
        </p>
      </div>
      <Button size="sm" onClick={onSetup}>
        Go to AI settings
      </Button>
    </div>
  )
}
