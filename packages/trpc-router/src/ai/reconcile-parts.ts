/**
 * Reconcile a persisted AiMessage's `parts` against its `tool_calls` JSON.
 *
 * Confirmed mutating-tool outputs arrive via `POST /ai/chat/tool-confirm` and
 * are stored on `AiMessage.tool_calls` as a map keyed by `toolCallId` (see
 * `ask-ai.controller.ts`'s `recordToolResult`) — they are NOT merged back
 * into `parts`. So on reload the matching tool part in `parts` is still
 * `input-available` (awaiting confirmation) with no `output`, which would
 * make the UI re-render the approval gate for an already-taken action and
 * lose the prior tool outcome from the model's replayed history.
 *
 * This pure helper rewrites each tool part that has a resolved entry in the
 * keyed `tool_calls` map to `state: 'output-available'` with the recorded
 * `output`, dropping the awaiting-confirm flag. It is total and defensive:
 * it never throws, and on any malformed / non-matching input it returns the
 * part unchanged.
 *
 * This is the canonical version `ai.router.ts`'s `getMessages` originally
 * inlined a simpler placeholder for (see that file's now-resolved
 * `TODO`) — `replay-messages.ts` also builds on this same helper so
 * both the tRPC read path and the streaming controller's history rebuild
 * agree on one reconciliation rule.
 */

interface ToolPart {
  type: string
  toolCallId?: string
  state?: string
  input?: unknown
  output?: unknown
  errorText?: unknown
  [key: string]: unknown
}

interface RecordedToolResult {
  output?: unknown
  result?: { output?: unknown }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToolPart(value: unknown): value is ToolPart {
  if (!isObject(value)) return false
  const type = value.type
  return typeof type === 'string' && (type.startsWith('tool-') || type === 'dynamic-tool')
}

/**
 * Returns the recorded output string for a toolCallId from the keyed
 * `tool_calls` map, or `null` if there is no usable entry. Tolerates both the
 * `{ result: { output } }` shape (from `recordToolResult`) and a flatter
 * `{ output }` shape.
 */
function recordedOutputFor(toolCalls: Record<string, unknown>, toolCallId: string): string | null {
  const entry = toolCalls[toolCallId]
  if (!isObject(entry)) return null
  const candidate = entry as RecordedToolResult
  const output = candidate.result?.output ?? candidate.output
  if (typeof output !== 'string') return null
  return output
}

function reconcileToolPart(part: ToolPart, toolCalls: Record<string, unknown>): ToolPart {
  const toolCallId = part.toolCallId
  if (typeof toolCallId !== 'string') return part
  const output = recordedOutputFor(toolCalls, toolCallId)
  if (output === null) return part
  return { ...part, state: 'output-available', output }
}

/**
 * Map each part through reconciliation. Tool parts with a confirmed output
 * in the keyed `tool_calls` map are rewritten to `output-available`;
 * everything else is returned unchanged. Non-array `parts` -> `[]`; array-
 * shaped / null / malformed `tool_calls` -> parts unchanged.
 */
export function reconcileParts(parts: unknown, toolCalls: unknown): unknown[] {
  if (!Array.isArray(parts)) return []
  if (!isObject(toolCalls)) return parts.slice()
  return parts.map((part) => {
    if (!isToolPart(part)) return part
    return reconcileToolPart(part, toolCalls)
  })
}
