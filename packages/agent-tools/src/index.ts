// @clickroom/agent-tools — shared MCP tool registry. Zero business
// logic: every tool's handle() calls a tRPC procedure via ctx.client. Consumed
// by apps/mcp (stdio bridge) and apps/api/src/mcp (remote HTTP endpoint).
export const PACKAGE_NAME = '@clickroom/agent-tools'

export { AGENT_TOOLS, getMutatingTools, getReadTools } from './registry.js'
export { jsonResult, textResult } from './result.js'
export type { AgentTool, AgentToolContext, AgentToolResult, AgentToolTextContent } from './types.js'
