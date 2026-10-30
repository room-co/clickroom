import type { AgentToolResult } from './types.js'

/**
 * JSON-serialize a tRPC result into a single text content block.
 * `undefined` (e.g. a `void` mutation) serializes as `null` rather than
 * disappearing (`JSON.stringify(undefined) === undefined`), so the caller
 * always gets valid JSON back.
 */
export function jsonResult(value: unknown): AgentToolResult {
  const json = value === undefined ? 'null' : JSON.stringify(value, null, 2)
  return { content: [{ type: 'text', text: json }] }
}

/** Plain-text tool result (errors, human-readable confirmations, etc). */
export function textResult(text: string, isError = false): AgentToolResult {
  return { content: [{ type: 'text', text }], ...(isError && { isError }) }
}
