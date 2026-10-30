// error mapping. Mirrors the JSON-RPC error-code intent described in
// Spec for `apps/api/src/mcp/tool-errors.ts`, but
// implemented standalone — this package must not depend on `apps/api`
// runtime code (: agent-tools/apps-mcp stay type-only against
// `@clickroom/trpc-router`).
//
// The MCP SDK's `McpServer.registerTool()` catches anything a tool handler
// throws and folds it into a `CallToolResult` with `isError: true` (see
// `@modelcontextprotocol/sdk/server/mcp.js`) — it does not surface a
// tool-level JSON-RPC error code to the client. So instead of throwing, we
// translate the tRPC error into an `isError` result whose text is prefixed
// with the JSON-RPC code an MCP-aware client can still parse out.

import type { AgentToolResult } from '@clickroom/agent-tools'
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
 * misbehaving tool doesn't take down the whole stdio session.
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
