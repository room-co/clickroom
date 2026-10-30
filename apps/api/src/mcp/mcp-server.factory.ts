// Builds a fresh `McpServer` + Streamable HTTP transport PER
// REQUEST for the remote `/mcp` endpoint, registering every `AGENT_TOOLS`
// entry exactly like the stdio bridge (`apps/mcp/src/server.ts`) does — same
// registry, two transports (see spec's architecture diagram) —
// but bound to a loopback tRPC client instead of a remote/public one.
import type { AgentTool, AgentToolContext } from '@clickroom/agent-tools'
import { AGENT_TOOLS } from '@clickroom/agent-tools'
import type { AppRouter } from '@clickroom/trpc-router'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { TRPCClient } from '@trpc/client'
import { withToolErrors } from './tool-errors.js'

const SERVER_NAME = 'clickroom-api-mcp'
const SERVER_VERSION = '0.0.0'

/** Registers one `AgentTool` on the server, wiring its result/error shape to `CallToolResult`. */
function registerAgentTool(server: McpServer, tool: AgentTool, ctx: AgentToolContext): void {
  const handle = withToolErrors(tool)
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.input,
    },
    async (input: unknown): Promise<CallToolResult> => {
      // `AgentToolResult` is a narrower, transport-agnostic shape than the
      // SDK's `CallToolResult` (which adds an index signature + optional
      // `_meta`/`structuredContent`) — both describe the same
      // `{content, isError?}` wire shape `AGENT_TOOLS` handlers actually
      // produce, so the cast is safe (mirrors `apps/mcp/src/server.ts`).
      return (await handle(input, ctx)) as CallToolResult
    },
  )
}

export interface McpHttpServer {
  server: McpServer
  transport: StreamableHTTPServerTransport
}

/**
 * Builds a fresh `McpServer` bound to `client` (the caller's loopback tRPC
 * client — see `../lib/loopback-client.ts`) plus a fresh stateless
 * `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`, per the
 * spec — no cross-request session state to manage since a new pair is built
 * per HTTP request). The controller connects them and tears both down when
 * the response closes.
 */
export function createMcpHttpServer(client: TRPCClient<AppRouter>): McpHttpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  const ctx: AgentToolContext = { client }

  for (const tool of AGENT_TOOLS) {
    registerAgentTool(server, tool, ctx)
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  return { server, transport }
}
