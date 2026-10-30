// Builds the `McpServer` the stdio bridge (`main.ts`) connects to a
// `StdioServerTransport`. Registers every tool in `AGENT_TOOLS` unchanged —
// zero business logic here, same rule as `packages/agent-tools`.

import type { AgentTool, AgentToolContext } from '@clickroom/agent-tools'
import { AGENT_TOOLS } from '@clickroom/agent-tools'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { toToolErrorResult } from './errors.js'
import { createTrpcClient } from './trpc-client.js'

const SERVER_NAME = 'clickroom-mcp'
const SERVER_VERSION = '0.0.0'

/** Registers one `AgentTool` on the server, wiring its result/error shape to `CallToolResult`. */
function registerAgentTool(server: McpServer, tool: AgentTool, ctx: AgentToolContext): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.input,
    },
    async (input: unknown): Promise<CallToolResult> => {
      // `AgentToolResult` is a narrower, transport-agnostic shape than the SDK's
      // `CallToolResult` (which adds an index signature + optional `_meta`/
      // `structuredContent`) — both describe the same `{content, isError?}` wire
      // shape `AGENT_TOOLS` handlers actually produce, so the cast is safe.
      try {
        return (await tool.handle(input, ctx)) as CallToolResult
      } catch (error) {
        return toToolErrorResult(error) as CallToolResult
      }
    },
  )
}

/**
 * Builds an `McpServer` bound to a fresh public tRPC client authenticated as
 * `token`, exposing every `AGENT_TOOLS` entry. `main.ts` connects the result
 * to a `StdioServerTransport`.
 */
export function createMcpServer(token: string, apiUrl: string, timeoutMs: number): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  const client = createTrpcClient(token, apiUrl, timeoutMs)
  const ctx: AgentToolContext = { client }

  for (const tool of AGENT_TOOLS) {
    registerAgentTool(server, tool, ctx)
  }

  return server
}
