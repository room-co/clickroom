// Pure history-rebuild for the Ask AI chat turn.
//
// The client sends only the latest message; the server replays prior history
// from persisted `AiMessage` rows. This module owns the three rules that
// turn raw rows into the model-facing `UIMessage[]`, kept pure + total so
// they are unit-testable without a DB or provider:
//   1. reconcile each row's parts against its `tool_calls` map (resolve
//      confirmed mutating-tool outputs to `output-available`).
//   2. drop content-free assistant rows (a lone `step-start`) so an empty
//      turn doesn't pollute replayed history.
//   3. resume dedupe: on a tool-confirm auto-resume the client re-sends the
//      assistant turn that now carries the tool result; it is already
//      persisted (and reconciled above), so appending it would duplicate the
//      turn — and the toolCallId — in the model history. Drop it when its id
//      is already present.
import type { UIMessage } from '@clickroom/ai'
import { reconcileParts } from '@clickroom/trpc-router/ai/reconcile-parts.js'
import { hasRenderableContent } from './message-parts.js'

export interface HistoryRow {
  id: string
  role: string // persisted role column: 'system' | 'user' | 'assistant'
  parts: unknown
  tool_calls: unknown
}

export function buildReplayMessages(
  historyRows: HistoryRow[],
  incomingMessage: UIMessage,
): UIMessage[] {
  const historyMessages = historyRows
    .map(
      (row) =>
        ({
          id: row.id,
          role: row.role as UIMessage['role'],
          parts: reconcileParts(row.parts, row.tool_calls) as UIMessage['parts'],
        }) as UIMessage,
    )
    .filter((m) => m.role !== 'assistant' || hasRenderableContent(m.parts))
  const isResume = historyRows.some((row) => row.id === incomingMessage.id)
  return isResume ? historyMessages : [...historyMessages, incomingMessage]
}
