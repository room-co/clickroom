#!/usr/bin/env node
// entrypoint — `npx clickroom-mcp`. Connects an `McpServer` exposing
// every `AGENT_TOOLS` entry to stdio, for headless/CI MCP clients (Claude
// Desktop's remote `/mcp` + OAuth connector is the primary surface; this is
// the local/headless alternative architecture diagram).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadEnv } from './env.js'
import { createMcpServer } from './server.js'

async function main(): Promise<void> {
  const env = loadEnv()
  const server = createMcpServer(
    env.CLICKROOM_TOKEN,
    env.CLICKROOM_API_URL,
    env.CLICKROOM_API_TIMEOUT_MS,
  )
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('[clickroom-mcp] fatal error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
