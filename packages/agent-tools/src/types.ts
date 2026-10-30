// Shared shapes for the Clickroom MCP tool registry. Zero business
// logic lives here — every tool's `handle()` just calls a tRPC procedure via
// `ctx.client`, the same procedure a human request through the web dashboard
// would hit.
import type { AppRouter } from '@clickroom/trpc-router'
import type { TRPCClient } from '@trpc/client'
import type { z } from 'zod'

/** One content block of an MCP tool result — currently text-only (see result.ts). */
export interface AgentToolTextContent {
  type: 'text'
  text: string
}

/** The MCP `CallToolResult` shape a tool `handle()` resolves to. */
export interface AgentToolResult {
  content: AgentToolTextContent[]
  isError?: boolean
}

/**
 * Loopback/public tRPC client bound to the caller's identity in
 * this phase's spec. Both the remote HTTP endpoint (loopback proxy client)
 * and the stdio bridge (public proxy client) satisfy this same shape, so
 * tool handlers are transport-agnostic.
 */
export interface AgentToolContext {
  client: TRPCClient<AppRouter>
}

/**
 * One MCP-exposed tool. `input` must be a `z.ZodObject` (not `z.object(...)`
 * wrapped in `.optional()`/refinements etc. at the top level) so both
 * transports can derive an MCP `inputSchema` from it directly.
 */
export interface AgentTool<I = unknown> {
  /** snake_case `<domain>_<verb>`. */
  name: string
  description: string
  /** Groups tools by source router domain — purely organizational. */
  category: string
  /** Whether this tool calls a tRPC `.mutate()` (vs. `.query()`). */
  mutates: boolean
  // biome-ignore lint/suspicious/noExplicitAny: tool inputs vary per-domain; callers narrow via `input.parse`.
  input: z.ZodObject<any>
  handle(input: I, ctx: AgentToolContext): Promise<AgentToolResult>
}

/**
 * Builder that ties a tool's `handle()` input parameter to `z.infer` of its
 * own `input` schema (inferred per-call from the object literal passed in),
 * then erases back to the plain `AgentTool` shape used by `AGENT_TOOLS`.
 * Exists purely so each tool file can write a plain object literal without
 * manually declaring a named schema const per tool just to type `handle`.
 */
// biome-ignore lint/suspicious/noExplicitAny: S is inferred per-call from the object literal's `input` property.
export function defineTool<S extends z.ZodObject<any>>(tool: {
  name: string
  description: string
  category: string
  mutates: boolean
  input: S
  handle: (input: z.infer<S>, ctx: AgentToolContext) => Promise<AgentToolResult>
}): AgentTool {
  return tool as AgentTool
}
