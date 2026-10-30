import { AGENT_TOOLS, type AgentToolContext } from '@clickroom/agent-tools'
import type { ToolSet } from '@clickroom/ai'

// The AI SDK's `tool()` helper is an identity function at runtime; we build
// the Tool literal directly and cast to `ToolSet[string]` instead of calling
// it. Calling the generic `tool()` against agent-tools' zod `ZodObject<any>`
// input schemas (some of them deeply nested discriminated unions, e.g.
// `insights_*`) blows the TS instantiation depth (TS2589) — same issue
// the reference implementation's `agent-toolset.ts` hit and worked around the same way.
type AiTool = ToolSet[string]

/**
 * Build an AI SDK `ToolSet` from the shared agent-tool registry
 * (`@clickroom/agent-tools` — unchanged).
 *
 * Read tools (`mutates: false`) get an `execute` that runs immediately
 * through the loopback tRPC client and returns the flattened text result —
 * the SDK auto-runs them mid-stream.
 *
 * Mutating tools (`mutates: true`) are registered WITHOUT an `execute`. The
 * SDK therefore emits a tool-call the client must satisfy out-of-band (the
 * confirmation round-trip): the UI shows a confirm prompt, then POSTs
 * to `/ai/chat/tool-confirm`, which actually performs the mutation and
 * resumes the stream via `addToolResult`.
 */
export function buildAgentToolSet(client: AgentToolContext['client']): ToolSet {
  const set: ToolSet = {}

  for (const t of AGENT_TOOLS) {
    const base = { description: t.description, inputSchema: t.input }
    const def = t.mutates
      ? base
      : {
          ...base,
          execute: async (args: unknown) => {
            const result = await t.handle(args, { client })
            const text = result.content.map((c) => c.text).join('\n')
            // Read tools return jsonResult() (a JSON-stringified blob) almost
            // always; the web widget adapter expects the parsed
            // object, not the string, so unwrap it here. textResult() outputs
            // (errors, confirmations) aren't valid JSON — fall back to the
            // raw string for those.
            try {
              return JSON.parse(text)
            } catch {
              return text
            }
          },
        }
    set[t.name] = def as unknown as AiTool
  }

  return set
}
