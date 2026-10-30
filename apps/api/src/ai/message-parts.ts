/**
 * Pure, total adapters over a UIMessage's `parts` array used by
 * `ask-ai.controller.ts`'s turn persistence. Kept separate from the
 * controller so they are unit-testable and never throw on malformed input
 * (defensive mappers) — ported near-verbatim from the reference implementation's
 * `apps/api/src/ai/message-parts.ts`.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToolPartType(type: unknown): type is string {
  return typeof type === 'string' && (type.startsWith('tool-') || type === 'dynamic-tool')
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * True when `parts` carries something worth persisting/rendering for an
 * assistant turn: a non-empty text/reasoning part, or any tool call. Control
 * scaffolding alone (`step-start`, `step-finish`, empty text) returns false,
 * so the caller can drop content-free turns instead of saving an empty
 * bubble that also pollutes replayed model history.
 */
export function hasRenderableContent(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false
  return parts.some((part) => {
    if (!isObject(part)) return false
    const type = part.type
    if (typeof type !== 'string') return false
    if (type === 'text' || type === 'reasoning') return hasText(part.text)
    return isToolPartType(type)
  })
}

/**
 * Build the `tool_calls` JSON for a persisted assistant message: a map keyed
 * by `toolCallId` of each tool part. This matches the shape
 * `ask-ai.controller.ts`'s tool-confirm resolver merges confirmed outputs
 * into (also keyed by toolCallId) and that `reconcile-parts.ts` reads at load
 * time. Returns `undefined` when there are no usable tool parts so the
 * column stays null.
 */
export function toToolCallMap(parts: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(parts)) return undefined
  const map: Record<string, unknown> = {}
  for (const part of parts) {
    if (!isObject(part)) continue
    if (!isToolPartType(part.type)) continue
    const id = part.toolCallId
    if (typeof id !== 'string' || id.length === 0) continue
    map[id] = part
  }
  return Object.keys(map).length > 0 ? map : undefined
}
