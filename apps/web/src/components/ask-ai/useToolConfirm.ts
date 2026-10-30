// Approval-gate resolution for mutating tool calls.
//
// A mutating tool pauses at `input-available`; approving/declining POSTs to
// `/ai/chat/tool-confirm` and resumes the stream by attaching the returned
// output via `addToolResult` — `useAskAIChat`'s `sendAutomaticallyWhen` then
// auto-continues the model's closing turn. Mirrors the reference implementation's
// `apps/web/src/app/components/ask-ai/useToolConfirm.ts`.
import { useState } from 'react'
import type { ToolPart } from './tool-parts'
import { AI_API_ORIGIN, authedFetch } from './useAskAIChat'

type AddToolResult = (args: {
  tool: string
  toolCallId: string
  output: unknown
}) => void | PromiseLike<void>

export function useToolConfirm(conversationId: string, addToolResult: AddToolResult) {
  const [confirming, setConfirming] = useState<Record<string, boolean>>({})

  const resolveTool = async (
    part: ToolPart,
    toolName: string,
    args: unknown,
    approved: boolean,
  ) => {
    setConfirming((c) => ({ ...c, [part.toolCallId]: true }))
    try {
      const res = await authedFetch(`${AI_API_ORIGIN}/ai/chat/tool-confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          toolCallId: part.toolCallId,
          toolName,
          args,
          approved,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      const data = (await res.json()) as { output: unknown }
      await addToolResult({ tool: toolName, toolCallId: part.toolCallId, output: data.output })
    } catch (err) {
      // Don't swallow silently — a failed confirm/resume otherwise leaves the
      // approval card frozen with no signal.
      console.error('[ask-ai] tool-confirm failed', err)
      setConfirming((c) => {
        const next = { ...c }
        delete next[part.toolCallId]
        return next
      })
    }
  }

  return { confirming, resolveTool }
}
