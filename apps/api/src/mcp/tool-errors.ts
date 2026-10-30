// error mapping for the remote HTTP `/mcp` endpoint. Mirrors
// `apps/mcp/src/errors.ts`, stdio bridge) — this package can't
// depend on `apps/mcp`, so the mapping logic is duplicated here rather than
// shared, per spec's note that a small amount of duplication
// between the two transports' error files is fine.
//
// The MCP SDK's `McpServer.registerTool()` catches anything a tool handler
// throws and folds it into a `CallToolResult` with `isError: true` — it does
// not surface a tool-level JSON-RPC error code over the wire, on the
// Streamable HTTP transport any more than it does on stdio (see
// `@modelcontextprotocol/sdk/server/mcp.js`). So instead of throwing, we
// translate the tRPC error into an `isError` result whose text is prefixed
// with the JSON-RPC code an MCP-aware client can still parse out.

import type { AgentTool, AgentToolContext, AgentToolResult } from '@clickroom/agent-tools'
import { TRPCClientError } from '@trpc/client'

/** JSON-RPC-style codes for tool-call failures, earlier mapping. */
export const TOOL_ERROR_CODES = {
  UNAUTHORIZED: -32001,
  FORBIDDEN: -32002,
  BAD_REQUEST: -32602, // InvalidParams
  DEFAULT: -32000,
} as const

function codeForTrpcErrorCode(trpcCode: string | undefined): number {
  switch (trpcCode) {
    case 'UNAUTHORIZED':
      return TOOL_ERROR_CODES.UNAUTHORIZED
    case 'FORBIDDEN':
      return TOOL_ERROR_CODES.FORBIDDEN
    case 'BAD_REQUEST':
      return TOOL_ERROR_CODES.BAD_REQUEST
    default:
      return TOOL_ERROR_CODES.DEFAULT
  }
}

/** Extracts the tRPC error code (`UNAUTHORIZED`, `FORBIDDEN`, ...) off a thrown error, if any. */
function trpcErrorCode(error: unknown): string | undefined {
  if (error instanceof TRPCClientError) {
    const data = error.data as { code?: string } | undefined
    return data?.code
  }
  return undefined
}

/**
 * Converts any error thrown by an `AgentTool.handle()` call (tRPC errors,
 * network aborts, anything else) into an `isError` MCP tool result. Never
 * throws itself — a tool call should always resolve, not reject, so a
 * misbehaving tool doesn't take down the whole HTTP request.
 */
export function toToolErrorResult(error: unknown): AgentToolResult {
  const trpcCode = trpcErrorCode(error)
  const jsonRpcCode = codeForTrpcErrorCode(trpcCode)
  const message = error instanceof Error ? error.message : String(error)
  return {
    content: [{ type: 'text', text: `[${jsonRpcCode}] ${trpcCode ?? 'ERROR'}: ${message}` }],
    isError: true,
  }
}

/**
 * Wraps one `AgentTool.handle()` call so a thrown tRPC error becomes an
 * `isError` result (see `toToolErrorResult`) instead of rejecting — the
 * shape `mcp-server.factory.ts` registers against `McpServer.registerTool()`.
 */
export function withToolErrors(
  tool: AgentTool,
): (input: unknown, ctx: AgentToolContext) => Promise<AgentToolResult> {
  return async (input, ctx) => {
    try {
      return await tool.handle(input, ctx)
    } catch (error) {
      return toToolErrorResult(error)
    }
  }
}
