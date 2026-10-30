// Parsing + segmentation layer for Ask AI message parts.
//
// One responsibility: turn the AI SDK's wide `UIMessage.parts` union into the
// narrow shapes the transcript renders (text / approval-gate / tool-trace).
// No JSX here — mirrors `apps/api/src/ai/message-parts.ts`'s narrowing so
// client and server agree on what counts as a "tool part". Ported from
// the reference implementation's `apps/web/src/app/components/ask-ai/tool-parts.ts`, trimmed of the
// incident-specific id→label map (Clickroom's tools don't need it).

export type TextPart = { type: 'text'; text: string }

export type ToolPart = {
  type: string
  toolName?: string
  toolCallId: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
}

export function isTextPart(p: unknown): p is TextPart {
  return (
    typeof p === 'object' &&
    p !== null &&
    (p as { type?: unknown }).type === 'text' &&
    typeof (p as { text?: unknown }).text === 'string'
  )
}

export function isToolPart(p: unknown): p is ToolPart {
  if (typeof p !== 'object' || p === null) return false
  const type = (p as { type?: unknown }).type
  return typeof type === 'string' && (type.startsWith('tool-') || type === 'dynamic-tool')
}

export function toolNameOf(part: ToolPart): string {
  if (part.type === 'dynamic-tool') return part.toolName ?? 'tool'
  return part.type.slice('tool-'.length)
}

export function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// A rendered slice of one assistant message: prose text, an inline approval
// gate, or a collapsed/widget group of consecutive same-tool calls.
export type Segment =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'confirm'; key: string; part: ToolPart; toolName: string }
  | { kind: 'tools'; key: string; toolName: string; parts: ToolPart[] }

/**
 * Splits one message's `parts` into renderable segments, folding consecutive
 * same-tool calls into a single `tools` group so the transcript doesn't spam
 * N identical chips/widgets. A mutating tool paused at `input-available` (not
 * yet confirmed) gets its own interactive `confirm` segment instead of being
 * folded — `confirming` tracks in-flight approvals so a just-approved call
 * falls back into the normal `tools` trace instead of re-showing the gate.
 */
export function buildSegments(parts: unknown[], confirming: Record<string, boolean>): Segment[] {
  const segments: Segment[] = []
  parts.forEach((part, i) => {
    if (isTextPart(part)) {
      if (part.text.trim().length === 0) return
      segments.push({ kind: 'text', key: `t-${i}`, text: part.text })
      return
    }
    if (!isToolPart(part)) return

    const toolName = toolNameOf(part)
    const awaitingConfirm = part.state === 'input-available' && !confirming[part.toolCallId]
    if (awaitingConfirm) {
      segments.push({ kind: 'confirm', key: `c-${i}`, part, toolName })
      return
    }

    const last = segments.at(-1)
    if (last && last.kind === 'tools' && last.toolName === toolName) {
      last.parts.push(part)
    } else {
      segments.push({ kind: 'tools', key: `g-${i}`, toolName, parts: [part] })
    }
  })
  return segments
}
