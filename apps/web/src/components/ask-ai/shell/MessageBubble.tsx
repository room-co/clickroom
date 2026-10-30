import type { UIMessage } from 'ai'
import { Sparkles } from 'lucide-react'
import { Message, MessageContent, MessageResponse } from '../ai-elements/message'
import { buildSegments, type Segment, type ToolPart } from '../tool-parts'
import { ApprovalGate } from './ApprovalGate'
import { ToolSegment } from './ToolSegment'

interface MessageBubbleProps {
  message: UIMessage
  confirming: Record<string, boolean>
  onResolve: (part: ToolPart, toolName: string, args: unknown, approved: boolean) => void
}

function AssistantAvatar() {
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/60"
    >
      <Sparkles className="h-3.5 w-3.5 text-primary-foreground" />
    </span>
  )
}

function SegmentView({
  seg,
  role,
  confirming,
  onResolve,
}: {
  seg: Segment
  role: string
  confirming: Record<string, boolean>
  onResolve: MessageBubbleProps['onResolve']
}) {
  if (seg.kind === 'text') {
    return role === 'user' ? (
      <p className="whitespace-pre-wrap break-words text-sm">{seg.text}</p>
    ) : (
      <MessageResponse>{seg.text}</MessageResponse>
    )
  }
  if (seg.kind === 'tools') {
    return <ToolSegment toolName={seg.toolName} parts={seg.parts} />
  }
  return (
    <ApprovalGate
      part={seg.part}
      toolName={seg.toolName}
      confirming={!!confirming[seg.part.toolCallId]}
      onResolve={onResolve}
    />
  )
}

export function MessageBubble({ message, confirming, onResolve }: MessageBubbleProps) {
  const segments = buildSegments((message.parts ?? []) as unknown[], confirming)
  if (segments.length === 0) return null
  const isAssistant = message.role !== 'user'

  return (
    <Message
      from={isAssistant ? 'assistant' : 'user'}
      className={isAssistant ? 'flex-row items-start gap-3' : undefined}
    >
      {isAssistant && <AssistantAvatar />}
      <MessageContent>
        {segments.map((seg) => (
          <SegmentView
            key={seg.key}
            seg={seg}
            role={message.role}
            confirming={confirming}
            onResolve={onResolve}
          />
        ))}
      </MessageContent>
    </Message>
  )
}
